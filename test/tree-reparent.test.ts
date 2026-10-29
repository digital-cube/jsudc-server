import { isCycle, type Row, type SchemaDocInput, SchemaDocSchema } from "@jsudc/core";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { MemorySource } from "../src/sources/memory.js";
import { PostgresJsonbSource } from "../src/sources/postgres-jsonb.js";
import type { Source, SourceTreeReparent } from "../src/sources/source.js";
import { rejectsWith, useTestDb } from "./helpers.js";

const schemaJson: SchemaDocInput = {
  version: "v1",
  fields: {
    parent_id: { type: "string" },
    order: { type: "integer" },
    depth: { type: "integer" },
    children_count: { type: "integer" },
    ancestor_ids: { type: "json" },
    name: { type: "string", required: true },
    gone: { type: "integer", deleted: true },
  },
};
const schema = SchemaDocSchema.parse(schemaJson);

// c ─ d1 ─ t1 ─ p1
//    │     │    └ p2
//    │     └ t2
//    └ d2
const ID = {
  c: "00000000-0000-4000-8000-000000000001",
  d1: "00000000-0000-4000-8000-000000000002",
  d2: "00000000-0000-4000-8000-000000000003",
  t1: "00000000-0000-4000-8000-000000000004",
  t2: "00000000-0000-4000-8000-000000000005",
  p1: "00000000-0000-4000-8000-000000000006",
  p2: "00000000-0000-4000-8000-000000000007",
} as const;
type Name = keyof typeof ID;
const NAMES = Object.keys(ID) as Name[];
const PARENT: Record<Name, Name | null> = {
  c: null,
  d1: "c",
  d2: "c",
  t1: "d1",
  t2: "d1",
  p1: "t1",
  p2: "t1",
};
const MISSING = "00000000-0000-4000-8000-0000000000ff";

function ancestorsOf(name: Name): Name[] {
  const up: Name[] = [];
  for (let at = PARENT[name]; at !== null; at = PARENT[at]) up.unshift(at);
  return up;
}

const rows = NAMES.map((name, i) => ({
  __meta: { id: ID[name] },
  name,
  parent_id: PARENT[name] === null ? null : ID[PARENT[name] as Name],
  order: (i + 1) * 100,
  depth: ancestorsOf(name).length,
  ancestor_ids: ancestorsOf(name).map((n) => ID[n]),
  children_count: NAMES.filter((n) => PARENT[n] === name).length,
}));

const FIELDS = {
  parent_field: "parent_id",
  order_field: "order",
  depth_field: "depth",
  ancestor_ids_field: "ancestor_ids",
  children_count_field: "children_count",
};

const { db } = useTestDb();

async function pgSource(): Promise<Source> {
  await db.execute(sql`truncate table tree_nodes, udc_schema_revisions restart identity`);
  await db.execute(sql`
    insert into tree_nodes (id, data)
    select (value->'__meta'->>'id')::uuid, value - '__meta'
    from jsonb_array_elements(${JSON.stringify(rows)}::jsonb)`);
  return new PostgresJsonbSource({ db, table: "tree_nodes", initialSchema: schema });
}

const memorySource = async (): Promise<Source> => new MemorySource({ schema, rows });

const byName = (all: Row[]) => Object.fromEntries(all.map((r) => [r.name as Name, r]));

async function tree(source: Source): Promise<Record<Name, Row>> {
  const { rows: all } = await source.list({ page: { limit: 100 } });
  return byName(all) as Record<Name, Row>;
}

/** What the structure fields of every row should be, from the parent links alone. */
function expectConsistent(all: Record<Name, Row>) {
  const parentOf = (n: Name): Name | null => {
    const pid = all[n].parent_id;
    return pid == null ? null : (NAMES.find((m) => ID[m] === pid) as Name);
  };
  for (const n of NAMES) {
    const up: string[] = [];
    for (let at = parentOf(n); at !== null; at = parentOf(at)) up.unshift(ID[at]);
    expect(all[n].ancestor_ids, `${n} ancestor_ids`).toEqual(up);
    expect(all[n].depth, `${n} depth`).toBe(up.length);
    expect(all[n].children_count, `${n} children_count`).toBe(
      NAMES.filter((m) => parentOf(m) === n).length,
    );
  }
}

const versions = (all: Record<Name, Row>) =>
  Object.fromEntries(NAMES.map((n) => [n, all[n].__meta.version]));

