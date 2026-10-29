import {
  ACTION_NAMES,
  ACTIONS,
  type DescribeResponse,
  type ListResponse,
  SchemaDocSchema,
  UdcError,
  type UdcMessage,
  ViewConfigSchema,
} from "@jsudc/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDispatcher, Dispatcher } from "../src/dispatcher.js";
import { CollectionRegistry } from "../src/registry.js";
import { MemorySource } from "../src/sources/memory.js";

const schema = SchemaDocSchema.parse({
  version: "v1",
  fields: {
    name: { type: "string", required: true },
    employees: { type: "integer" },
    active: { type: "bool" },
    note: { type: "text" },
    old: { type: "string", deleted: true },
  },
});

const view = ViewConfigSchema.parse({
  default_renderer: "table",
  available_renderers: ["table", "cards"],
  page_size_default: 2,
  columns: [{ field: "name", width: 300 }, { field: "active" }],
});

const rows = [
  { name: "Alfa", employees: 3, active: true },
  { name: "Beta", employees: 1, active: false },
  { name: "Gama", employees: 2, active: true },
];

function setup() {
  const registry = new CollectionRegistry();
  registry.register({ name: "firms", source: new MemorySource({ schema, rows }), view });
  const log = { error: vi.fn() };
  return { registry, log, dispatcher: createDispatcher(registry, { log }) };
}

const call = (d: Dispatcher, action: string, payload: unknown, id = "m1") =>
  d.dispatch({ kind: `udc.${action}`, id, payload });

