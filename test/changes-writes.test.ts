// jsudc's own writes notify the change feed by themselves: `mutate_many`, `reindex` and
// `tree.reparent` publish exactly one notice, after the commit (another connection already
// sees the change when it is published), and none when the request failed.
import {
  type ChangeEvent,
  type FilterNode,
  requestKind,
  type SchemaDocInput,
  SchemaDocSchema,
  UdcError,
  type UdcMessage,
  ViewConfigSchema,
} from "@jsudc/core";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChangeNotice, createChangeFeed, MemoryChangeBus } from "../src/changes.js";
import { createCollectionTableSql } from "../src/db/schema.js";
import { createDispatcher, type Dispatcher } from "../src/dispatcher.js";
import { CollectionRegistry } from "../src/registry.js";
import { MemorySource } from "../src/sources/memory.js";
import { PostgresJsonbSource } from "../src/sources/postgres-jsonb.js";
import { PostgresTableSource } from "../src/sources/postgres-table.js";
import type {
  MutateManyResult,
  Source,
  SourceContext,
  SourceMutateMany,
} from "../src/sources/source.js";
import { TEST_DATABASE_URL, useTestDb } from "./helpers.js";

const schema = SchemaDocSchema.parse({
  version: "v1",
  fields: {
    tenant: { type: "string" },
    subject: { type: "string", required: true },
    order: { type: "integer" },
    parent_id: { type: "string" },
    depth: { type: "integer" },
    children_count: { type: "integer" },
    ancestor_ids: { type: "json" },
  },
} satisfies SchemaDocInput);
const view = ViewConfigSchema.parse({ columns: [{ field: "subject" }] });

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ID = { a1: uuid(1), a2: uuid(2), a3: uuid(3), b1: uuid(11), b2: uuid(12) };
const tree = { parent_id: null, depth: 0, children_count: 0, ancestor_ids: [] };
const ROWS = [
  { id: ID.a1, tenant: "a", subject: "one", order: 30, ...tree },
  { id: ID.a2, tenant: "a", subject: "two", order: 10, ...tree },
  { id: ID.a3, tenant: "a", subject: "three", order: 20, ...tree },
  { id: ID.b1, tenant: "b", subject: "four", order: 10, ...tree },
  { id: ID.b2, tenant: "b", subject: "five", order: 20, ...tree },
];
const TREE_FIELDS = {
  parent_field: "parent_id",
  order_field: "order",
  depth_field: "depth",
  children_count_field: "children_count",
  ancestor_ids_field: "ancestor_ids",
};

interface Ctx {
  tenant: string | null;
}
const A: Ctx = { tenant: "a" };
const B: Ctx = { tenant: "b" };
const ADMIN: Ctx = { tenant: null };

function rowScope(ctx: Ctx, collection: string): FilterNode | undefined {
  if (collection !== "chg_task" || ctx.tenant === null) return undefined;
  return { field: "tenant", op: "eq", value: ctx.tenant };
}

const { db } = useTestDb();
/** Another connection: what it reads is committed. */
const probe = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
afterAll(() => probe.end());

beforeAll(async () => {
  await db.execute(sql.raw(createCollectionTableSql("chg_task")));
  await db.execute(sql`DROP TABLE IF EXISTS chg_table_task`);
  await db.execute(sql`
    CREATE TABLE chg_table_task (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant text,
      subject text NOT NULL,
      "order" integer,
      parent_id text,
      depth integer,
      children_count integer,
      ancestor_ids jsonb,
      row_version integer NOT NULL DEFAULT 1)`);
});

async function seedJsonb() {
  await db.execute(sql`truncate table chg_task`);
  await db.execute(sql`
    insert into chg_task (id, data)
    select (value->>'id')::uuid, value - 'id'
    from jsonb_array_elements(${JSON.stringify(ROWS)}::jsonb)`);
}

async function seedTable() {
  await db.execute(sql`truncate table chg_table_task`);
  for (const r of ROWS) {
    await db.execute(sql`
      insert into chg_table_task (id, tenant, subject, "order", parent_id, depth, children_count, ancestor_ids)
      values (${r.id}::uuid, ${r.tenant}, ${r.subject}, ${r.order}, NULL, 0, 0, '[]'::jsonb)`);
  }
}

/** A host's own source with a native `mutateMany` that does not hand the rows over. */
class SilentPostgres extends PostgresJsonbSource {
  override mutateMany(req: SourceMutateMany, sctx?: SourceContext): Promise<MutateManyResult> {
    return super.mutateMany(req, sctx ? { ...sctx, changedRows: undefined } : sctx);
  }
}