describe.each([
  ["postgres jsonb", pgSource],
  ["memory", memorySource],
])("tree.reparent on %s", (_, make) => {
  let source: Source;
  const reparent = (
    req: Omit<SourceTreeReparent, "fields"> & { fields?: SourceTreeReparent["fields"] },
  ) => source.reparent?.({ fields: FIELDS, ...req }) ?? Promise.reject(new Error("no reparent"));

  beforeEach(async () => {
    source = await make();
  });

  it("advertises the capability", () => {
    expect(source.capabilities.tree_reparent).toBe(true);
  });

  it("starts consistent", async () => {
    expectConsistent(await tree(source));
  });

  it("moves a subtree under another parent and recomputes every descendant", async () => {
    const res = await reparent({ id: ID.t1, parent: ID.d2, order: 150 });
    // t1, p1, p2, and both parents.
    expect(res.updated).toBe(5);
    expect(res.row).toMatchObject({
      __meta: { id: ID.t1, version: 2 },
      parent_id: ID.d2,
      order: 150,
      depth: 2,
      ancestor_ids: [ID.c, ID.d2],
    });
    const all = await tree(source);
    expectConsistent(all);
    expect(all.p1.ancestor_ids).toEqual([ID.c, ID.d2, ID.t1]);
    expect([all.d1.children_count, all.d2.children_count]).toEqual([1, 1]);
    expect(versions(all)).toEqual({ c: 1, d1: 2, d2: 2, t1: 2, t2: 1, p1: 2, p2: 2 });
  });

  it("moves a subtree deeper and to the root", async () => {
    await reparent({ id: ID.d1, parent: ID.d2, order: 100 });
    let all = await tree(source);
    expectConsistent(all);
    expect([all.d1.depth, all.t1.depth, all.p2.depth]).toEqual([2, 3, 4]);
    expect([all.c.children_count, all.d2.children_count]).toEqual([1, 1]);

    const res = await reparent({ id: ID.t1, parent: null, order: -100 });
    expect(res.row).toMatchObject({ parent_id: null, depth: 0, ancestor_ids: [] });
    all = await tree(source);
    expectConsistent(all);
    expect(all.p1.ancestor_ids).toEqual([ID.t1]);
  });

  it("reorders among the same siblings without touching anyone else", async () => {
    const res = await reparent({ id: ID.t2, parent: ID.d1, order: 50, expected_version: 1 });
    expect(res.updated).toBe(1);
    const all = await tree(source);
    expect(all.t2.order).toBe(50);
    expect(versions(all)).toEqual({ c: 1, d1: 1, d2: 1, t1: 1, t2: 2, p1: 1, p2: 1 });
  });

  it("writes only the structure fields it was given", async () => {
    const res = await reparent({
      id: ID.t1,
      parent: ID.d2,
      order: 100,
      fields: { parent_field: "parent_id", order_field: "order" },
    });
    expect(res.updated).toBe(1);
    const all = await tree(source);
    expect(all.t1).toMatchObject({ parent_id: ID.d2, depth: 2, ancestor_ids: [ID.c, ID.d1] });
    expect(all.d1.children_count).toBe(2);
    expect(all.p1.__meta.version).toBe(1);
  });

  it("refuses every move into the node itself or its subtree (isCycle), changing nothing", async () => {
    const parents = new Map(rows.map((r) => [r.__meta.id, r.parent_id]));
    const cycles = NAMES.flatMap((n) =>
      NAMES.filter((p) => isCycle(ID[n], ID[p], parents)).map((p) => [n, p] as const),
    );
    expect(cycles).toContainEqual(["d1", "p1"]);
    expect(cycles).toContainEqual(["c", "c"]);
    expect(cycles).not.toContainEqual(["t1", "d2"]);
    for (const [n, p] of cycles) {
      const err = await rejectsWith(
        reparent({ id: ID[n], parent: ID[p], order: 1 }),
        "validation_error",
      );
      expect(err.message).toMatch(/cycle/);
    }
    expect(versions(await tree(source))).toEqual({
      c: 1,
      d1: 1,
      d2: 1,
      t1: 1,
      t2: 1,
      p1: 1,
      p2: 1,
    });
  });

  it.each([
    [{ depth_field: "nope" }],
    [{ ancestor_ids_field: "gone" }],
    [{ children_count_field: "data->>'x'" }],
    [{ parent_field: "missing" }],
    [{ order_field: "name" }],
    [{ depth_field: "name" }],
  ])("refuses the field names %j", async (bad) => {
    await rejectsWith(
      reparent({ id: ID.t1, parent: ID.d2, order: 1, fields: { ...FIELDS, ...bad } }),
      "validation_error",
    );
    expect((await tree(source)).t1.__meta.version).toBe(1);
  });

  it("refuses an order the order field cannot hold", async () => {
    await rejectsWith(reparent({ id: ID.t1, parent: ID.d2, order: 1.5 }), "validation_error");
  });

  it("answers not_found for the node or the parent", async () => {
    await rejectsWith(reparent({ id: MISSING, parent: ID.d2, order: 1 }), "not_found");
    await rejectsWith(reparent({ id: ID.t1, parent: MISSING, order: 1 }), "not_found");
    await rejectsWith(reparent({ id: "not-a-uuid", parent: null, order: 1 }), "not_found");
    await rejectsWith(reparent({ id: ID.t1, parent: "not-a-uuid", order: 1 }), "not_found");
  });

  it("honours expected_version", async () => {
    const err = await rejectsWith(
      reparent({ id: ID.t1, parent: ID.d2, order: 1, expected_version: 7 }),
      "version_conflict",
    );
    expect(err.details).toMatchObject({ current_version: 1 });
    expect((await tree(source)).t1.parent_id).toBe(ID.d1);
    const res = await reparent({ id: ID.t1, parent: ID.d2, order: 1, expected_version: 1 });
    expect(res.row.__meta.version).toBe(2);
  });
});