describe("dispatcher on MemorySource", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("registers the phase-1 actions", () => {
    expect(ctx.dispatcher.actions()).toEqual(ACTION_NAMES);
  });

  it("collections lists every registered collection", async () => {
    const res = await call(ctx.dispatcher, "collections", {});
    expect(res).toEqual({
      kind: "udc.collections.ok",
      id: "m1",
      payload: {
        collections: [
          {
            name: "firms",
            default_renderer: "table",
            capabilities: expect.any(Object),
            source_kind: "memory",
            group: "database",
          },
        ],
      },
    });
    expect(ACTIONS.collections.response.safeParse(res.payload).success).toBe(true);
  });

  it("describe returns schema, view with derived columns, and filterable fields", async () => {
    const res = await call(ctx.dispatcher, "describe", { collection: "firms" });
    expect(res.kind).toBe("udc.describe.ok");
    const parsed = ACTIONS.describe.response.safeParse(res.payload);
    expect(parsed.success).toBe(true);
    const p = parsed.data as DescribeResponse;
    expect(p.collection).toBe("firms");
    expect(p.source_kind).toBe("memory");
    expect(p.docs).toBeUndefined();
    expect(p.schema.version).toBe("v1");
    expect(p.view.columns.map((c) => c.field)).toEqual(["name", "employees", "active", "note"]);
    // No view.filterable: every non-deleted field, in field_order.
    expect(p.filterable.fields.map((f) => f.field)).toEqual([
      "name",
      "employees",
      "active",
      "note",
    ]);
    expect(p.filterable.fields[1]).toEqual({
      field: "employees",
      type: "integer",
      ops: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "is_null", "is_not_null"],
      default_op: "eq",
      widget: "number",
    });
  });

  it("list filters, sorts and pages with the view's default page size", async () => {
    const res = await call(ctx.dispatcher, "list", {
      collection: "firms",
      filter: { field: "active", op: "eq", value: true },
      sort: [{ field: "employees", dir: "asc" }],
    });
    const p = res.payload as ListResponse;
    expect(res.kind).toBe("udc.list.ok");
    expect(p.rows.map((r) => r.name)).toEqual(["Gama", "Alfa"]);
    expect(p.total).toBe(2);

    const paged = await call(ctx.dispatcher, "list", { collection: "firms" });
    expect((paged.payload as ListResponse).rows).toHaveLength(2);
    expect((paged.payload as ListResponse).total).toBe(3);
  });

  it("read and mutate round-trip through the source", async () => {
    const ins = await call(ctx.dispatcher, "mutate", {
      collection: "firms",
      op: "insert",
      row: { name: "Delta" },
    });
    expect(ins.kind).toBe("udc.mutate.ok");
    const id = (ins.payload as { row: { __meta: { id: string } } }).row.__meta.id;

    const read = await call(ctx.dispatcher, "read", { collection: "firms", id });
    expect(read).toMatchObject({ kind: "udc.read.ok", payload: { row: { name: "Delta" } } });

    const upd = await call(ctx.dispatcher, "mutate", {
      collection: "firms",
      op: "update",
      id,
      row: { employees: 7 },
      expected_version: 1,
    });
    expect(upd.payload).toMatchObject({
      row: { name: "Delta", employees: 7, __meta: { version: 2 } },
    });

    const conflict = await call(ctx.dispatcher, "mutate", {
      collection: "firms",
      op: "update",
      id,
      row: { employees: 8 },
      expected_version: 1,
    });
    expect(conflict).toEqual({
      kind: "udc.mutate.err",
      id: "m1",
      payload: {
        code: "version_conflict",
        message: expect.any(String),
        details: expect.objectContaining({ current_version: 2 }),
      },
    });

    const del = await call(ctx.dispatcher, "mutate", { collection: "firms", op: "delete", id });
    expect(del.kind).toBe("udc.mutate.ok");
    const gone = await call(ctx.dispatcher, "read", { collection: "firms", id });
    expect(gone.payload).toMatchObject({ code: "not_found" });
  });

  it("answers not_found for an unknown collection", async () => {
    const res = await call(ctx.dispatcher, "describe", { collection: "nope" });
    expect(res).toMatchObject({ kind: "udc.describe.err", payload: { code: "not_found" } });
  });

  it("answers unsupported_op for an unknown action and a non-udc kind", async () => {
    const res = await call(ctx.dispatcher, "explode", {});
    expect(res).toMatchObject({ kind: "udc.explode.err", payload: { code: "unsupported_op" } });
    const odd = await ctx.dispatcher.dispatch({ kind: "list", id: "x", payload: {} });
    expect(odd.payload).toMatchObject({ code: "unsupported_op" });
  });

  it("answers validation_error with the Zod issues for a bad payload", async () => {
    const res = await call(ctx.dispatcher, "list", { collection: "firms", page: { limit: 0 } });
    expect(res.kind).toBe("udc.list.err");
    const p = res.payload as { code: string; details: { issues: { path: unknown[] }[] } };
    expect(p.code).toBe("validation_error");
    expect(p.details.issues[0]?.path).toEqual(["page", "limit"]);
  });

  it("hides an unexpected exception behind internal and logs it", async () => {
    ctx.dispatcher.register("boom", ACTIONS.collections.request, () => {
      throw new Error("secret connection string");
    });
    const res = await call(ctx.dispatcher, "boom", {});
    expect(res).toEqual({
      kind: "udc.boom.err",
      id: "m1",
      payload: { code: "internal", message: "internal error" },
    });
    expect(ctx.log.error).toHaveBeenCalledOnce();
  });

  it.each([
    ["schema.add_field", { name: "web", fielddef: { type: "string" }, position: { where: "end" } }],
    ["schema.update_field", { name: "name", fielddef: { type: "string" } }],
    ["schema.soft_delete_field", { field: "note" }],
  ])(
    "refuses %s with unsupported_op when the source cannot edit its schema",
    async (action, payload) => {
      const res = await call(ctx.dispatcher, action, { collection: "firms", ...payload });
      expect(res.kind).toBe(`udc.${action}.err`);
      expect(res.payload).toMatchObject({ code: "unsupported_op" });
      expect((res.payload as { message: string }).message).toMatch(/schema_edit/);
    },
  );

  it("validates schema.* payloads before asking the source", async () => {
    const res = await call(ctx.dispatcher, "schema.add_field", {
      collection: "firms",
      name: "Bad Name",
      fielddef: { type: "string" },
      position: { where: "end" },
    });
    expect(res.payload).toMatchObject({ code: "validation_error" });
  });

  it("describe hides soft-deleted fields from the schema", async () => {
    const res = await call(ctx.dispatcher, "describe", { collection: "firms" });
    const p = res.payload as DescribeResponse;
    expect(p.schema.fields.old).toBeUndefined();
    expect(p.schema.field_order).toEqual(["name", "employees", "active", "note"]);
  });

  it("passes a UdcError thrown by a handler through as-is", async () => {
    ctx.dispatcher.register("deny", ACTIONS.collections.request, () => {
      throw new UdcError("forbidden", "no", { why: "test" });
    });
    const res: UdcMessage = await call(ctx.dispatcher, "deny", {});
    expect(res.payload).toEqual({ code: "forbidden", message: "no", details: { why: "test" } });
  });

  it("makes a new action a one-line registration", async () => {
    const d = new Dispatcher({ log: ctx.log });
    d.register("ping", ACTIONS.collections.request, () => ({ pong: true }));
    expect(d.has("ping")).toBe(true);
    expect(await call(d, "ping", {})).toEqual({
      kind: "udc.ping.ok",
      id: "m1",
      payload: { pong: true },
    });
  });
});

