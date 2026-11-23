// The `onMutate` hook on sqlite_table — the scenarios of test/on-mutate.test.ts on SQLite:
// what it sees, SQL it runs on the same transaction, what another connection sees while it
// runs, its failures (a UdcError as it is, anything else `internal`), a row it returns, and
// the database refusals before it. Plus what a single writer per file means: a hook that
// awaits holds every other writer — the second request waits, then succeeds, and never sees
// the first one's uncommitted rows; another process's writer is answered `busy`.
import {
  type Row,
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
import type { SourceContext } from "../../src/sources/source.js";
import {
  type SqliteDatabase,
  type SqliteOnMutateHook,
  SqliteTableSource,
} from "../../src/sqlite.js";
import { openWith, rejectsWith, SETUPS, tempFile } from "./helpers.js";

const schema = SchemaDocSchema.parse({
  version: "v1",
  fields: {
    name: { type: "string", required: true },
    city: { type: "string" },
    employees: { type: "integer", min: 0 },
  },
} satisfies SchemaDocInput);

const DDL = `
  CREATE TABLE om_company (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, city TEXT, employees INTEGER,
    row_version INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE om_log (id INTEGER PRIMARY KEY, op TEXT, row_id TEXT);
`;

const ID = "00000000-0000-4000-8000-000000000001";
const sctx: SourceContext = { ctx: { user: "u1" }, collection: "company" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A promise and the function that settles it. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe.each(SETUPS)("onMutate on sqlite_table ($where, $driver)", ({ where, driver }) => {
  let db: SqliteDatabase;
  /** For a file: a second `SqliteDatabase` on it, as another process would have. */
  let other: SqliteDatabase | undefined;
  let hook: SqliteOnMutateHook = () => undefined;
  let source: SqliteTableSource;

  beforeEach(async () => {
    const path = where === "file" ? tempFile() : "memory";
    db = await openWith(driver, path);
    await db.exec(DDL);
    await db.run({
      sql: "INSERT INTO om_company (id, name, city, employees) VALUES (?, 'Alfa', 'Niš', 3)",
      params: [ID],
    });
    other = where === "file" ? await openWith(driver, path, { busyTimeoutMs: 50 }) : undefined;
    hook = () => undefined;
    source = new SqliteTableSource({
      db,
      schema,
      table: "om_company",
      versionColumn: "row_version",
      onMutate: (ctx, change, tx) => hook(ctx, change, tx),
    });
  });

  const logged = () =>
    db.all<{ op: string; row_id: string }>("SELECT op, row_id FROM om_log ORDER BY id");
  const city = async (id = ID) =>
    (
      await db.get<{ city: string | null }>({
        sql: "SELECT city FROM om_company WHERE id = ?",
        params: [id],
      })
    )?.city;
  const count = async () =>
    (await db.get<{ n: number }>("SELECT count(*) AS n FROM om_company"))?.n;

  it("sees the context, the collection, before, after and the patch of each op", async () => {
    const seen: { ctx: unknown; change: RowChange }[] = [];
    hook = (ctx, change) => {
      seen.push({ ctx, change });
    };
    const original = await source.read(ID);
    const updated = await source.mutate(
      { op: "update", id: ID, row: { city: "Pirot" }, expected_version: 1 },
      sctx,
    );
    const inserted = await source.mutate(
      { op: "insert", row: { name: "Beta", __meta: { id: "x", version: 3 } } },
      sctx,
    );
    const deleted = await source.mutate({ op: "delete", id: inserted.__meta.id }, sctx);
    expect(deleted).toEqual(inserted);
    expect(seen).toEqual([
      {
        ctx: { user: "u1" },
        change: {
          op: "update",
          collection: "company",
          id: ID,
          before: original,
          after: updated,
          patch: { city: "Pirot" },
        },
      },
      {
        ctx: { user: "u1" },
        change: {
          op: "insert",
          collection: "company",
          id: inserted.__meta.id,
          before: null,
          after: inserted,
          patch: { name: "Beta" },
        },
      },
      {
        ctx: { user: "u1" },
        change: {
          op: "delete",
          collection: "company",
          id: inserted.__meta.id,
          before: inserted,
          after: null,
          patch: null,
        },
      },
    ]);
    expect(updated).toMatchObject({ city: "Pirot", __meta: { version: 2 } });
  });

  it("without a request context: ctx undefined, the collection is the table", async () => {
    let got: { ctx: unknown; collection: string } | undefined;
    hook = (ctx, change) => {
      got = { ctx, collection: change.collection };
    };
    await source.mutate({ op: "update", id: ID, row: { city: "Bor" } });
    expect(got).toEqual({ ctx: undefined, collection: "om_company" });
  });

  it("SQL it runs through tx commits with the row", async () => {
    hook = async (_ctx, change, tx) => {
      await sleep(1);
      tx.run({
        sql: "INSERT INTO om_log (op, row_id) VALUES (?, ?)",
        params: [change.op, change.id],
      });
    };
    await source.mutate({ op: "update", id: ID, row: { city: "Pirot" } });
    const ins = await source.mutate({ op: "insert", row: { name: "Gama" } });
    expect(await logged()).toEqual([
      { op: "update", row_id: ID },
      { op: "insert", row_id: ins.__meta.id },
    ]);
    expect(await city()).toBe("Pirot");
  });

  it("tx reads what the transaction wrote", async () => {
    let inside: unknown;
    hook = (_ctx, change, tx) => {
      inside = tx.get({ sql: "SELECT city FROM om_company WHERE id = ?", params: [change.id] });
    };
    await source.mutate({ op: "update", id: ID, row: { city: "Pirot" } });
    expect(inside).toEqual({ city: "Pirot" });
  });

  it.runIf(where === "file")(
    "while it runs, another connection does not see the change, and cannot write",
    async () => {
      const o = other as SqliteDatabase;
      const outside: unknown[] = [];
      hook = async (_ctx, change) => {
        if (change.op === "insert") {
          outside.push((await o.get<{ n: number }>("SELECT count(*) AS n FROM om_company"))?.n);
        } else {
          const row = await o.get<{ city: string }>({
            sql: "SELECT city FROM om_company WHERE id = ?",
            params: [change.id],
          });
          outside.push(row?.city);
        }
        if (change.op === "update") {
          // The file has one writer: another process's write waits, then is answered busy.
          outside.push(
            await o.run("UPDATE om_company SET city = 'elsewhere'").catch((e: UdcError) => e.code),
          );
        }
      };
      await source.mutate({ op: "update", id: ID, row: { city: "Pirot" } });
      await source.mutate({ op: "insert", row: { name: "Gama" } });
      await source.mutate({ op: "delete", id: ID });
      expect(outside).toEqual(["Niš", "busy", 1, "Pirot"]);
      expect(await count()).toBe(1);
    },
  );

  it("a UdcError it throws reaches the caller unchanged; the row and its SQL are rolled back", async () => {
    const refusal = new UdcError("forbidden", "the mail server refused the flag", {
      reason: "imap",
    });
    hook = async (_ctx, change, tx) => {
      tx.run({
        sql: "INSERT INTO om_log (op, row_id) VALUES (?, ?)",
        params: [change.op, change.id],
      });
      await sleep(1);
      throw refusal;
    };
    const before = await source.read(ID);
    for (const op of [
      { op: "update" as const, id: ID, row: { city: "Pirot" }, expected_version: 1 },
      { op: "delete" as const, id: ID },
      { op: "insert" as const, row: { name: "Gama" } },
    ]) {
      const err = await source.mutate(op, sctx).catch((e: unknown) => e);
      expect(err).toBe(refusal);
    }
    expect(await source.read(ID)).toEqual(before);
    expect(await count()).toBe(1);
    expect(await logged()).toEqual([]);
  });

  it("anything else it throws is answered as internal, logged, and nothing is written", async () => {
    hook = (_ctx, change, tx) => {
      tx.run({
        sql: "INSERT INTO om_log (op, row_id) VALUES (?, ?)",
        params: [change.op, change.id],
      });
      throw new Error("ECONNRESET talking to the mail server");
    };
    const registry = new CollectionRegistry();
    registry.register({ name: "company", source, view: ViewConfigSchema.parse({}) });
    const log = { error: vi.fn() };
    const dispatcher = createDispatcher(registry, { log });
    const res = await dispatcher.dispatch({
      kind: requestKind("mutate"),
      id: "7",
      payload: { collection: "company", op: "update", id: ID, row: { city: "Pirot" } },
    });
    expect(res).toEqual({
      kind: `${requestKind("mutate")}.err`,
      id: "7",
      payload: { code: "internal", message: "internal error" },
    });
    expect(log.error).toHaveBeenCalledOnce();
    expect(await city()).toBe("Niš");
    expect(await logged()).toEqual([]);
  });

  it("a row it returns is what mutate answers; the source does not write it", async () => {
    hook = (_ctx, change) =>
      change.after ? { ...change.after, city: "as the host sees it" } : undefined;
    const row = await source.mutate({ op: "update", id: ID, row: { employees: 9 } });
    expect(row).toMatchObject({ city: "as the host sees it", employees: 9 });
    expect(await city()).toBe("Niš");
    hook = () => ({ name: "bare" }) as unknown as Row;
    const bare = await source.mutate({ op: "update", id: ID, row: { employees: 10 } });
    expect(bare).toEqual({ name: "bare", __meta: { id: ID, version: 3 } });
  });

  it("a database refusal comes first: not_found, version_conflict and validation never reach it", async () => {
    const calls = vi.fn();
    hook = calls;
    await rejectsWith(
      source.mutate({ op: "update", id: ID, row: { city: "x" }, expected_version: 5 }),
      "version_conflict",
    );
    await rejectsWith(
      source.mutate({ op: "delete", id: "00000000-0000-4000-8000-000000000000" }),
      "not_found",
    );
    await rejectsWith(
      source.mutate({ op: "update", id: ID, row: { employees: -1 } }),
      "validation_error",
    );
    await rejectsWith(
      source.mutate(
        { op: "update", id: ID, row: { city: "x" } },
        { ctx: null, collection: "company", rowScope: { field: "city", op: "eq", value: "Bor" } },
      ),
      "not_found",
    );
    expect(calls).not.toHaveBeenCalled();
    expect(await source.read(ID)).toMatchObject({ city: "Niš", __meta: { version: 1 } });
  });

  describe("a hook that awaits while a second request writes", () => {
    it("the second waits for the first's COMMIT, then succeeds on the committed row", async () => {
      const events: string[] = [];
      const entered = gate();
      const release = gate();
      const seenBefore: (string | undefined)[] = [];
      hook = async (_ctx, change) => {
        const who = String(change.patch?.city);
        seenBefore.push(change.before?.city as string | undefined);
        events.push(`${who} hook`);
        if (who === "first") {
          entered.open();
          await release.promise;
          await sleep(20);
        }
        events.push(`${who} done`);
      };
      const first = source.mutate({ op: "update", id: ID, row: { city: "first" } });
      await entered.promise;
      // Started from outside the first one's transaction: it has to take its turn.
      const second = source.mutate({ op: "update", id: ID, row: { city: "second" } });
      // A read meanwhile: on a file it reads the read connection (committed rows, no wait).
      const during = where === "file" ? await source.read(ID) : undefined;
      await sleep(20);
      events.push("released");
      release.open();
      const [a, b] = await Promise.all([first, second]);
      expect(events).toEqual([
        "first hook",
        "released",
        "first done",
        "second hook",
        "second done",
      ]);
      expect(a).toMatchObject({ city: "first", __meta: { version: 2 } });
      expect(b).toMatchObject({ city: "second", __meta: { version: 3 } });
      expect(seenBefore).toEqual(["Niš", "first"]);
      if (during) expect(during).toMatchObject({ city: "Niš", __meta: { version: 1 } });
      expect(await city()).toBe("second");
    });

    it("when the first rolls back, the second never sees its uncommitted row", async () => {
      const entered = gate();
      const seen: { before: unknown; version: unknown }[] = [];
      hook = async (_ctx, change) => {
        if (change.patch?.city === "uncommitted") {
          entered.open();
          await sleep(30);
          throw new UdcError("forbidden", "changed my mind");
        }
        seen.push({ before: change.before?.city, version: change.before?.__meta.version });
      };
      const first = source.mutate({ op: "update", id: ID, row: { city: "uncommitted" } });
      await entered.promise;
      const second = source.mutate({ op: "update", id: ID, row: { employees: 4 } });
      const listed = source.list({});
      await rejectsWith(first, "forbidden");
      const row = await second;
      expect(seen).toEqual([{ before: "Niš", version: 1 }]);
      expect(row).toMatchObject({ city: "Niš", employees: 4, __meta: { version: 2 } });
      expect((await listed).rows.map((r) => r.city)).toEqual(["Niš"]);
    });

    it("a second writer that waits longer than busyTimeoutMs is answered busy, nothing written", async () => {
      const path = where === "file" ? tempFile() : "memory";
      const quick = await openWith(driver, path, { busyTimeoutMs: 30 });
      await quick.exec(DDL);
      await quick.run({
        sql: "INSERT INTO om_company (id, name) VALUES (?, 'Alfa')",
        params: [ID],
      });
      const entered = gate();
      const slow = new SqliteTableSource({
        db: quick,
        schema,
        table: "om_company",
        versionColumn: "row_version",
        onMutate: async () => {
          entered.open();
          await sleep(120);
        },
      });
      const first = slow.mutate({ op: "update", id: ID, row: { city: "slow" } });
      await entered.promise;
      const err = await rejectsWith(
        slow.mutate({ op: "update", id: ID, row: { city: "late" } }),
        "busy",
      );
      expect(err.details).toMatchObject({ database: "main" });
      expect(await first).toMatchObject({ city: "slow", __meta: { version: 2 } });
      expect(await quick.get("SELECT city FROM om_company")).toEqual({ city: "slow" });
    });
  });
});
