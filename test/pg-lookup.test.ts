import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FilterNode, type SchemaDocInput, SchemaDocSchema } from "@jsudc/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { createDispatcher } from "../src/dispatcher.js";
import { checkRegistryLinks, registryLinkProblems } from "../src/links.js";
import { CollectionRegistry, loadRegistry } from "../src/registry.js";
import { MemorySource } from "../src/sources/memory.js";
import { PostgresJsonbSource } from "../src/sources/postgres-jsonb.js";
import { activateSchema, insertRows, rejectsWith, resetTables, useTestDb } from "./helpers.js";

const { db } = useTestDb();

// `companies` plays the referencing collection: a lookup by id, one by an integer key, a list.
const tickets: SchemaDocInput = {
  version: "v1",
  fields: {
    tag: { type: "string" },
    board_id: { type: "lookup", ref: "boards", label_field: "name", index: true },
    level: {
      type: "lookup",
      lookup: { collection: "levels", key_field: "code", label_field: "name" },
    },
    assignees: { type: "lookup_array", lookup: { collection: "org", label_field: "name" } },
  },
};
const ticketsSchema = SchemaDocSchema.parse(tickets);

const ROWS = [
  { tag: "t1", board_id: "b-2", level: 10, assignees: ["p1", "p2"] },
  { tag: "t2", board_id: "b-1", level: 9, assignees: ["p2"] },
  { tag: "t3", board_id: "b-10", level: 100, assignees: [] },
  { tag: "t4" },
  { tag: "t5", board_id: "b-1", level: "x", assignees: ["p3", 7] },
];

let source: PostgresJsonbSource;
let ids: string[] = [];
beforeAll(async () => {
  await resetTables(db);
  await activateSchema(db, tickets);
  ids = await insertRows(db, ROWS);
  source = new PostgresJsonbSource({ db, table: "companies", initialSchema: ticketsSchema });
});

const memory = () =>
  new MemorySource({
    schema: ticketsSchema,
    rows: ROWS.map((r, i) => ({ __meta: { id: ids[i] }, ...r })),
  });

async function tags(s: PostgresJsonbSource | MemorySource, filter: FilterNode, sort = "tag") {
  const res = await s.list({ filter, sort: [{ field: sort }], page: { limit: 100 } });
  return res.rows.map((r) => r.tag as string);
}

const c = (field: string, op: string, value?: unknown): FilterNode =>
  ({ field, op, value }) as FilterNode;

describe("lookup fields in postgres_jsonb (and the same in memory)", () => {
  const cases: [string, FilterNode, string[]][] = [
    ["eq on the key", c("board_id", "eq", "b-1"), ["t2", "t5"]],
    ["neq keeps a missing key unknown", c("board_id", "neq", "b-1"), ["t1", "t3"]],
    ["in", c("board_id", "in", ["b-2", "b-10", null]), ["t1", "t3"]],
    ["not_in", c("board_id", "not_in", ["b-1"]), ["t1", "t3"]],
    ["is_null", c("board_id", "is_null"), ["t4"]],
    ["is_not_null", c("board_id", "is_not_null"), ["t1", "t2", "t3", "t5"]],
    ["an integer key, by number", c("level", "eq", 10), ["t1"]],
    ["an integer key, by its text", c("level", "in", ["9", "x"]), ["t2", "t5"]],
    ["lookup_array in: any key", c("assignees", "in", ["p2"]), ["t1", "t2"]],
    ["lookup_array in: an integer key", c("assignees", "in", [7]), ["t5"]],
    ["lookup_array not_in: none", c("assignees", "not_in", ["p2"]), ["t3", "t5"]],
    ["lookup_array is_null", c("assignees", "is_null"), ["t4"]],
  ];

  it.each(cases)("%s", async (_name, filter, expected) => {
    expect(await tags(source, filter)).toEqual(expected);
    expect(await tags(memory(), filter)).toEqual(expected);
  });

  it("sorts by the key as text", async () => {
    const res = await source.list({
      sort: [{ field: "board_id" }, { field: "tag" }],
      page: { limit: 100 },
    });
    expect(res.rows.map((r) => r.tag)).toEqual(["t2", "t5", "t3", "t1", "t4"]);
    const desc = await source.list({
      sort: [{ field: "board_id", dir: "desc" }, { field: "tag" }],
      page: { limit: 2 },
    });
    expect(desc.rows.map((r) => r.tag)).toEqual(["t1", "t3"]);
    // The keyset cursor walks a lookup sort like any text sort.
    const next = await source.list({
      sort: [{ field: "board_id", dir: "desc" }, { field: "tag" }],
      page: { limit: 10, cursor: desc.next_cursor },
    });
    expect(next.rows.map((r) => r.tag)).toEqual(["t2", "t5", "t4"]);
  });

  it.each([
    ["contains", "x"],
    ["starts_with", "b"],
    ["gt", "b"],
    ["between", ["a", "z"]],
  ])("refuses %s on a lookup key with unsupported_op", async (op, value) => {
    const err = await rejectsWith(
      source.list({ filter: c("board_id", op, value) }),
      "unsupported_op",
    );
    expect(err.message).toMatch(/lookup field board_id/);
    await rejectsWith(memory().list({ filter: c("board_id", op, value) }), "unsupported_op");
  });

  it("refuses eq and contains on a lookup_array", async () => {
    await rejectsWith(source.list({ filter: c("assignees", "eq", "p1") }), "unsupported_op");
    await rejectsWith(source.list({ filter: c("assignees", "contains", "p") }), "unsupported_op");
  });

  it("stores a string or integer key and refuses anything else", async () => {
    const row = await source.mutate({
      op: "insert",
      row: { tag: "t6", board_id: "b-3", level: 5 },
    });
    expect(row).toMatchObject({ board_id: "b-3", level: 5 });
    await rejectsWith(source.mutate({ op: "insert", row: { board_id: 1.5 } }), "validation_error");
    await rejectsWith(
      source.mutate({ op: "insert", row: { assignees: [{ id: "p1" }] } }),
      "validation_error",
    );
    await source.mutate({ op: "delete", id: row.__meta.id });
  });
});