describe("reindex action", () => {
  const orderSchema = SchemaDocSchema.parse({
    version: "v1",
    fields: { title: { type: "string" }, lane: { type: "string" }, order: { type: "integer" } },
  });

  function withSources() {
    const registry = new CollectionRegistry();
    registry.register({
      name: "cards",
      source: new MemorySource({
        schema: orderSchema,
        rows: [
          { title: "x", lane: "l", order: 5 },
          { title: "y", lane: "l", order: 6 },
        ],
      }),
      view,
    });
    const readOnly = new MemorySource({ schema: orderSchema });
    Object.assign(readOnly, { capabilities: { ...readOnly.capabilities, reindex: false } });
    registry.register({ name: "frozen", source: readOnly, view });
    return createDispatcher(registry, { log: { error: vi.fn() } });
  }

  it("renumbers and answers the count", async () => {
    const d = withSources();
    const res = await call(d, "reindex", { collection: "cards", scope: { lane: "l" } });
    expect(res).toMatchObject({ kind: "udc.reindex.ok", payload: { updated: 2 } });
    const list = await call(d, "list", { collection: "cards", sort: [{ field: "order" }] });
    expect((list.payload as ListResponse).rows.map((r) => r.order)).toEqual([100, 200]);
  });

  it("is unsupported where the capability is off", async () => {
    const res = await call(withSources(), "reindex", { collection: "frozen", scope: {} });
    expect(res).toMatchObject({ kind: "udc.reindex.err", payload: { code: "unsupported_op" } });
  });

  it("validates the payload", async () => {
    const res = await call(withSources(), "reindex", { collection: "cards", scope: { lane: [1] } });
    expect(res).toMatchObject({ kind: "udc.reindex.err", payload: { code: "validation_error" } });
  });
});

describe("tree.reparent action", () => {
  const treeSchema = SchemaDocSchema.parse({
    version: "v1",
    fields: {
      name: { type: "string" },
      parent_id: { type: "string" },
      order: { type: "integer" },
      depth: { type: "integer" },
    },
  });
  const A = "00000000-0000-4000-8000-00000000000a";
  const B = "00000000-0000-4000-8000-00000000000b";
  const fields = { parent_field: "parent_id", order_field: "order", depth_field: "depth" };

  function withSources() {
    const registry = new CollectionRegistry();
    const rows = [
      { __meta: { id: A }, name: "a", parent_id: null, order: 100, depth: 0 },
      { __meta: { id: B }, name: "b", parent_id: null, order: 200, depth: 0 },
    ];
    registry.register({
      name: "org",
      source: new MemorySource({ schema: treeSchema, rows }),
      view,
    });
    const flat = new MemorySource({ schema: treeSchema, rows });
    Object.assign(flat, { capabilities: { ...flat.capabilities, tree_reparent: false } });
    registry.register({ name: "flat", source: flat, view });
    return createDispatcher(registry, { log: { error: vi.fn() } });
  }

  it("moves the node and answers the row and the count", async () => {
    const res = await call(withSources(), "tree.reparent", {
      collection: "org",
      id: B,
      parent: A,
      order: 100,
      fields,
    });
    expect(res).toMatchObject({
      kind: "udc.tree.reparent.ok",
      payload: { row: { __meta: { id: B, version: 2 }, parent_id: A, depth: 1 }, updated: 1 },
    });
  });

  it("is unsupported where the capability is off", async () => {
    const res = await call(withSources(), "tree.reparent", {
      collection: "flat",
      id: B,
      parent: A,
      order: 1,
      fields,
    });
    expect(res).toMatchObject({ payload: { code: "unsupported_op" } });
  });

  it("refuses a cycle and a bad payload", async () => {
    const d = withSources();
    const cycle = await call(d, "tree.reparent", {
      collection: "org",
      id: A,
      parent: A,
      order: 1,
      fields,
    });
    expect(cycle).toMatchObject({ payload: { code: "validation_error" } });
    const bad = await call(d, "tree.reparent", { collection: "org", id: A, order: 1, fields });
    expect(bad).toMatchObject({ payload: { code: "validation_error" } });
  });
});
