// `mutate_many` with the `onMutate` hook on sqlite_table — the scenarios of
// test/mutate-many-hook.test.ts on SQLite: row by row in one transaction, the hook called
// per row, a failure rolling everything back; and a patch that would take a row out of the
// row scope, refused as a whole with and without the hook.
import {
  type FilterNode,
  requestKind,
  type SchemaDocInput,
  SchemaDocSchema,
  UdcError,
  ViewConfigSchema,
} from "@jsudc/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDispatcher } from "../../src/dispatcher.js";
import type { RowChange } from "../../src/index.js";
import { CollectionRegistry } from "../../src/registry.js";
import {
  type SqliteDatabase,
  type SqliteOnMutateHook,
  SqliteTableSource,
} from "../../src/sqlite.js";
import { openWith, SETUPS } from "./helpers.js";

const schema = SchemaDocSchema.parse({
  version: "v1",
  fields: {
    tenant: { type: "string" },
    subject: { type: "string", required: true },
    size: { type: "integer" },
  },
} satisfies SchemaDocInput);
const view = ViewConfigSchema.parse({});

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const IDS = [uuid(1), uuid(2), uuid(3), uuid(4)] as const;
const ORIGINAL = Object.fromEntries(IDS.map((id, i) => [id, i + 1]));

const DDL = `
  CREATE TABLE mmh_message (
    id TEXT PRIMARY KEY, tenant TEXT, subject TEXT NOT NULL, size INTEGER,
    row_version INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE mmh_log (id INTEGER PRIMARY KEY, row_id TEXT);
  ${IDS.map((id, i) => `INSERT INTO mmh_message VALUES ('${id}', 'a', 's${i + 1}', ${i + 1}, 1);`).join("\n")}
`;

interface Ctx {
  tenant: string;
}

/** `tenant = a` and `size < 10`: a patch may take a row out of it. */
const rowScope = (ctx: Ctx): FilterNode => ({
  and: [
    { field: "tenant", op: "eq", value: ctx.tenant },
    { field: "size", op: "lt", value: 10 },
  ],
});