interface Backend {
  name: string;
  /** The source, and how another connection reads one row's subject (`null` for memory). */
  make(): Promise<Source>;
  committed?: (id: string) => Promise<string | null>;
  tree: boolean;
}

const jsonbCommitted = async (id: string) => {
  const res = await probe.query<{ subject: string | null }>(
    "select data->>'subject' as subject from chg_task where id = $1::uuid",
    [id],
  );
  return res.rows[0] ? res.rows[0].subject : "<deleted>";
};

const BACKENDS: Backend[] = [
  {
    name: "postgres_jsonb",
    tree: true,
    async make() {
      await seedJsonb();
      return new PostgresJsonbSource({ db, table: "chg_task", initialSchema: schema });
    },
    committed: jsonbCommitted,
  },
  {
    name: "postgres_table",
    tree: false,
    async make() {
      await seedTable();
      return new PostgresTableSource({
        db,
        schema,
        table: "chg_table_task",
        versionColumn: "row_version",
      });
    },
    async committed(id) {
      const res = await probe.query<{ subject: string }>(
        "select subject from chg_table_task where id = $1::uuid",
        [id],
      );
      return res.rows[0] ? res.rows[0].subject : "<deleted>";
    },
  },
  {
    name: "memory (the generic layer)",
    tree: true,
    async make() {
      return new MemorySource({
        schema,
        rows: ROWS.map(({ id, ...data }) => ({ __meta: { id }, ...data })),
      });
    },
  },
];

/** A memory bus that records every notice and, when asked, what another connection reads then. */
class RecordingBus extends MemoryChangeBus {
  notices: ChangeNotice[] = [];
  seen: (string | null)[] = [];
  check: ((n: ChangeNotice) => Promise<string | null>) | undefined;

  override async publish(notice: ChangeNotice): Promise<void> {
    this.notices.push(notice);
    if (this.check) this.seen.push(await this.check(notice));
    super.publish(notice);
  }
}

