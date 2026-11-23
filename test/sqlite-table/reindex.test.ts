// SqliteTableSource.reindex — the cases of test/reindex.test.ts (postgres_jsonb, memory) on a
// `sqlite_table`, on `:memory:` and on a file: one scope renumbered in its order, NULLs last,
// ties by id, every version bumped, the other scopes untouched; several scope fields, a gap,
// another order field; the allowlist. Plus what a relational source adds: the order and scope
// fields must be writable columns, the row scope and the base `where` stay out, the rows
// renumbered are handed to `changedRows`, and through the dispatcher the change feed names them.
import {
  type ChangeEvent,
  requestKind,
  type SchemaDocInput,
  SchemaDocSchema,
  type UdcMessage,
  ViewConfigSchema,
} from "@jsudc/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ChangeNotice, createChangeFeed, MemoryChangeBus } from "../../src/changes.js";
import { createDispatcher } from "../../src/dispatcher.js";
import { CollectionRegistry } from "../../src/registry.js";
import type { SourceContext } from "../../src/sources/source.js";
import {
  type SqliteDatabase,
  SqliteTableSource,
  type SqliteTableSourceOptions,
} from "../../src/sqlite.js";
import { openDb, rejectsWith, WHERES } from "./helpers.js";

const schema = SchemaDocSchema.parse({
  version: "v1",
  fields: {
    tenant: { type: "string" },
    title: { type: "string", required: true },
    bucket_id: { type: "string" },
    board_id: { type: "string" },
    order: { type: "integer" },
    rank: { type: "decimal" },
    done: { type: "bool" },
    created_rank: { type: "integer" },
    title_length: { type: "integer" },
    gone: { type: "integer", deleted: true },
  },
} satisfies SchemaDocInput);

const DDL = `
  CREATE TABLE rx_task (
    id TEXT PRIMARY KEY,
    tenant TEXT NOT NULL DEFAULT 't1',
    title TEXT NOT NULL,
    bucket_id TEXT,
    board_id TEXT,
    "order" INTEGER,
    rank NUMERIC,
    done INTEGER NOT NULL DEFAULT 0,
    created_rank INTEGER,
    hidden INTEGER NOT NULL DEFAULT 0,
    row_version INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE rx_plain (id INTEGER PRIMARY KEY, title TEXT NOT NULL, bucket_id TEXT, "order" INTEGER);
`;

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// Bucket a: orders that collide (100, 101), a NULL and a tie; bucket b: untouched. The ids
// run in title order, so a tie on the order falls back to it.
const ROWS = [
  { id: uuid(1), title: "a1", bucket_id: "a", board_id: "x", order: 101, done: 0 },
  { id: uuid(2), title: "a2", bucket_id: "a", board_id: "x", order: 100, done: 0 },
  { id: uuid(3), title: "a3", bucket_id: "a", board_id: "x", order: null, done: 1 },
  { id: uuid(4), title: "a4", bucket_id: "a", board_id: "x", order: -50, done: 0 },
  { id: uuid(5), title: "b1", bucket_id: "b", board_id: "x", order: 7, done: 0 },
  { id: uuid(6), title: "b2", bucket_id: "b", board_id: "x", order: 3, done: 0 },
];

