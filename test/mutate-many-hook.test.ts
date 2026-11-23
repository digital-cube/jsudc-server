// `mutate_many` with the `onMutate` hook on both Postgres sources (row by row, one
// transaction, the hook called per row, a failure rolls everything back), and a patch that
// would take a row out of the row scope (refused as a whole, with and without the hook, and
// on the memory fallback).
import {
  type FilterNode,
  requestKind,
  type SchemaDocInput,
  SchemaDocSchema,
  UdcError,
  ViewConfigSchema,
} from "@jsudc/core";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { connect } from "../src/db/client.js";
import { createCollectionTableSql } from "../src/db/schema.js";
import { createDispatcher } from "../src/dispatcher.js";
import { MemorySource, type RowChange } from "../src/index.js";
import { type OnMutateHook, PostgresJsonbSource, PostgresTableSource } from "../src/postgres.js";
import { CollectionRegistry } from "../src/registry.js";
import type { Source } from "../src/sources/source.js";
import { TEST_DATABASE_URL, useTestDb } from "./helpers.js";

const { db } = useTestDb();
/** Another connection: what is committed. */
const other = connect(TEST_DATABASE_URL);
afterAll(() => other.close());

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
const ROWS = IDS.map((id, i) => ({ id, tenant: "a", subject: `s${i + 1}`, size: i + 1 }));

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

interface Backend {
  name: string;
  make(onMutate?: OnMutateHook): Promise<Source>;
  /** Committed `size` per id, through another connection (`undefined`: no row). */
  sizes(): Promise<Record<string, number | undefined>>;
}

const committed = async (query: ReturnType<typeof sql>) => {
  const res = await other.db.execute<{ id: string; size: number }>(query);
  const out: Record<string, number | undefined> = {};
  for (const id of IDS) out[id] = res.rows.find((r) => r.id === id)?.size;
  return out;
};

const PG_BACKENDS: Backend[] = [
  {
    name: "postgres_jsonb",
    async make(onMutate) {
      await db.execute(sql`TRUNCATE mmh_message`);
      await db.execute(sql`
        INSERT INTO mmh_message (id, data)
        SELECT (value->>'id')::uuid, value - 'id'
        FROM jsonb_array_elements(${JSON.stringify(ROWS)}::jsonb)`);
      return new PostgresJsonbSource({
        db,
        table: "mmh_message",
        initialSchema: schema,
        ...(onMutate ? { onMutate } : {}),
      });
    },
    sizes: () =>
      committed(sql`SELECT id::text AS id, (data->>'size')::int AS size FROM mmh_message`),
  },
  {
    name: "postgres_table",
    async make(onMutate) {
      await db.execute(sql`TRUNCATE mmh_message_t`);
      for (const r of ROWS) {
        await db.execute(sql`
          INSERT INTO mmh_message_t (id, tenant, subject, size)
          VALUES (${r.id}::uuid, ${r.tenant}, ${r.subject}, ${r.size})`);
      }
      return new PostgresTableSource({
        db,
        schema,
        table: "mmh_message_t",
        versionColumn: "row_version",
        ...(onMutate ? { onMutate } : {}),
      });
    },
    sizes: () => committed(sql`SELECT id::text AS id, size FROM mmh_message_t`),
  },
];

beforeAll(async () => {
  await db.execute(sql.raw(createCollectionTableSql("mmh_message")));
  await db.execute(sql`DROP TABLE IF EXISTS mmh_message_t, mmh_log`);
  await db.execute(sql`
    CREATE TABLE mmh_message_t (
      id uuid PRIMARY KEY, tenant text, subject text NOT NULL, size integer,
      row_version integer NOT NULL DEFAULT 1)`);
  await db.execute(sql`CREATE TABLE mmh_log (id serial PRIMARY KEY, row_id text)`);
});

const ORIGINAL = Object.fromEntries(ROWS.map((r) => [r.id, r.size]));

function dispatcherFor(source: Source, log = { error: vi.fn() }) {
  const registry = new CollectionRegistry();
  registry.register({ name: "message", source, view });
  // The scope's fields stay visible, so a patch may name `size`.
  return createDispatcher<Ctx>(registry, { log, rowScope, showScopeFields: ["message"] });
}

async function send(source: Source, payload: object, log = { error: vi.fn() }) {
  return dispatcherFor(source, log).dispatch(
    { kind: requestKind("mutate_many"), id: "m", payload: { collection: "message", ...payload } },
    { tenant: "a" },
  );
}