describe.each(BACKENDS)("writes notify on $name", (backend) => {
  let dispatcher: Dispatcher;
  let bus: RecordingBus;
  let toA: ChangeEvent[];
  let toB: ChangeEvent[];

  async function build(source: Source, more: { mutateManyLimit?: number } = {}) {
    const registry = new CollectionRegistry();
    registry.register({ name: "chg_task", source, view });
    bus = new RecordingBus();
    const feed = createChangeFeed({ bus, coalesce: false });
    dispatcher = createDispatcher<Ctx>(registry, {
      log: { error: vi.fn() },
      rowScope,
      changes: feed,
      ...more,
    });
    toA = [];
    toB = [];
    feed.subscribe({
      scopes: new Map([["chg_task", rowScope(A, "chg_task")]]),
      send: (e) => toA.push(e),
    });
    feed.subscribe({
      scopes: new Map([["chg_task", rowScope(B, "chg_task")]]),
      send: (e) => toB.push(e),
    });
  }

  beforeEach(async () => {
    await build(await backend.make());
  });

  async function run(action: string, payload: object, ctx: Ctx): Promise<UdcMessage> {
    return dispatcher.dispatch({ kind: requestKind(action), id: "t", payload }, ctx);
  }

  async function ok(action: string, payload: object, ctx: Ctx) {
    const res = await run(action, payload, ctx);
    expect(res.kind, JSON.stringify(res.payload)).toBe(`udc.${action}.ok`);
    return res.payload as Record<string, unknown>;
  }

  async function err(action: string, payload: object, ctx: Ctx) {
    const res = await run(action, payload, ctx);
    expect(res.kind, JSON.stringify(res.payload)).toBe(`udc.${action}.err`);
    return res.payload as { code: string };
  }

  it("mutate_many by ids: one notice after commit, the owner told its ids", async () => {
    if (backend.committed)
      bus.check = () => (backend.committed as (id: string) => Promise<string | null>)(ID.a1);
    const res = await ok(
      "mutate_many",
      { collection: "chg_task", op: "update", ids: [ID.a1, ID.a2, ID.b1], row: { subject: "x" } },
      A,
    );
    expect(res).toMatchObject({ updated: 2 });
    expect(bus.notices).toHaveLength(1);
    expect(bus.notices[0]).toMatchObject({ collection: "chg_task", op: "update" });
    expect([...(bus.notices[0]?.ids ?? [])].sort()).toEqual([ID.a1, ID.a2]);
    if (backend.committed) expect(bus.seen).toEqual(["x"]);
    expect(toA).toHaveLength(1);
    expect([...(toA[0]?.ids ?? [])].sort()).toEqual([ID.a1, ID.a2]);
    expect(toB).toEqual([]);
  });

  it("mutate_many delete by filter, as admin: each tenant told only its own rows", async () => {
    if (backend.committed)
      bus.check = () => (backend.committed as (id: string) => Promise<string | null>)(ID.b2);
    await ok(
      "mutate_many",
      {
        collection: "chg_task",
        op: "delete",
        filter: { field: "subject", op: "in", value: ["one", "five"] },
      },
      ADMIN,
    );
    expect(bus.notices).toHaveLength(1);
    if (backend.committed) expect(bus.seen).toEqual(["<deleted>"]);
    expect(toA).toEqual([{ collection: "chg_task", op: "delete", ids: [ID.a1] }]);
    expect(toB).toEqual([{ collection: "chg_task", op: "delete", ids: [ID.b2] }]);
  });

  it("mutate_many that matched nothing, or failed, notifies nothing", async () => {
    await ok(
      "mutate_many",
      { collection: "chg_task", op: "update", ids: [ID.b1], row: { subject: "x" } },
      A,
    );
    await build(await backend.make(), { mutateManyLimit: 1 });
    const refused = await err(
      "mutate_many",
      { collection: "chg_task", op: "delete", ids: [ID.a1, ID.a2] },
      A,
    );
    expect(refused.code).toBe("validation_error");
    // A patch that would take the rows out of a's scope is refused (and rolled back).
    await build(await backend.make());
    await err(
      "mutate_many",
      { collection: "chg_task", op: "update", ids: [ID.a1], row: { subject: 5 } },
      A,
    );
    expect(bus.notices).toEqual([]);
    expect(toA).toEqual([]);
  });

  it("a failed mutate notifies nothing", async () => {
    await err(
      "mutate",
      { collection: "chg_task", op: "update", id: ID.a1, row: {}, expected_version: 99 },
      A,
    );
    await err("mutate", { collection: "chg_task", op: "delete", id: ID.b1 }, A);
    expect(bus.notices).toEqual([]);
  });

  it.runIf(backend.tree)("reindex: one notice without ids, for the renumbered scope", async () => {
    const updated = (await ok("reindex", { collection: "chg_task", scope: {}, gap: 100 }, A))
      .updated;
    expect(updated).toBe(3);
    expect(bus.notices).toHaveLength(1);
    expect(bus.notices[0]).toMatchObject({ collection: "chg_task", op: "update" });
    expect(bus.notices[0]?.ids).toBeUndefined();
    expect(toA).toEqual([{ collection: "chg_task", op: "update" }]);
    expect(toB).toEqual([]);
  });

  it.runIf(backend.tree)("reindex that failed, or touched nothing, notifies nothing", async () => {
    // `tenant` is hidden from a scoped request: refused before anything is written.
    await err("reindex", { collection: "chg_task", scope: { tenant: "a" } }, A);
    await ok("reindex", { collection: "chg_task", scope: { subject: "nobody" } }, A);
    expect(bus.notices).toEqual([]);
  });

  it.runIf(backend.tree)("tree.reparent: one notice without ids, to the node's scope", async () => {
    if (backend.committed) {
      bus.check = async () => {
        const res = await probe.query<{ parent: string }>(
          "select data->>'parent_id' as parent from chg_task where id = $1::uuid",
          [ID.a2],
        );
        return res.rows[0]?.parent ?? null;
      };
    }
    await ok(
      "tree.reparent",
      { collection: "chg_task", id: ID.a2, parent: ID.a1, order: 5, fields: TREE_FIELDS },
      A,
    );
    expect(bus.notices).toHaveLength(1);
    expect(bus.notices[0]?.ids).toBeUndefined();
    if (backend.committed) expect(bus.seen).toEqual([ID.a1]);
    expect(toA).toEqual([{ collection: "chg_task", op: "update" }]);
    expect(toB).toEqual([]);
  });

  it.runIf(backend.tree)("tree.reparent that failed notifies nothing", async () => {
    await ok(
      "tree.reparent",
      { collection: "chg_task", id: ID.a2, parent: ID.a1, order: 5, fields: TREE_FIELDS },
      A,
    );
    bus.notices = [];
    // A cycle: a1 under its own child a2.
    const res = await err(
      "tree.reparent",
      { collection: "chg_task", id: ID.a1, parent: ID.a2, order: 5, fields: TREE_FIELDS },
      A,
    );
    expect(res.code).toBe("validation_error");
    expect(bus.notices).toEqual([]);
  });
});

