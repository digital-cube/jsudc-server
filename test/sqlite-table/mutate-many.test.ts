// `mutate_many` on sqlite_table through the dispatcher — the scenarios of
// test/mutate-many.test.ts on SQLite (`:memory:` and a file, each driver installed): by
// ids, by filter, by filter with except_ids, update and delete, under two request
// contexts held to `tenant = ctx.tenant`; the patch checked before anything is written,
// and the cap on rows per request. Plus what is SQLite's own: upper-case uuids, integer
// ids, a table without a version column, the id column refused in the patch.
import {
  type FilterNode,
  type MutateManyResponse,
  type Row,
  requestKind,
  type SchemaDocInput,
  SchemaDocSchema,
  ViewConfigSchema,
} from "@jsudc/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDispatcher, type Dispatcher } from "../../src/dispatcher.js";
import { CollectionRegistry } from "../../src/registry.js";
import type { Source } from "../../src/sources/source.js";
import { type SqliteDatabase, SqliteTableSource } from "../../src/sqlite.js";
import { openWith, rejectsWith, SETUPS } from "./helpers.js";

const schema = SchemaDocSchema.parse({
  version: "v1",
  fields: {
    tenant: { type: "string" },
    subject: { type: "string", required: true },
    folder: { type: "string" },
    size: { type: "integer", min: 0 },
    archived: { type: "bool" },
    created_at: { type: "datetime" },
  },
} satisfies SchemaDocInput);

const view = ViewConfigSchema.parse({ columns: [{ field: "subject" }] });

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A = [uuid(1), uuid(2), uuid(3), uuid(4)] as const;
const B = [uuid(11), uuid(12)] as const;
const MISSING = uuid(99);

const ROWS = [
  { id: A[0], tenant: "a", subject: "one", folder: "inbox", size: 1 },
  { id: A[1], tenant: "a", subject: "two", folder: "inbox", size: 2 },
  { id: A[2], tenant: "a", subject: "three", folder: "inbox", size: 3 },
  { id: A[3], tenant: "a", subject: "four", folder: "sent", size: 4 },
  { id: B[0], tenant: "b", subject: "five", folder: "inbox", size: 5 },
  { id: B[1], tenant: "b", subject: "six", folder: "inbox", size: 6 },
];

const DDL = `
  CREATE TABLE mm_message (
    id TEXT PRIMARY KEY, tenant TEXT, subject TEXT NOT NULL, folder TEXT, size INTEGER,
    archived INTEGER NOT NULL DEFAULT 0, row_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
  ${ROWS.map(
    (r) =>
      `INSERT INTO mm_message (id, tenant, subject, folder, size) VALUES ` +
      `('${r.id}', '${r.tenant}', '${r.subject}', '${r.folder}', ${r.size});`,
  ).join("\n")}
`;

interface Ctx {
  tenant: string | null;
}

function rowScope(ctx: Ctx): FilterNode | undefined {
  return ctx.tenant === null ? undefined : { field: "tenant", op: "eq", value: ctx.tenant };
}

type Answer =
  | { ok: true; payload: MutateManyResponse }
  | { ok: false; payload: { code: string; message: string; details?: Record<string, unknown> } };

