// PostgresTableSource.reindex — the cases of test/reindex.test.ts (postgres_jsonb, memory) and
// test/sqlite-table/reindex.test.ts on a relational Postgres table: one scope renumbered in its
// order, NULLs last, ties by id, every version bumped, the other scopes untouched; several scope
// fields, a gap, another order field; the allowlist; the order and scope fields must be writable
// columns of the write table; the row scope and the base `where` stay out; the rows renumbered
// are handed to `changedRows`; one transaction. What Postgres adds: a `from` with a join and a
// `writeTable`, and the rows locked before they are numbered, so a concurrent write to one of
// them is waited for and numbered as committed. Through the dispatcher the change feed names
// the renumbered rows.
import {
  type ChangeEvent,
  requestKind,
  type SchemaDocInput,
  SchemaDocSchema,
  type UdcMessage,
  ViewConfigSchema,
} from "@jsudc/core";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChangeNotice, createChangeFeed, MemoryChangeBus } from "../src/changes.js";
import { connect } from "../src/db/client.js";
import { createDispatcher } from "../src/dispatcher.js";
import {
  PostgresTableSource,
  type PostgresTableSourceOptions,
  type TableFieldSpec,
} from "../src/postgres.js";
import { CollectionRegistry } from "../src/registry.js";
import type { SourceContext } from "../src/sources/source.js";
import { rejectsWith, TEST_DATABASE_URL, useTestDb } from "./helpers.js";

const { db } = useTestDb();

const schema = SchemaDocSchema.parse({
  version: "v1",
  fields: {
    tenant: { type: "string" },
    title: { type: "string", required: true },
    bucket_id: { type: "string" },
    board_id: { type: "string" },
    board_name: { type: "string" },
    order: { type: "integer" },
    rank: { type: "decimal" },
    done: { type: "bool" },
    created_rank: { type: "integer" },
    title_length: { type: "integer" },
    gone: { type: "integer", deleted: true },
  },
} satisfies SchemaDocInput);

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// Bucket a: orders that collide (100, 101), a NULL and a tie; bucket b: untouched. The ids
// run in title order, so a tie on the order falls back to it.
const ROWS = [
  { id: uuid(1), title: "a1", bucket_id: "a", board_id: "x", order: 101, done: false },
  { id: uuid(2), title: "a2", bucket_id: "a", board_id: "x", order: 100, done: false },
  { id: uuid(3), title: "a3", bucket_id: "a", board_id: "x", order: null, done: true },
  { id: uuid(4), title: "a4", bucket_id: "a", board_id: "x", order: -50, done: false },
  { id: uuid(5), title: "b1", bucket_id: "b", board_id: "x", order: 7, done: false },
  { id: uuid(6), title: "b2", bucket_id: "b", board_id: "x", order: 3, done: false },
];

/** Over the table: a base `where`, a read-only column, a computed field. */
const make = (extra: Partial<PostgresTableSourceOptions> = {}) =>
  new PostgresTableSource({
    db,
    schema,
    table: "ptr_task",
    versionColumn: "row_version",
    where: "hidden = false",
    fields: {
      board_name: { sql: "(SELECT b.name FROM ptr_board b WHERE b.id = ptr_task.board_id)" },
      created_rank: { readOnly: true },
      title_length: { sql: "length(title)" },
    },
    ...extra,
  });

/**
 * Over a `FROM` with a join whose other table has an `order` column of its own (the board's
 * position): every bare `order` would be ambiguous there.
 */
const joined = (extra: Partial<PostgresTableSourceOptions> = {}) =>
  new PostgresTableSource({
    db,
    schema,
    from: "ptr_task t LEFT JOIN ptr_board b ON b.id = t.board_id",
    writeTable: "ptr_task",
    writeAlias: "t",
    idColumn: "t.id",
    versionColumn: "t.row_version",
    where: "t.hidden = false",
    fields: joinedFields(),
    ...extra,
  });

async function insert(row: Record<string, unknown>) {
  const cols = Object.keys(row);
  await db.execute(sql`
    INSERT INTO ptr_task (${sql.join(
      cols.map((c) => sql.identifier(c)),
      sql`, `,
    )})
    VALUES (${sql.join(
      cols.map((c) => sql`${row[c]}`),
      sql`, `,
    )})`);
}

const raw = async (id: string) =>
  (
    await db.execute<{ order: number | null; row_version: number }>(
      sql`SELECT "order", row_version FROM ptr_task WHERE id = ${id}::uuid`,
    )
  ).rows[0];

async function state(src: PostgresTableSource, sctx?: SourceContext) {
  const { rows } = await src.list({ sort: [{ field: "title" }], page: { limit: 100 } }, sctx);
  return Object.fromEntries(
    rows.map((r) => [r.title, { order: r.order, version: r.__meta.version }]),
  );
}