describe("a source that does not hand its rows over", () => {
  it("mutate_many falls back to the ids asked for and the scope's pinned values", async () => {
    await seedJsonb();
    const registry = new CollectionRegistry();
    registry.register({
      name: "chg_task",
      source: new SilentPostgres({ db, table: "chg_task", initialSchema: schema }),
      view,
    });
    const bus = new RecordingBus();
    const feed = createChangeFeed({ bus, coalesce: false });
    const dispatcher = createDispatcher<Ctx>(registry, {
      log: { error: vi.fn() },
      rowScope,
      changes: feed,
    });
    const toA: ChangeEvent[] = [];
    const toB: ChangeEvent[] = [];
    feed.subscribe({
      scopes: new Map([["chg_task", rowScope(A, "chg_task")]]),
      send: (e) => toA.push(e),
    });
    feed.subscribe({
      scopes: new Map([["chg_task", rowScope(B, "chg_task")]]),
      send: (e) => toB.push(e),
    });
    const res = await dispatcher.dispatch(
      {
        kind: requestKind("mutate_many"),
        id: "t",
        payload: { collection: "chg_task", op: "delete", ids: [ID.a1, uuid(98)] },
      },
      A,
    );
    expect(res.kind).toBe("udc.mutate_many.ok");
    expect(bus.notices).toEqual([
      {
        collection: "chg_task",
        op: "delete",
        ids: [ID.a1],
        match: [{ values: { tenant: "a" } }],
      },
    ]);
    expect(toA).toEqual([{ collection: "chg_task", op: "delete", ids: [ID.a1] }]);
    expect(toB).toEqual([]);
    // By filter, there are no ids to name: "this collection changed", to a's scope.
    await dispatcher.dispatch(
      {
        kind: requestKind("mutate_many"),
        id: "t",
        payload: { collection: "chg_task", op: "delete", filter: { and: [] } },
      },
      A,
    );
    expect(toA.at(-1)).toEqual({ collection: "chg_task", op: "delete" });
    expect(toB).toEqual([]);
  });
});

describe("an onMutate hook that throws", () => {
  it("rolls the write back and notifies nothing", async () => {
    await seedJsonb();
    const registry = new CollectionRegistry();
    registry.register({
      name: "chg_task",
      source: new PostgresJsonbSource({
        db,
        table: "chg_task",
        initialSchema: schema,
        onMutate: () => {
          throw new UdcError("forbidden", "no");
        },
      }),
      view,
    });
    const bus = new RecordingBus();
    const dispatcher = createDispatcher<Ctx>(registry, {
      log: { error: vi.fn() },
      rowScope,
      changes: createChangeFeed({ bus }),
    });
    for (const [action, payload] of [
      ["mutate", { collection: "chg_task", op: "update", id: ID.a1, row: { subject: "x" } }],
      [
        "mutate_many",
        { collection: "chg_task", op: "update", ids: [ID.a1], row: { subject: "x" } },
      ],
    ] as const) {
      const res = await dispatcher.dispatch({ kind: requestKind(action), id: "t", payload }, A);
      expect(res.kind).toBe(`udc.${action}.err`);
    }
    expect(bus.notices).toEqual([]);
    expect(await jsonbCommitted(ID.a1)).toBe("one");
  });

  it("a hook that succeeds: the rows it saw are what the feed tests", async () => {
    await seedJsonb();
    const registry = new CollectionRegistry();
    registry.register({
      name: "chg_task",
      source: new PostgresJsonbSource({
        db,
        table: "chg_task",
        initialSchema: schema,
        onMutate: () => undefined,
      }),
      view,
    });
    const bus = new RecordingBus();
    const feed = createChangeFeed({ bus, coalesce: false });
    const dispatcher = createDispatcher<Ctx>(registry, {
      log: { error: vi.fn() },
      rowScope,
      changes: feed,
    });
    const toB: ChangeEvent[] = [];
    feed.subscribe({
      scopes: new Map([["chg_task", rowScope(B, "chg_task")]]),
      send: (e) => toB.push(e),
    });
    for (const op of ["update", "delete"] as const) {
      const res = await dispatcher.dispatch(
        {
          kind: requestKind("mutate_many"),
          id: "t",
          payload: {
            collection: "chg_task",
            op,
            ids: [ID.b1],
            ...(op === "update" ? { row: { subject: "y" } } : {}),
          },
        },
        ADMIN,
      );
      expect(res.kind).toBe("udc.mutate_many.ok");
    }
    expect(toB).toEqual([
      { collection: "chg_task", op: "update", ids: [ID.b1] },
      { collection: "chg_task", op: "delete", ids: [ID.b1] },
    ]);
  });
});