describe.each(WHERES)("sqlite_table reindex on %s", (where) => {
  let db: SqliteDatabase;
  let source: SqliteTableSource;

  const make = (extra: Partial<SqliteTableSourceOptions> = {}) =>
    new SqliteTableSource({
      db,
      schema,
      table: "rx_task",
      versionColumn: "row_version",
      where: "hidden = 0",
      fields: {
        created_rank: { readOnly: true },
        title_length: { sql: "length(title)" },
      },
      ...extra,
    });

  async function insert(row: Record<string, unknown>) {
    const cols = Object.keys(row);
    await db.run({
      sql: `INSERT INTO rx_task (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols
        .map(() => "?")
        .join(", ")})`,
      params: cols.map((c) => row[c]),
    });
  }

  beforeEach(async () => {
    db = openDb(where);
    await db.exec(DDL);
    for (const row of ROWS) await insert(row);
    source = make();
  });

  async function state(src: SqliteTableSource = source, sctx?: SourceContext) {
    const { rows } = await src.list({ sort: [{ field: "title" }], page: { limit: 100 } }, sctx);
    return Object.fromEntries(
      rows.map((r) => [r.title, { order: r.order, version: r.__meta.version }]),
    );
  }

  const raw = (id: string) =>
    db.get<{ order: number | null; row_version: number }>({
      sql: `SELECT "order", row_version FROM rx_task WHERE id = ?`,
      params: [id],
    });

  it("advertises the capability when it writes, not when it is read-only", async () => {
    expect(source.capabilities.reindex).toBe(true);
    const ro = make({ readOnly: true });
    expect(ro.capabilities.reindex).toBe(false);
    await rejectsWith(ro.reindex({ scope: { bucket_id: "a" } }), "unsupported_op");
  });

  it("renumbers one scope in order, NULLs last, and leaves the others alone", async () => {
    expect(await source.reindex({ scope: { bucket_id: "a" } })).toBe(4);
    expect(await state()).toEqual({
      a4: { order: 100, version: 2 },
      a2: { order: 200, version: 2 },
      a1: { order: 300, version: 2 },
      a3: { order: 400, version: 2 },
      b1: { order: 7, version: 1 },
      b2: { order: 3, version: 1 },
    });
  });

  it("breaks a tie by id, and a second run keeps the order it wrote", async () => {
    await insert({ id: uuid(7), title: "a5", bucket_id: "a", order: 100 });
    expect(await source.reindex({ scope: { bucket_id: "a" } })).toBe(5);
    const once = await state();
    expect([once.a4, once.a2, once.a5, once.a1, once.a3]).toEqual(
      [100, 200, 300, 400, 500].map((order) => ({ order, version: 2 })),
    );
    expect(await source.reindex({ scope: { bucket_id: "a" } })).toBe(5);
    const twice = await state();
    for (const t of ["a1", "a2", "a3", "a4", "a5"]) {
      expect(twice[t]).toEqual({ order: once[t]?.order, version: 3 });
    }
  });

  it("takes several scope fields, a gap and another order field", async () => {
    await source.mutate({ op: "update", id: uuid(5), row: { rank: 2.5 } });
    await source.mutate({ op: "update", id: uuid(6), row: { rank: 1 } });
    const res = await source.reindex({
      scope: { board_id: "x", done: false, bucket_id: "b" },
      order_field: "rank",
      gap: 10,
    });
    expect(res).toBe(2);
    const { rows: b } = await source.list({
      filter: { field: "bucket_id", op: "eq", value: "b" },
      sort: [{ field: "rank" }],
    });
    expect(b.map((r) => [r.title, r.rank, r.order, r.__meta.version])).toEqual([
      ["b2", 10, 3, 3],
      ["b1", 20, 7, 3],
    ]);
  });

  it("answers 0 for an empty scope match and writes nothing", async () => {
    expect(await source.reindex({ scope: { bucket_id: "nope" } })).toBe(0);
    expect((await state()).a1).toEqual({ order: 101, version: 1 });
  });

  it.each([
    [{ scope: { nope: "a" } }],
    [{ scope: { gone: 1 } }],
    [{ scope: { "data->>'x'": "a" } }],
    [{ scope: { '"order"': 1 } }],
    [{ scope: { bucket_id: "a" }, order_field: "missing" }],
    [{ scope: { bucket_id: "a" }, order_field: "title" }],
    [{ scope: { order: "not a number" } }],
    // Not writable plain columns: a read-only column, a computed field.
    [{ scope: { bucket_id: "a" }, order_field: "created_rank" }],
    [{ scope: { bucket_id: "a" }, order_field: "title_length" }],
    [{ scope: { created_rank: 1 } }],
    [{ scope: { title_length: 2 } }],
  ])("refuses %j", async (req) => {
    await rejectsWith(source.reindex(req), "validation_error");
    expect((await state()).a1).toEqual({ order: 101, version: 1 });
  });

  it("refuses an order_field mapped to the id column", async () => {
    const plain = new SqliteTableSource({
      db,
      schema: SchemaDocSchema.parse({
        version: "v1",
        fields: {
          title: { type: "string" },
          bucket_id: { type: "string" },
          seq: { type: "integer" },
        },
      } satisfies SchemaDocInput),
      table: "rx_plain",
      idType: "integer",
      fields: { seq: "id" },
    });
    const err = await rejectsWith(
      plain.reindex({ scope: { bucket_id: "a" }, order_field: "seq" }),
      "validation_error",
    );
    expect(err.details).toEqual({ field: "seq" });
  });

  it("leaves the rows outside the row scope and outside the base where alone", async () => {
    // Same bucket, another tenant; and one hidden by the source's `where`.
    await insert({ id: uuid(8), tenant: "t2", title: "a6", bucket_id: "a", order: 1 });
    await insert({ id: uuid(9), title: "a7", bucket_id: "a", order: 2, hidden: 1 });
    const t1: SourceContext = {
      ctx: { tenant: "t1" },
      collection: "task",
      rowScope: { field: "tenant", op: "eq", value: "t1" },
    };
    expect(await source.reindex({ scope: { bucket_id: "a" } }, t1)).toBe(4);
    expect(await raw(uuid(8))).toEqual({ order: 1, row_version: 1 });
    expect(await raw(uuid(9))).toEqual({ order: 2, row_version: 1 });
    expect((await state(source, t1)).a4).toEqual({ order: 100, version: 2 });
    // A scope with more than eq conditions is ANDed in as well.
    const notT1: SourceContext = {
      ...t1,
      rowScope: { field: "tenant", op: "neq", value: "t1" },
    };
    expect(await source.reindex({ scope: { bucket_id: "a" } }, notT1)).toBe(1);
    expect(await raw(uuid(8))).toEqual({ order: 100, row_version: 2 });
    expect(await raw(uuid(4))).toEqual({ order: 100, row_version: 2 });
  });

  it("without a version column: renumbers, every row stays version 1", async () => {
    await db.exec(`INSERT INTO rx_plain (title, bucket_id, "order") VALUES
      ('p1', 'a', 5), ('p2', 'a', 5), ('p3', 'a', NULL), ('p4', 'b', 1)`);
    const plain = new SqliteTableSource({
      db,
      schema: SchemaDocSchema.parse({
        version: "v1",
        fields: {
          title: { type: "string" },
          bucket_id: { type: "string" },
          order: { type: "integer" },
        },
      } satisfies SchemaDocInput),
      table: "rx_plain",
      idType: "integer",
    });
    expect(await plain.reindex({ scope: { bucket_id: "a" }, gap: 2 })).toBe(3);
    const { rows } = await plain.list({ sort: [{ field: "title" }] });
    expect(rows.map((r) => [r.title, r.order, r.__meta.version])).toEqual([
      ["p1", 2, 1],
      ["p2", 4, 1],
      ["p3", 6, 1],
      ["p4", 1, 1],
    ]);
  });

  it("hands the rows over to changedRows, as they were and as they are", async () => {
    const seen: Record<string, unknown>[] = [];
    const sctx: SourceContext = {
      ctx: undefined,
      collection: "task",
      changedRows: (rows) => seen.push(...rows),
    };
    expect(await source.reindex({ scope: { bucket_id: "b" } }, sctx)).toBe(2);
    expect(seen).toHaveLength(4);
    const pick = (r: Record<string, unknown>) => [
      (r.__meta as { id: string }).id,
      r.order,
      (r.__meta as { version: number }).version,
      r.bucket_id,
    ];
    expect(seen.slice(0, 2).map(pick)).toEqual(
      expect.arrayContaining([
        [uuid(5), 7, 1, "b"],
        [uuid(6), 3, 1, "b"],
      ]),
    );
    expect(seen.slice(2).map(pick)).toEqual(
      expect.arrayContaining([
        [uuid(6), 100, 2, "b"],
        [uuid(5), 200, 2, "b"],
      ]),
    );
    // Nothing renumbered, nothing handed over.
    seen.length = 0;
    expect(await source.reindex({ scope: { bucket_id: "nope" } }, sctx)).toBe(0);
    expect(seen).toEqual([]);
  });

  it("puts every statement in one transaction: a refusal midway writes nothing", async () => {
    // A trigger that refuses the third row renumbered: the first two roll back with it.
    await db.exec(`
      CREATE TRIGGER rx_refuse BEFORE UPDATE OF "order" ON rx_task
      WHEN NEW."order" = 300 BEGIN SELECT RAISE(ABORT, 'no 300'); END;`);
    await expect(source.reindex({ scope: { bucket_id: "a" } })).rejects.toThrow(/no 300/);
    expect(await state()).toMatchObject({
      a1: { order: 101, version: 1 },
      a2: { order: 100, version: 1 },
      a4: { order: -50, version: 1 },
    });
  });

  describe("through the dispatcher, with a change feed", () => {
    type Ctx = { tenant: string };
    const view = ViewConfigSchema.parse({ columns: [{ field: "title" }] });

    class RecordingBus extends MemoryChangeBus {
      notices: ChangeNotice[] = [];
      override async publish(notice: ChangeNotice): Promise<void> {
        this.notices.push(notice);
        super.publish(notice);
      }
    }

    function build() {
      const registry = new CollectionRegistry();
      registry.register({ name: "task", source, view });
      const bus = new RecordingBus();
      const feed = createChangeFeed({ bus, coalesce: false });
      const rowScope = (ctx: Ctx) => ({ field: "tenant", op: "eq" as const, value: ctx.tenant });
      const dispatcher = createDispatcher<Ctx>(registry, {
        log: { error: vi.fn() },
        rowScope,
        changes: feed,
      });
      const toT1: ChangeEvent[] = [];
      const toT2: ChangeEvent[] = [];
      feed.subscribe({
        scopes: new Map([["task", rowScope({ tenant: "t1" })]]),
        send: (e) => toT1.push(e),
      });
      feed.subscribe({
        scopes: new Map([["task", rowScope({ tenant: "t2" })]]),
        send: (e) => toT2.push(e),
      });
      const run = (action: string, payload: object, tenant: string): Promise<UdcMessage> =>
        dispatcher.dispatch({ kind: requestKind(action), id: "t", payload }, { tenant });
      return { bus, toT1, toT2, run };
    }

    it("describe says reindex: true; one notice naming the renumbered rows, to their scope only", async () => {
      const { bus, toT1, toT2, run } = build();
      const described = await run("describe", { collection: "task" }, "t1");
      expect((described.payload as { capabilities: object }).capabilities).toMatchObject({
        reindex: true,
      });
      const res = await run("reindex", { collection: "task", scope: { bucket_id: "b" } }, "t1");
      expect(res.kind, JSON.stringify(res.payload)).toBe("udc.reindex.ok");
      expect(res.payload).toEqual({ updated: 2 });
      expect(bus.notices).toHaveLength(1);
      expect(bus.notices[0]).toMatchObject({ collection: "task", op: "update" });
      expect([...(bus.notices[0]?.ids ?? [])].sort()).toEqual([uuid(5), uuid(6)]);
      expect(toT1).toEqual([
        { collection: "task", op: "update", ids: expect.arrayContaining([uuid(5), uuid(6)]) },
      ]);
      expect(toT2).toEqual([]);
    });

    it("a refused or empty reindex notifies nothing", async () => {
      const { bus, run } = build();
      // `tenant` is the row scope's field, hidden from a scoped request.
      const refused = await run("reindex", { collection: "task", scope: { tenant: "t1" } }, "t1");
      expect(refused.kind).toBe("udc.reindex.err");
      const empty = await run("reindex", { collection: "task", scope: { bucket_id: "z" } }, "t1");
      expect(empty.payload).toEqual({ updated: 0 });
      // Another tenant's reindex reaches none of t1's rows.
      const other = await run("reindex", { collection: "task", scope: { bucket_id: "a" } }, "t2");
      expect(other.payload).toEqual({ updated: 0 });
      expect(bus.notices).toEqual([]);
      expect((await state()).a1).toEqual({ order: 101, version: 1 });
    });
  });
});