beforeAll(async () => {
  await db.execute(sql`DROP TABLE IF EXISTS ptr_task, ptr_board, ptr_plain`);
  await db.execute(sql`
    CREATE TABLE ptr_board (id text PRIMARY KEY, name text NOT NULL, "order" integer)`);
  await db.execute(sql`
    CREATE TABLE ptr_task (
      id uuid PRIMARY KEY,
      tenant text NOT NULL DEFAULT 't1',
      title text NOT NULL,
      bucket_id text,
      board_id text REFERENCES ptr_board(id),
      "order" integer,
      rank numeric,
      done boolean NOT NULL DEFAULT false,
      created_rank integer,
      hidden boolean NOT NULL DEFAULT false,
      row_version integer NOT NULL DEFAULT 1)`);
  await db.execute(sql`
    CREATE TABLE ptr_plain (id bigserial PRIMARY KEY, title text NOT NULL, bucket_id text, "order" integer)`);
});

afterAll(async () => {
  await db.execute(sql`DROP TABLE IF EXISTS ptr_task, ptr_board, ptr_plain`);
  await db.execute(sql`DROP FUNCTION IF EXISTS ptr_refuse()`);
});

beforeEach(async () => {
  await db.execute(sql`DROP TRIGGER IF EXISTS ptr_refuse ON ptr_task`);
  await db.execute(sql`TRUNCATE ptr_task, ptr_board, ptr_plain RESTART IDENTITY`);
  await db.execute(sql`INSERT INTO ptr_board VALUES ('x', 'Board X', 1), ('y', 'Board Y', 2)`);
  for (const row of ROWS) await insert(row);
});