describe.each(PG_BACKENDS)("mutate_many with onMutate on $name", (backend) => {
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE mmh_log`);
  });

  it("calls the hook once per row with the context, before, after and the patch", async () => {
    const seen: { ctx: unknown; change: RowChange }[] = [];
    const source = await backend.make(async (ctx, change, tx) => {
      seen.push({ ctx, change });
      await tx.execute(sql`INSERT INTO mmh_log (row_id) VALUES (${change.id})`);
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
    const log = await other.db.execute<{ row_id: string }>(
      sql`SELECT row_id FROM mmh_log ORDER BY id`,
    );
    expect(log.rows.map((r) => r.row_id)).toEqual([IDS[0], IDS[1]]);
    expect(await backend.sizes()).toMatchObject({ [IDS[0]]: 7, [IDS[1]]: 7, [IDS[2]]: 3 });
  });

  it("calls the hook on a delete by filter with before and no after", async () => {
    const seen: RowChange[] = [];
    const source = await backend.make((_ctx, change) => {
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
    expect(await backend.sizes()).toEqual({
      ...ORIGINAL,
      [IDS[2]]: undefined,
      [IDS[3]]: undefined,
    });
  });

  it("a hook throwing on the third row leaves the first two unchanged", async () => {
    let calls = 0;
    const source = await backend.make(async (_ctx, change, tx) => {
      calls += 1;
      await tx.execute(sql`INSERT INTO mmh_log (row_id) VALUES (${change.id})`);
      if (calls === 3)
        throw new UdcError("forbidden", "row 3 is locked by policy", { id: change.id });
    });
    const res = await send(source, { op: "update", filter: { and: [] }, row: { size: 8 } });
    expect(res.kind).toBe("udc.mutate_many.err");
    expect(res.payload).toEqual({
      code: "forbidden",
      message: "row 3 is locked by policy",
      details: { id: IDS[2] },
    });
    expect(calls).toBe(3);
    expect(await backend.sizes()).toEqual(ORIGINAL);
    const log = await other.db.execute(sql`SELECT 1 FROM mmh_log`);
    expect(log.rows).toHaveLength(0);
    // The versions did not move either.
    for (const id of IDS) expect((await source.read(id)).__meta.version).toBe(1);
  });

  it("a hook throwing anything else is internal, logged, and rolls back a delete", async () => {
    const log = { error: vi.fn() };
    let calls = 0;
    const source = await backend.make(() => {
      calls += 1;
      if (calls === 2) throw new Error("db password=hunter2");
    });
    const res = await send(source, { op: "delete", ids: [...IDS] }, log);
    expect(res.payload).toEqual({ code: "internal", message: "internal error" });
    expect(log.error).toHaveBeenCalledOnce();
    expect(await backend.sizes()).toEqual(ORIGINAL);
  });
});

const ALL_BACKENDS: Backend[] = [
  ...PG_BACKENDS,
  {
    name: "memory",
    async make() {
      memory = new MemorySource({
        schema,
        rows: ROWS.map(({ id, ...data }) => ({ __meta: { id }, ...data })),
      });
      return memory;
    },
    async sizes() {
      const res = await memory.list({ page: { limit: 100 } });
      const out: Record<string, number | undefined> = {};
      for (const id of IDS) out[id] = res.rows.find((r) => r.__meta.id === id)?.size as number;
      return out;
    },
  },
];
let memory: MemorySource;

describe.each(ALL_BACKENDS)("a patch leaving the row scope on $name", (backend) => {
  it("is refused as a whole: forbidden, nothing written", async () => {
    const source = await backend.make();
    const res = await send(source, { op: "update", ids: [IDS[0], IDS[1]], row: { size: 50 } });
    expect(res.payload).toMatchObject({ code: "forbidden", details: { reason: "out_of_scope" } });
    expect(await backend.sizes()).toEqual(ORIGINAL);
  });

  it("by filter too", async () => {
    const source = await backend.make();
    const res = await send(source, { op: "update", filter: { and: [] }, row: { size: 10 } });
    expect(res.payload).toMatchObject({ code: "forbidden" });
    expect(await backend.sizes()).toEqual(ORIGINAL);
  });
});

describe.each(PG_BACKENDS)("a patch leaving the row scope with onMutate on $name", (backend) => {
  it("rolls back the rows before it, and the hook never sees the refused row", async () => {
    const seen: string[] = [];
    const source = await backend.make((_ctx, change) => {
      seen.push(change.id);
    });
    // Only the patch's size sends a row out: every row of the request leaves the scope.
    const res = await send(source, { op: "update", ids: [IDS[0], IDS[1]], row: { size: 99 } });
    expect(res.payload).toMatchObject({ code: "forbidden", details: { reason: "out_of_scope" } });
    expect(seen).toEqual([]);
    expect(await backend.sizes()).toEqual(ORIGINAL);
  });
});