describe.each(SETUPS)("mutate_many on sqlite_table ($where, $driver)", ({ where, driver }) => {
  let db: SqliteDatabase;
  let source: Source;
  let dispatcher: Dispatcher;
  const log = { error: vi.fn() };

  function make(extra: Partial<ConstructorParameters<typeof SqliteTableSource>[0]> = {}) {
    return new SqliteTableSource({
      db,
      schema,
      table: "mm_message",
      versionColumn: "row_version",
      fields: { created_at: { readOnly: true } },
      ...extra,
    });
  }

  function build(limit?: number, s: Source = source): Dispatcher {
    const registry = new CollectionRegistry();
    registry.register({ name: "message", source: s, view });
    return createDispatcher<Ctx>(registry, {
      log,
      rowScope,
      ...(limit === undefined ? {} : { mutateManyLimit: limit }),
    });
  }

  beforeEach(async () => {
    db = await openWith(driver, where);
    await db.exec(DDL);
    source = make();
    dispatcher = build();
  });

  async function call(tenant: string | null, payload: object, d = dispatcher): Promise<Answer> {
    const res = await d.dispatch(
      { kind: requestKind("mutate_many"), id: "m", payload: { collection: "message", ...payload } },
      { tenant },
    );
    return res.kind === "udc.mutate_many.ok"
      ? { ok: true, payload: res.payload as MutateManyResponse }
      : { ok: false, payload: res.payload as Extract<Answer, { ok: false }>["payload"] };
  }

  async function ok(tenant: string | null, payload: object, d = dispatcher) {
    const res = await call(tenant, payload, d);
    expect(res.ok, JSON.stringify(res.payload)).toBe(true);
    return res.payload as MutateManyResponse;
  }

  async function err(tenant: string | null, payload: object, d = dispatcher) {
    const res = await call(tenant, payload, d);
    expect(res.ok, JSON.stringify(res.payload)).toBe(false);
    return res.payload as Extract<Answer, { ok: false }>["payload"];
  }

  /** Every row as it is now, by id, unscoped. */
  async function rows(): Promise<Map<string, Row>> {
    const res = await source.list({ page: { limit: 100 } });
    return new Map(res.rows.map((r) => [r.__meta.id, r]));
  }

  it("says capabilities.mutate_many in describe", async () => {
    const d = await dispatcher.dispatch(
      { kind: requestKind("describe"), id: "d", payload: { collection: "message" } },
      { tenant: "a" },
    );
    expect((d.payload as { capabilities: { mutate_many: boolean } }).capabilities.mutate_many).toBe(
      true,
    );
  });

  it("updates by ids, bumping each version; the rest untouched", async () => {
    const res = await ok("a", { op: "update", ids: [A[0], A[1]], row: { archived: true } });
    expect(res).toEqual({ updated: 2, failed: [] });
    const now = await rows();
    for (const id of [A[0], A[1]]) {
      expect(now.get(id)).toMatchObject({ archived: true, __meta: { version: 2 } });
    }
    for (const id of [A[2], A[3], B[0], B[1]]) {
      expect(now.get(id)).toMatchObject({ archived: false, __meta: { version: 1 } });
    }
  });

  it("deletes by ids", async () => {
    expect(await ok("a", { op: "delete", ids: [A[2], A[3]] })).toEqual({ updated: 2, failed: [] });
    const now = await rows();
    expect(now.has(A[2])).toBe(false);
    expect(now.has(A[3])).toBe(false);
    expect(now.size).toBe(4);
  });

  it("reports a missing id, a malformed one, and counts a repeated one once", async () => {
    const res = await ok("a", {
      op: "update",
      ids: [A[0], MISSING, A[0], "not-a-uuid"],
      row: { folder: "done" },
    });
    expect(res.updated).toBe(1);
    expect(res.failed.map((f) => [f.id, f.code])).toEqual([
      [MISSING, "not_found"],
      ["not-a-uuid", "not_found"],
    ]);
    expect((await rows()).get(A[0])?.__meta.version).toBe(2);
  });

  it("an upper-case uuid finds its row, and is not reported missing", async () => {
    const res = await ok("a", { op: "update", ids: [A[1].toUpperCase()], row: { size: 20 } });
    expect(res).toEqual({ updated: 1, failed: [] });
    expect((await rows()).get(A[1])?.size).toBe(20);
    const except = await ok("a", {
      op: "delete",
      filter: { field: "folder", op: "eq", value: "inbox" },
      except_ids: [A[0].toUpperCase()],
    });
    expect(except.updated).toBe(2);
    expect((await rows()).has(A[0])).toBe(true);
  });

  it("updates by filter, inside the scope only", async () => {
    const res = await ok("a", {
      op: "update",
      filter: { field: "folder", op: "eq", value: "inbox" },
      row: { folder: "archive" },
    });
    expect(res).toEqual({ updated: 3, failed: [] });
    const now = await rows();
    expect([A[0], A[1], A[2]].map((id) => now.get(id)?.folder)).toEqual([
      "archive",
      "archive",
      "archive",
    ]);
    expect(now.get(A[3])?.folder).toBe("sent");
    expect([B[0], B[1]].map((id) => now.get(id)?.folder)).toEqual(["inbox", "inbox"]);
  });

  it("updates by filter except some ids", async () => {
    const res = await ok("a", {
      op: "update",
      filter: { field: "folder", op: "eq", value: "inbox" },
      except_ids: [A[1], MISSING],
      row: { archived: true },
    });
    expect(res).toEqual({ updated: 2, failed: [] });
    const now = await rows();
    expect(now.get(A[0])?.archived).toBe(true);
    expect(now.get(A[1])?.archived).toBe(false);
    expect(now.get(A[2])?.archived).toBe(true);
  });

  it("deletes by filter except some ids; { and: [] } is every row in scope", async () => {
    const res = await ok("a", { op: "delete", filter: { and: [] }, except_ids: [A[3]] });
    expect(res).toEqual({ updated: 3, failed: [] });
    expect([...(await rows()).keys()].sort()).toEqual([A[3], B[0], B[1]].sort());
  });

  it("an empty match changes nothing", async () => {
    expect(
      await ok("a", { op: "delete", filter: { field: "folder", op: "eq", value: "spam" } }),
    ).toEqual({ updated: 0, failed: [] });
    expect(await ok("a", { op: "delete", ids: [] })).toEqual({ updated: 0, failed: [] });
    expect((await rows()).size).toBe(6);
  });

  describe("two contexts", () => {
    it("the other tenant's ids come back as not_found and are untouched", async () => {
      const res = await ok("b", { op: "update", ids: [B[0], A[0], A[1]], row: { size: 50 } });
      expect(res.updated).toBe(1);
      expect(res.failed).toEqual([
        { id: A[0], code: "not_found", message: expect.any(String) },
        { id: A[1], code: "not_found", message: expect.any(String) },
      ]);
      const now = await rows();
      expect(now.get(B[0])?.size).toBe(50);
      expect(now.get(A[0])).toMatchObject({ size: 1, __meta: { version: 1 } });
      expect(now.get(A[1])).toMatchObject({ size: 2, __meta: { version: 1 } });
    });

    it("a delete by the other tenant's ids deletes nothing of theirs", async () => {
      const res = await ok("b", { op: "delete", ids: [A[0], A[1]] });
      expect(res.updated).toBe(0);
      expect(res.failed.map((f) => f.id)).toEqual([A[0], A[1]]);
      expect((await rows()).size).toBe(6);
    });

    it("a filter touches only the caller's rows", async () => {
      const res = await ok("b", { op: "delete", filter: { field: "size", op: "gte", value: 0 } });
      expect(res).toEqual({ updated: 2, failed: [] });
      expect([...(await rows()).keys()].sort()).toEqual([...A].sort());
    });

    it("a patch naming the hidden scope field is refused; the row keeps its tenant", async () => {
      const res = await call("a", { op: "update", ids: [A[0]], row: { tenant: "b" } });
      expect(res.ok).toBe(false);
      expect((res.payload as { code: string }).code).toBe("validation_error");
      expect((await rows()).get(A[0])?.tenant).toBe("a");
    });

    it("refuses the hidden scope field in the filter", async () => {
      const e = await err("a", { op: "delete", filter: { field: "tenant", op: "eq", value: "b" } });
      expect(e.code).toBe("validation_error");
      expect((await rows()).size).toBe(6);
    });

    it("an unscoped context reaches every row", async () => {
      const res = await ok(null, {
        op: "update",
        filter: { field: "folder", op: "eq", value: "inbox" },
        row: { archived: true },
      });
      expect(res.updated).toBe(5);
    });
  });

  describe("the patch", () => {
    it("an invalid patch writes nothing", async () => {
      const e = await err("a", { op: "update", filter: { and: [] }, row: { size: -1 } });
      expect(e.code).toBe("validation_error");
      expect([...(await rows()).values()].every((r) => r.__meta.version === 1)).toBe(true);
    });

    it("an unknown field writes nothing", async () => {
      const e = await err("a", { op: "update", ids: [A[0], A[1]], row: { nope: 1 } });
      expect(e.code).toBe("validation_error");
      expect((await rows()).get(A[0])?.__meta.version).toBe(1);
    });

    it("a read-only field writes nothing", async () => {
      const e = await err("a", {
        op: "update",
        ids: [A[0]],
        row: { created_at: "2026-01-01T00:00:00Z", folder: "x" },
      });
      expect(e.code).toBe("validation_error");
      expect((await rows()).get(A[0])?.folder).toBe("inbox");
    });

    it("an update without a row, or both ids and filter, is a validation_error", async () => {
      expect((await err("a", { op: "update", ids: [A[0]] })).code).toBe("validation_error");
      expect((await err("a", { op: "delete", ids: [A[0]], filter: { and: [] } })).code).toBe(
        "validation_error",
      );
    });

    it("an unknown filter field writes nothing", async () => {
      const e = await err("a", { op: "delete", filter: { field: "nope", op: "eq", value: 1 } });
      expect(e.code).toBe("validation_error");
      expect((await rows()).size).toBe(6);
    });
  });

  describe("the cap", () => {
    it("refuses a filter reaching more rows, before anything is written", async () => {
      const e = await err(
        "a",
        { op: "update", filter: { field: "folder", op: "eq", value: "inbox" }, row: { size: 9 } },
        build(2),
      );
      expect(e.code).toBe("validation_error");
      expect(e.details).toMatchObject({ reason: "too_many_rows", limit: 2, by: "filter" });
      expect([...(await rows()).values()].every((r) => r.__meta.version === 1)).toBe(true);
    });

    it("counts after except_ids, and in scope only", async () => {
      const capped = build(2);
      const res = await ok(
        "a",
        {
          op: "update",
          filter: { field: "folder", op: "eq", value: "inbox" },
          except_ids: [A[2]],
          row: { size: 9 },
        },
        capped,
      );
      expect(res.updated).toBe(2);
      expect((await ok("b", { op: "delete", filter: { and: [] } }, capped)).updated).toBe(2);
    });

    it("refuses more ids than the cap", async () => {
      const e = await err("a", { op: "delete", ids: [A[0], A[1], A[2]] }, build(2));
      expect(e.details).toMatchObject({ reason: "too_many_rows", limit: 2, by: "ids" });
      expect((await rows()).size).toBe(6);
    });
  });

  it("works with total_count: false", async () => {
    const s = make({ totalCount: false });
    const capped = build(2, s);
    const refused = await err("a", { op: "delete", filter: { and: [] } }, capped);
    expect(refused.details).toMatchObject({ reason: "too_many_rows" });
    expect(
      await ok("a", { op: "delete", filter: { field: "folder", op: "eq", value: "sent" } }, capped),
    ).toEqual({ updated: 1, failed: [] });
  });

  it("is unsupported on a read-only source", async () => {
    const s = make({ readOnly: true });
    expect(s.capabilities.mutate_many).toBe(false);
    expect((await err("a", { op: "delete", ids: [A[0]] }, build(undefined, s))).code).toBe(
      "unsupported_op",
    );
    await rejectsWith(s.mutateMany({ op: "delete", ids: [A[0]], limit: 10 }), "unsupported_op");
  });

  it("refuses a patch writing the id column", async () => {
    const s = make({ fields: { created_at: { readOnly: true }, subject: "id" } });
    await rejectsWith(
      s.mutateMany({ op: "update", ids: [A[0]], row: { subject: uuid(50) }, limit: 10 }),
      "validation_error",
    );
    expect((await rows()).has(A[0])).toBe(true);
  });

  it("a table without a version column and with integer ids", async () => {
    await db.exec(`
      CREATE TABLE mm_plain (id INTEGER PRIMARY KEY, name TEXT NOT NULL, n INTEGER);
      INSERT INTO mm_plain (name, n) VALUES ('x', 1), ('y', 2), ('z', 3);`);
    const plain = new SqliteTableSource({
      db,
      schema: SchemaDocSchema.parse({
        version: "v1",
        fields: { name: { type: "string", required: true }, n: { type: "integer" } },
      } satisfies SchemaDocInput),
      table: "mm_plain",
      idType: "integer",
    });
    const res = await plain.mutateMany({
      op: "update",
      ids: ["1", "3", "7", "abc"],
      row: { n: 10 },
      limit: 10,
    });
    expect(res.updated).toBe(2);
    expect(res.failed.map((f) => f.id)).toEqual(["7", "abc"]);
    const now = await plain.list({ sort: [{ field: "name" }] });
    expect(now.rows.map((r) => [r.name, r.n, r.__meta.version])).toEqual([
      ["x", 10, 1],
      ["y", 2, 1],
      ["z", 10, 1],
    ]);
    expect(
      await plain.mutateMany({
        op: "delete",
        filter: { field: "n", op: "eq", value: 10 },
        except_ids: ["3"],
        limit: 10,
      }),
    ).toEqual({ updated: 1, failed: [] });
    expect((await plain.list({})).rows.map((r) => r.name)).toEqual(["y", "z"]);
  });
});