describe.each([
  ["a table", make],
  ["a from with a join", joined],
])("postgres_table reindex over %s", (_, build) => {
  let source: PostgresTableSource;
  beforeEach(() => {
    source = build();
  });

  it("advertises the capability when it writes, not when it is read-only", async () => {
    expect(source.capabilities.reindex).toBe(true);
    const ro = build({ readOnly: true });
    expect(ro.capabilities.reindex).toBe(false);
    await rejectsWith(ro.reindex({ scope: { bucket_id: "a" } }), "unsupported_op");
  });

  it("renumbers one scope in order, NULLs last, and leaves the others alone", async () => {
    expect(await source.reindex({ scope: { bucket_id: "a" } })).toBe(4);
    expect(await state(source)).toEqual({
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
    const once = await state(source);
    expect([once.a4, once.a2, once.a5, once.a1, once.a3]).toEqual(
      [100, 200, 300, 400, 500].map((order) => ({ order, version: 2 })),
    );
    expect(await source.reindex({ scope: { bucket_id: "a" } })).toBe(5);
    const twice = await state(source);
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
    expect((await state(source)).a1).toEqual({ order: 101, version: 1 });
  });

  it.each([
    [{ scope: { nope: "a" } }],
    [{ scope: { gone: 1 } }],
    [{ scope: { "data->>'x'": "a" } }],
    [{ scope: { '"order"': 1 } }],
    [{ scope: { bucket_id: "a" }, order_field: "missing" }],
    [{ scope: { bucket_id: "a" }, order_field: "title" }],
    [{ scope: { order: "not a number" } }],
    // Not writable columns of the write table: a read-only column, a computed field, a column
    // of the joined table (a correlated subquery over the table).
    [{ scope: { bucket_id: "a" }, order_field: "created_rank" }],
    [{ scope: { bucket_id: "a" }, order_field: "title_length" }],
    [{ scope: { created_rank: 1 } }],
    [{ scope: { title_length: 2 } }],
    [{ scope: { board_name: "Board X" } }],
  ])("refuses %j", async (req) => {
    await rejectsWith(source.reindex(req), "validation_error");
    expect((await state(source)).a1).toEqual({ order: 101, version: 1 });
  });

  it("leaves the rows outside the row scope and outside the base where alone", async () => {
    // Same bucket, another tenant; and one hidden by the source's `where`.
    await insert({ id: uuid(8), tenant: "t2", title: "a6", bucket_id: "a", order: 1 });
    await insert({ id: uuid(9), title: "a7", bucket_id: "a", order: 2, hidden: true });
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
    const notT1: SourceContext = { ...t1, rowScope: { field: "tenant", op: "neq", value: "t1" } };
    expect(await source.reindex({ scope: { bucket_id: "a" } }, notT1)).toBe(1);
    expect(await raw(uuid(8))).toEqual({ order: 100, row_version: 2 });
    expect(await raw(uuid(4))).toEqual({ order: 100, row_version: 2 });
    // A row scope over a field that is not a writable column (the joined board's name).
    const boardY: SourceContext = {
      ...t1,
      rowScope: { field: "board_name", op: "eq", value: "Board Y" },
    };
    expect(await source.reindex({ scope: { bucket_id: "a" } }, boardY)).toBe(0);
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
      r.board_name,
    ];
    expect(seen.slice(0, 2).map(pick)).toEqual(
      expect.arrayContaining([
        [uuid(5), 7, 1, "b", "Board X"],
        [uuid(6), 3, 1, "b", "Board X"],
      ]),
    );
    expect(seen.slice(2).map(pick)).toEqual(
      expect.arrayContaining([
        [uuid(6), 100, 2, "b", "Board X"],
        [uuid(5), 200, 2, "b", "Board X"],
      ]),
    );
    // Nothing renumbered, nothing handed over.
    seen.length = 0;
    expect(await source.reindex({ scope: { bucket_id: "nope" } }, sctx)).toBe(0);
    expect(seen).toEqual([]);
  });

  it("puts every statement in one transaction: a refusal midway writes nothing", async () => {
    // A trigger that refuses the third row renumbered: the first two roll back with it.
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION ptr_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."order" = 300 THEN RAISE EXCEPTION 'no 300'; END IF;
        RETURN NEW;
      END $$`);
    await db.execute(sql`
      CREATE TRIGGER ptr_refuse BEFORE UPDATE OF "order" ON ptr_task
      FOR EACH ROW EXECUTE FUNCTION ptr_refuse()`);
    await expect(source.reindex({ scope: { bucket_id: "a" } })).rejects.toThrow();
    expect(await state(source)).toMatchObject({
      a1: { order: 101, version: 1 },
      a2: { order: 100, version: 1 },
      a4: { order: -50, version: 1 },
    });
  });

  it("locks the rows first: a concurrent write to one is waited for and numbered as committed", async () => {
    const other = connect(TEST_DATABASE_URL);
    const client = await other.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT 1 FROM ptr_task WHERE id = $1 FOR UPDATE", [uuid(4)]);
      // a4 (-50, first) moves to the end of the numbered rows, before the NULL.
      await client.query(`UPDATE ptr_task SET "order" = 1000 WHERE id = $1`, [uuid(4)]);
      let settled = false;
      const running = source.reindex({ scope: { bucket_id: "a" } }).finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);
      await client.query("COMMIT");
      expect(await running).toBe(4);
    } finally {
      client.release();
      await other.close();
    }
    expect(await state(source)).toMatchObject({
      a2: { order: 100, version: 2 },
      a1: { order: 200, version: 2 },
      a4: { order: 300, version: 2 },
      a3: { order: 400, version: 2 },
    });
  });
});

describe("postgres_table reindex, the column checks", () => {
  it("refuses an order_field mapped to the id column", async () => {
    const plain = new PostgresTableSource({
      db,
      schema: SchemaDocSchema.parse({
        version: "v1",
        fields: {
          title: { type: "string" },
          bucket_id: { type: "string" },
          seq: { type: "integer" },
        },
      } satisfies SchemaDocInput),
      table: "ptr_plain",
      idType: "integer",
      fields: { seq: "id" },
    });
    const err = await rejectsWith(
      plain.reindex({ scope: { bucket_id: "a" }, order_field: "seq" }),
      "validation_error",
    );
    expect(err.details).toEqual({ field: "seq" });
  });

  it("refuses a field the source maps to the id column under its qualified name", async () => {
    const src = joined({ fields: { ...joinedFields(), rank: "t.id" } });
    await rejectsWith(
      src.reindex({ scope: { bucket_id: "a" }, order_field: "rank" }),
      "validation_error",
    );
  });

  it("without a version column: renumbers, every row stays version 1", async () => {
    await db.execute(sql`INSERT INTO ptr_plain (title, bucket_id, "order") VALUES
      ('p1', 'a', 5), ('p2', 'a', 5), ('p3', 'a', NULL), ('p4', 'b', 1)`);
    const plain = new PostgresTableSource({
      db,
      schema: SchemaDocSchema.parse({
        version: "v1",
        fields: {
          title: { type: "string" },
          bucket_id: { type: "string" },
          order: { type: "integer" },
        },
      } satisfies SchemaDocInput),
      table: "ptr_plain",
      idType: "integer",
    });
    expect(plain.capabilities.reindex).toBe(true);
    expect(await plain.reindex({ scope: { bucket_id: "a" }, gap: 2 })).toBe(3);
    const { rows } = await plain.list({ sort: [{ field: "title" }] });
    expect(rows.map((r) => [r.title, r.order, r.__meta.version])).toEqual([
      ["p1", 2, 1],
      ["p2", 4, 1],
      ["p3", 6, 1],
      ["p4", 1, 1],
    ]);
  });
});

/** The `fields` of `joined()`, for a variant that changes one. */
function joinedFields(): Record<string, string | TableFieldSpec> {
  return {
    tenant: "t.tenant",
    title: "t.title",
    bucket_id: "t.bucket_id",
    board_id: "t.board_id",
    board_name: "b.name",
    order: "t.order",
    rank: "t.rank",
    done: "t.done",
    created_rank: { column: "t.created_rank", readOnly: true },
    title_length: { sql: "length(t.title)" },
  };
}

describe("postgres_table reindex through the dispatcher, with a change feed", () => {
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
    registry.register({ name: "task", source: make(), view });
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
    expect((await state(make())).a1).toEqual({ order: 101, version: 1 });
  });
});