describe("the row id as a filter field", () => {
  it("answers eq, neq, in and not_in on `id`", async () => {
    const [first, second] = ids;
    for (const s of [source, memory()]) {
      expect(await tags(s, c("id", "eq", first))).toEqual(["t1"]);
      expect(await tags(s, c("id", "in", [first, second, "not-a-uuid"]))).toEqual(["t1", "t2"]);
      expect(await tags(s, c("id", "not_in", [first]))).toEqual(["t2", "t3", "t4", "t5"]);
      expect((await tags(s, c("id", "neq", first))).length).toBe(4);
      expect(await tags(s, c("id", "is_null"))).toEqual([]);
      expect((await tags(s, c("id", "is_not_null"))).length).toBe(5);
    }
  });

  it("refuses other ops and keeps sort on schema fields", async () => {
    await rejectsWith(source.list({ filter: c("id", "contains", "a") }), "unsupported_op");
    await rejectsWith(source.list({ sort: [{ field: "id" }] }), "validation_error");
  });
});

// --- registry checks -------------------------------------------------------------------------

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function collectionsDir(spec: Record<string, { schema: unknown; view?: string }>): string {
  const dir = mkdtempSync(join(tmpdir(), "jsudc-lookups-"));
  dirs.push(dir);
  for (const [name, { schema, view }] of Object.entries(spec)) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, "schema.json"), JSON.stringify(schema));
    writeFileSync(join(dir, name, "view.yaml"), view ?? "");
    writeFileSync(join(dir, name, "source.yaml"), "kind: memory\n");
  }
  return dir;
}

const boardsDoc = { version: "v1", fields: { name: { type: "string" }, key: { type: "string" } } };
const ticketsDoc = (fields: Record<string, unknown>) => ({
  version: "v1",
  fields: { title: { type: "string" }, ...fields },
});
const memorySource = (a: { schema: ReturnType<typeof SchemaDocSchema.parse> }) =>
  new MemorySource({ schema: a.schema });

describe("registry: lookups and row links checked at load", () => {
  it("loads a registry whose lookups and row link fit", () => {
    const dir = collectionsDir({
      boards: {
        schema: boardsDoc,
        view: "row_link: {collection: tickets, filter: {field: board_id, value_from: id}}\n",
      },
      tickets: {
        schema: ticketsDoc({
          board_id: { type: "lookup", lookup: { collection: "boards", label_field: "name" } },
        }),
      },
    });
    const registry = loadRegistry(dir, memorySource);
    expect(registry.get("boards").view.row_link?.collection).toBe("tickets");
  });

  it("stops the start naming the collection, the field and what is missing", () => {
    const dir = collectionsDir({
      boards: {
        schema: boardsDoc,
        view: "row_link: {collection: tickets, filter: {field: board, value_from: colour}}\n",
      },
      tickets: {
        schema: ticketsDoc({
          board_id: { type: "lookup", ref: "boards", label_field: "title" },
          owner: { type: "lookup", lookup: { collection: "people", label_field: "name" } },
        }),
      },
    });
    expect(() => loadRegistry(dir, memorySource)).toThrow(
      [
        "boards.row_link: tickets has no field board",
        "boards.row_link: value_from colour is neither id nor a field of boards",
        "tickets.board_id: lookup target boards has no field title",
        "tickets.owner: lookup target people is not a served collection",
      ].join("\n"),
    );
  });

  it("counts a collection the factory does not serve as missing", () => {
    const dir = collectionsDir({
      boards: { schema: boardsDoc },
      tickets: {
        schema: ticketsDoc({ board_id: { type: "lookup", ref: "boards", label_field: "name" } }),
      },
    });
    expect(() => loadRegistry(dir, (a) => (a.name === "boards" ? null : memorySource(a)))).toThrow(
      "tickets.board_id: lookup target boards is not a served collection",
    );
  });

  it("refuses a lookup without a target block (a dc-lookups path)", () => {
    expect(
      registryLinkProblems([
        {
          name: "books",
          schema: SchemaDocSchema.parse(
            ticketsDoc({ genre: { type: "lookup", ref: "Books.Genre" } }),
          ),
          view: {},
        },
      ]),
    ).toEqual(["books.genre: a lookup field needs lookup: {collection, label_field}"]);
  });
});

