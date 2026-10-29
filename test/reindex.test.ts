import { type SchemaDocInput, SchemaDocSchema } from "@jsudc/core";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { MemorySource } from "../src/sources/memory.js";
import { PostgresJsonbSource } from "../src/sources/postgres-jsonb.js";
import type { Source } from "../src/sources/source.js";
import { rejectsWith, useTestDb } from "./helpers.js";

const schemaJson: SchemaDocInput = {
  version: "v1",
  fields: {
    title: { type: "string", required: true },
    bucket_id: { type: "string" },
    board_id: { type: "string" },
    order: { type: "integer" },
    rank: { type: "decimal" },
    done: { type: "bool" },
    gone: { type: "integer", deleted: true },
  },
};
const schema = SchemaDocSchema.parse(schemaJson);

// Bucket a: orders that collide (100, 101), a NULL and a tie; bucket b: untouched.
const rows = [
  { title: "a1", bucket_id: "a", board_id: "x", order: 101, done: false },
  { title: "a2", bucket_id: "a", board_id: "x", order: 100, done: false },
  { title: "a3", bucket_id: "a", board_id: "x", done: true },
  { title: "a4", bucket_id: "a", board_id: "x", order: -50, done: false },
  { title: "b1", bucket_id: "b", board_id: "x", order: 7, done: false },
  { title: "b2", bucket_id: "b", board_id: "x", order: 3, done: false },
];

const { db } = useTestDb();

async function pgSource(): Promise<Source> {
  await db.execute(sql`truncate table tasks, udc_schema_revisions restart identity`);
  await db.execute(sql`
    insert into tasks (data)
    select value from jsonb_array_elements(${JSON.stringify(rows)}::jsonb)`);
  return new PostgresJsonbSource({ db, table: "tasks", initialSchema: schema });
}

const memorySource = async (): Promise<Source> => new MemorySource({ schema, rows });

async function state(source: Source) {
  const { rows: all } = await source.list({ sort: [{ field: "title" }], page: { limit: 100 } });
  return Object.fromEntries(
    all.map((r) => [r.title, { order: r.order, version: r.__meta.version }]),
  );
}

describe.each([
  ["postgres jsonb", pgSource],
  ["memory", memorySource],
])("reindex on %s", (_, make) => {
  let source: Source;
  beforeEach(async () => {
    source = await make();
  });

  it("advertises the capability", () => {
    expect(source.capabilities.reindex).toBe(true);
  });

  it("renumbers one scope in order, NULLs last, and leaves the others alone", async () => {
    const res = await source.reindex?.({ scope: { bucket_id: "a" } });
    expect(res).toBe(4);
    expect(await state(source)).toEqual({
      a4: { order: 100, version: 2 },
      a2: { order: 200, version: 2 },
      a1: { order: 300, version: 2 },
      a3: { order: 400, version: 2 },
      b1: { order: 7, version: 1 },
      b2: { order: 3, version: 1 },
    });
  });

  it("takes several scope fields, a gap and another order field", async () => {
    await source.mutate({
      op: "update",
      id: (await idOf(source, "b1")) as string,
      row: { rank: 2.5 },
    });
    await source.mutate({
      op: "update",
      id: (await idOf(source, "b2")) as string,
      row: { rank: 1 },
    });
    const res = await source.reindex?.({
      scope: { board_id: "x", done: false, bucket_id: "b" },
      order_field: "rank",
      gap: 10,
    });
    expect(res).toBe(2);
    const { rows: b } = await source.list({
      filter: { field: "bucket_id", op: "eq", value: "b" },
      sort: [{ field: "rank" }],
    });
    expect(b.map((r) => [r.title, r.rank, r.order])).toEqual([
      ["b2", 10, 3],
      ["b1", 20, 7],
    ]);
  });

  it("answers 0 for an empty scope match", async () => {
    expect(await source.reindex?.({ scope: { bucket_id: "nope" } })).toBe(0);
  });

  it.each([
    [{ scope: { nope: "a" } }],
    [{ scope: { gone: 1 } }],
    [{ scope: { "data->>'x'": "a" } }],
    [{ scope: { bucket_id: "a" }, order_field: "missing" }],
    [{ scope: { bucket_id: "a" }, order_field: "title" }],
    [{ scope: { order: "not a number" } }],
  ])("refuses %j", async (req) => {
    await rejectsWith(source.reindex?.(req) ?? Promise.resolve(), "validation_error");
    expect((await state(source)).a1).toEqual({ order: 101, version: 1 });
  });
});

async function idOf(source: Source, title: string) {
  const { rows: found } = await source.list({ filter: { field: "title", op: "eq", value: title } });
  return found[0]?.__meta.id;
}