describe.each(SETUPS)(
  "mutate_many with onMutate on sqlite_table ($where, $driver)",
  ({ where, driver }) => {
    let db: SqliteDatabase;

    beforeEach(async () => {
      db = await openWith(driver, where);
      await db.exec(DDL);
    });

    const make = (onMutate?: SqliteOnMutateHook) =>
      new SqliteTableSource({
        db,
        schema,
        table: "mmh_message",
        versionColumn: "row_version",
        ...(onMutate ? { onMutate } : {}),
      });

    /** Committed `size` per id (`undefined`: no row). */
    async function sizes(): Promise<Record<string, number | undefined>> {
      const rows = await db.all<{ id: string; size: number }>("SELECT id, size FROM mmh_message");
      return Object.fromEntries(IDS.map((id) => [id, rows.find((r) => r.id === id)?.size]));
    }

    const logged = async () =>
      (await db.all<{ row_id: string }>("SELECT row_id FROM mmh_log ORDER BY id")).map(
        (r) => r.row_id,
      );

    async function send(source: SqliteTableSource, payload: object, log = { error: vi.fn() }) {
      const registry = new CollectionRegistry();
      registry.register({ name: "message", source, view });
      // The scope's fields stay visible, so a patch may name `size`.
      const dispatcher = createDispatcher<Ctx>(registry, {
        log,
        rowScope,
        showScopeFields: ["message"],
      });
      return dispatcher.dispatch(
        {
          kind: requestKind("mutate_many"),
          id: "m",
          payload: { collection: "message", ...payload },
        },
        { tenant: "a" },
      );
    }

    it("calls the hook once per row with the context, before, after and the patch", async () => {
      const seen: { ctx: unknown; change: RowChange }[] = [];
      const source = make(async (ctx, change, tx) => {
        seen.push({ ctx, change });
        tx.run({ sql: "INSERT INTO mmh_log (row_id) VALUES (?)", params: [change.id] });
      });
      const res = await send(source, {
        op: "update",
        ids: [IDS[1], IDS[0], uuid(99)],
        row: { size: 7 },
      });
      expect(res.payload).toEqual({
        updated: 2,
        failed: [{ id: uuid(99), code: "not_found", message: expect.any(String) }],
      });
      // Rows in id order.
      expect(seen.map((s) => s.change.id)).toEqual([IDS[0], IDS[1]]);
      expect(seen[0]).toEqual({
        ctx: { tenant: "a" },
        change: {
          op: "update",
          collection: "message",
          id: IDS[0],
          before: expect.objectContaining({ size: 1, __meta: { id: IDS[0], version: 1 } }),
          after: expect.objectContaining({ size: 7, __meta: { id: IDS[0], version: 2 } }),
          patch: { size: 7 },
        },
      });
      expect(await logged()).toEqual([IDS[0], IDS[1]]);
      expect(await sizes()).toMatchObject({ [IDS[0]]: 7, [IDS[1]]: 7, [IDS[2]]: 3 });
    });

    it("calls the hook on a delete by filter with before and no after", async () => {
      const seen: RowChange[] = [];
      const source = make((_ctx, change) => {
        seen.push(change);
      });
      const res = await send(source, {
        op: "delete",
        filter: { field: "size", op: "gte", value: 3 },
      });
      expect(res.payload).toEqual({ updated: 2, failed: [] });
      expect(seen.map((c) => [c.op, c.id, c.after, c.patch])).toEqual([
        ["delete", IDS[2], null, null],
        ["delete", IDS[3], null, null],
      ]);
      expect(seen[0]?.before).toMatchObject({ size: 3 });
      expect(await sizes()).toEqual({ ...ORIGINAL, [IDS[2]]: undefined, [IDS[3]]: undefined });
    });

    it("a hook throwing on the third row leaves the first two unchanged", async () => {
      let calls = 0;
      const source = make(async (_ctx, change, tx) => {
        calls += 1;
        tx.run({ sql: "INSERT INTO mmh_log (row_id) VALUES (?)", params: [change.id] });
        // An await between the statements and the throw: still inside the transaction.
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (calls === 3) {
          throw new UdcError("forbidden", "row 3 is locked by policy", { id: change.id });
        }
      });
      const res = await send(source, { op: "update", filter: { and: [] }, row: { size: 8 } });
      expect(res.kind).toBe("udc.mutate_many.err");
      expect(res.payload).toEqual({
        code: "forbidden",
        message: "row 3 is locked by policy",
        details: { id: IDS[2] },
      });
      expect(calls).toBe(3);
      expect(await sizes()).toEqual(ORIGINAL);
      expect(await logged()).toEqual([]);
      for (const id of IDS) expect((await source.read(id)).__meta.version).toBe(1);
    });

    it("a hook throwing anything else is internal, logged, and rolls back a delete", async () => {
      const log = { error: vi.fn() };
      let calls = 0;
      const source = make(() => {
        calls += 1;
        if (calls === 2) throw new Error("db password=hunter2");
      });
      const res = await send(source, { op: "delete", ids: [...IDS] }, log);
      expect(res.payload).toEqual({ code: "internal", message: "internal error" });
      expect(log.error).toHaveBeenCalledOnce();
      expect(await sizes()).toEqual(ORIGINAL);
    });

    it("SQL the hook runs through the database object (not tx) is in the transaction too", async () => {
      const source = make(async (_ctx, change) => {
        await db.run({ sql: "INSERT INTO mmh_log (row_id) VALUES (?)", params: [change.id] });
        if (change.id === IDS[1]) throw new UdcError("forbidden", "no");
      });
      await send(source, { op: "update", ids: [IDS[0], IDS[1]], row: { size: 5 } });
      expect(await logged()).toEqual([]);
      expect(await sizes()).toEqual(ORIGINAL);
    });

    describe.each([
      { hook: false, label: "without the hook" },
      { hook: true, label: "with the hook" },
    ])("a patch leaving the row scope, $label", ({ hook }) => {
      it("is refused as a whole: forbidden, nothing written", async () => {
        const seen: string[] = [];
        const source = make(hook ? (_ctx, change) => void seen.push(change.id) : undefined);
        const res = await send(source, { op: "update", ids: [IDS[0], IDS[1]], row: { size: 50 } });
        expect(res.payload).toMatchObject({
          code: "forbidden",
          details: { reason: "out_of_scope" },
        });
        expect(await sizes()).toEqual(ORIGINAL);
        // The hook never sees the refused row.
        expect(seen).toEqual([]);
      });

      it("by filter too", async () => {
        const source = make(hook ? () => undefined : undefined);
        const res = await send(source, { op: "update", filter: { and: [] }, row: { size: 10 } });
        expect(res.payload).toMatchObject({ code: "forbidden" });
        expect(await sizes()).toEqual(ORIGINAL);
      });
    });

    it("changedRows: before and after with the hook, before alone on a delete", async () => {
      const source = make(() => undefined);
      const seen: unknown[][] = [];
      const sctx = {
        ctx: { tenant: "a" },
        collection: "message",
        rowScope: rowScope({ tenant: "a" }),
        changedRows: (rows: unknown[]) => seen.push(rows),
      };
      await source.mutateMany({ op: "update", ids: [IDS[0]], row: { size: 2 }, limit: 10 }, sctx);
      await source.mutateMany({ op: "delete", ids: [IDS[3]], limit: 10 }, sctx);
      expect(seen).toEqual([
        [
          expect.objectContaining({ size: 1, __meta: { id: IDS[0], version: 1 } }),
          expect.objectContaining({ size: 2, __meta: { id: IDS[0], version: 2 } }),
        ],
        [expect.objectContaining({ size: 4, __meta: { id: IDS[3], version: 1 } })],
      ]);
    });

    it("changedRows without the hook: the same, by one statement", async () => {
      const source = make();
      const seen: unknown[][] = [];
      const sctx = {
        ctx: null,
        collection: "message",
        changedRows: (rows: unknown[]) => seen.push(rows),
      };
      await source.mutateMany(
        {
          op: "update",
          filter: { field: "size", op: "lte", value: 2 },
          row: { subject: "x" },
          limit: 10,
        },
        sctx,
      );
      expect(seen).toHaveLength(1);
      expect(seen[0]).toHaveLength(4);
      expect(seen[0]?.map((r) => (r as { subject: string }).subject)).toEqual([
        "s1",
        "s2",
        "x",
        "x",
      ]);
      // Nothing matched: nothing handed over.
      await source.mutateMany({ op: "delete", ids: [uuid(98)], limit: 10 }, sctx);
      expect(seen).toHaveLength(1);
    });
  },
);