describe("active schemas: checkRegistryLinks and udcPlugin", () => {
  const boardsActive = {
    version: "v1",
    fields: { name: { type: "string" }, key: { type: "string" } },
  };

  function registryWith(boardsFields: Record<string, unknown>) {
    const registry = new CollectionRegistry();
    registry.register({
      name: "boards",
      source: new MemorySource({
        schema: SchemaDocSchema.parse({ version: "v2", fields: boardsFields }),
      }),
      view: {} as never,
    });
    registry.register({
      name: "companies",
      source,
      view: {} as never,
    });
    return registry;
  }

  it("passes when every target has its fields", async () => {
    const registry = registryWith(boardsActive.fields);
    // companies' other targets (levels, org) are not served here: only boards is checked by name.
    await expect(checkRegistryLinks(registry)).rejects.toThrow(
      /companies.level: lookup target levels is not a served collection/,
    );
    await expect(checkRegistryLinks(registry)).rejects.not.toThrow(/companies.board_id/);
  });

  it("fails when a revision dropped the label field, and so does udcPlugin", async () => {
    const registry = registryWith({ name: { type: "string", deleted: true } });
    await expect(checkRegistryLinks(registry)).rejects.toThrow(
      /companies.board_id: lookup target boards has no field name/,
    );
    const dispatcher = createDispatcher(registry, { log: { error: vi.fn() } });
    await expect(buildApp({ dispatcher, registry, swagger: false })).rejects.toThrow(
      /lookup target boards has no field name/,
    );
    const app = await buildApp({ dispatcher, registry, swagger: false, checkLinks: false });
    await app.close();
  });
});

describe("schema.add_field and schema.update_field with a lookup", () => {
  const notesSchema = SchemaDocSchema.parse({
    version: "v1",
    fields: { title: { type: "string" } },
  });
  const boardsSchema = SchemaDocSchema.parse(boardsDoc);

  function setup() {
    const registry = new CollectionRegistry();
    registry.register({
      name: "boards",
      source: new MemorySource({ schema: boardsSchema }),
      view: {} as never,
    });
    registry.register({ name: "companies", source, view: {} as never });
    return createDispatcher(registry, { log: { error: vi.fn() } });
  }

  const call = (action: string, payload: unknown) =>
    setup().dispatch({ kind: `udc.${action}`, id: "t", payload });

  beforeAll(async () => {
    await activateSchema(db, { ...notesSchema, version: "v1" }, 2);
  });

  it("adds a lookup whose target fits, in the nested and in the flat form", async () => {
    const ok = await call("schema.add_field", {
      collection: "companies",
      name: "board",
      fielddef: { type: "lookup", lookup: { collection: "boards", label_field: "name" } },
      position: { where: "end" },
    });
    expect(ok.kind).toBe("udc.schema.add_field.ok");
    const flat = await call("schema.add_field", {
      collection: "companies",
      name: "boards",
      fielddef: { type: "lookup_array", ref: "boards", label_field: "key" },
      position: { where: "end" },
    });
    expect(flat.kind).toBe("udc.schema.add_field.ok");
    const schema = (flat.payload as { schema: { fields: Record<string, unknown> } }).schema;
    expect(schema.fields.boards).toEqual({
      type: "lookup_array",
      lookup: { collection: "boards", label_field: "key" },
    });
  });

  it("refuses a lookup whose target does not fit, with validation_error", async () => {
    const bad = await call("schema.add_field", {
      collection: "companies",
      name: "owner",
      fielddef: { type: "lookup", lookup: { collection: "boards", label_field: "nope" } },
      position: { where: "end" },
    });
    expect(bad).toMatchObject({
      kind: "udc.schema.add_field.err",
      payload: {
        code: "validation_error",
        message: "companies.owner: lookup target boards has no field nope",
      },
    });
    const missing = await call("schema.add_field", {
      collection: "companies",
      name: "owner",
      fielddef: { type: "lookup", lookup: { collection: "people", label_field: "name" } },
      position: { where: "end" },
    });
    expect(missing.payload).toMatchObject({ code: "validation_error" });
    const update = await call("schema.update_field", {
      collection: "companies",
      name: "board",
      fielddef: { type: "lookup", lookup: { collection: "boards", label_field: "gone" } },
    });
    expect(update.payload).toMatchObject({ code: "validation_error" });
  });

  it("still refuses to add a relation (level 2)", async () => {
    const res = await call("schema.add_field", {
      collection: "companies",
      name: "rel",
      fielddef: { type: "relation", ref: "boards", label_field: "name" },
      position: { where: "end" },
    });
    expect(res.payload).toMatchObject({ code: "unsupported_op" });
  });
});
