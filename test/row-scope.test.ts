// Two request contexts (tenants `a` and `b`) over one `message` collection, held to
// `tenant = <ctx.tenant>` by the dispatcher's `rowScope`: on postgres_jsonb (the scope in
// the SQL) and on memory (the generic layer alone), through the HTTP plugin. The
// no-database project (`npm run test:no-db`, UDC_TEST_NO_DB=1) runs the memory backend
// alone and never loads `pg`.
import {
  type DescribeResponse,
  type FilterNode,
  type Row,
  type SchemaDocInput,
  SchemaDocSchema,
  UdcError,
  unauthenticatedError,
  ViewConfigSchema,
} from "@jsudc/core";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { Described } from "../src/describe.js";
import { createDispatcher } from "../src/dispatcher.js";
import { CollectionRegistry } from "../src/registry.js";
import { MemorySource } from "../src/sources/memory.js";
import type { Source } from "../src/sources/source.js";

const schemaJson: SchemaDocInput = {
  version: "v1",
  fields: {
    tenant: { type: "string" },
    subject: { type: "string", required: true },
    folder: { type: "string" },
    size: { type: "integer" },
    order: { type: "integer" },
    parent_id: { type: "string" },
    depth: { type: "integer" },
    children_count: { type: "integer" },
    ancestor_ids: { type: "json" },
  },
};
const schema = SchemaDocSchema.parse(schemaJson);

const view = ViewConfigSchema.parse({
  columns: [{ field: "subject" }, { field: "tenant" }, { field: "folder" }],
  search: { fields: ["subject", "tenant"] },
  filters: [
    { field: "tenant", kind: "select" },
    { field: "folder", kind: "select" },
  ],
  filterable: { fields: ["tenant", "subject"] },
});

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ID = { a1: uuid(1), a2: uuid(2), a3: uuid(3), b1: uuid(11), b2: uuid(12), b3: uuid(13) };
const MISSING = uuid(99);

const tree = { parent_id: null, depth: 0, ancestor_ids: [], children_count: 0 };
// b3 hangs under a1 (data a host's bug could produce): the SQL keeps every tree statement
// inside the scope, so a's moves never count or touch it.
const ROWS = [
  {
    id: ID.a1,
    tenant: "a",
    subject: "alpha",
    folder: "inbox",
    size: 10,
    order: 300,
    ...tree,
    children_count: 1,
  },
  { id: ID.a2, tenant: "a", subject: "beta", folder: "inbox", size: 20, order: 100, ...tree },
  { id: ID.a3, tenant: "a", subject: "gamma", folder: "sent", size: 30, order: 200, ...tree },
  { id: ID.b1, tenant: "b", subject: "alpha", folder: "inbox", size: 10, order: 300, ...tree },
  { id: ID.b2, tenant: "b", subject: "delta", folder: "inbox", size: 20, order: 100, ...tree },
  {
    id: ID.b3,
    tenant: "b",
    subject: "omega",
    folder: "sent",
    size: 30,
    order: 200,
    ...tree,
    parent_id: ID.a1,
    depth: 1,
    ancestor_ids: [ID.a1],
  },
];
const A_IDS = [ID.a1, ID.a2, ID.a3];
const B_IDS = [ID.b1, ID.b2, ID.b3];

interface Ctx {
  tenant: string | null;
  maxSize?: number;
  schemaAdmin?: boolean;
}

/** `x-tenant` names the tenant (`admin`: no scope); none is not signed in. */
function context(request: FastifyRequest): Ctx {
  const tenant = request.headers["x-tenant"];
  if (typeof tenant !== "string") throw unauthenticatedError();
  if (tenant === "banned") throw new UdcError("forbidden", "this tenant is suspended");
  if (tenant === "crash") throw new Error("db password=hunter2");
  const max = request.headers["x-max-size"];
  return {
    tenant: tenant === "admin" ? null : tenant,
    ...(typeof max === "string" ? { maxSize: Number(max) } : {}),
    ...(request.headers["x-schema-admin"] === "1" ? { schemaAdmin: true } : {}),
  };
}

function rowScope(ctx: Ctx, collection: string): FilterNode | undefined {
  if (!collection.startsWith("message") || ctx.tenant === null) return undefined;
  const tenant: FilterNode = { field: "tenant", op: "eq", value: ctx.tenant };
  return ctx.maxSize === undefined
    ? tenant
    : { and: [tenant, { field: "size", op: "lt", value: ctx.maxSize }] };
}

const memoryRows = () => ROWS.map(({ id, ...data }) => ({ __meta: { id }, ...data }));

interface Backend {
  name: "postgres_jsonb" | "memory";
  /** The sources of `message` and `message_shown` (one table, or two copies of the rows). */
  make(): Promise<{ message: Source; shown: Source }>;
}

/** The Postgres backend: its modules (and `pg`) are loaded only when a database is there. */
async function postgresBackend(): Promise<Backend> {
  const { sql } = await import("drizzle-orm");
  const { createCollectionTableSql } = await import("../src/db/schema.js");
  const { PostgresJsonbSource } = await import("../src/sources/postgres-jsonb.js");
  const { useTestDb } = await import("./helpers.js");
  const { db } = useTestDb();
  let created = false;
  return {
    name: "postgres_jsonb",
    async make() {
      if (!created) {
        await db.execute(sql.raw(createCollectionTableSql("message")));
        created = true;
      }
      await db.execute(sql`truncate table message, udc_schema_revisions restart identity`);
      await db.execute(sql`
        insert into message (id, data)
        select (value->>'id')::uuid, value - 'id'
        from jsonb_array_elements(${JSON.stringify(ROWS)}::jsonb)`);
      const pg = () => new PostgresJsonbSource({ db, table: "message", initialSchema: schema });
      return { message: pg(), shown: pg() };
    },
  };
}

const BACKENDS: Backend[] = [
  ...(process.env.UDC_TEST_NO_DB === "1" ? [] : [await postgresBackend()]),
  {
    name: "memory",
    async make() {
      return {
        message: new MemorySource({ schema, rows: memoryRows() }),
        shown: new MemorySource({ schema, rows: memoryRows() }),
      };
    },
  },
];

describe.each(BACKENDS)("row scope on $name", (backend) => {
  let app: FastifyInstance;
  const log = { error: vi.fn() };

  beforeEach(async () => {
    const { message, shown } = await backend.make();
    const registry = new CollectionRegistry();
    registry.register({ name: "message", source: message, view });
    registry.register({ name: "message_shown", source: shown, view });
    const dispatcher = createDispatcher<Ctx>(registry, {
      log,
      rowScope,
      access: (ctx, { action }) =>
        ctx.schemaAdmin && (action.startsWith("schema.") || action === "source.read")
          ? true
          : undefined,
      showScopeFields: ["message_shown"],
    });
    app = await buildApp({ dispatcher, context, swagger: false, checkLinks: false });
    await app.ready();
  });

  afterEach(() => app.close());

  async function call(tenant: string | null, action: string, payload: object, more = {}) {
    const headers: Record<string, string> = { ...more };
    if (tenant !== null) headers["x-tenant"] = tenant;
    const res = await app.inject({ method: "POST", url: `/udc/${action}`, payload, headers });
    expect(res.statusCode).toBe(200);
    return res.json() as { kind: string; payload: Record<string, unknown> };
  }

  async function ok<T = Record<string, unknown>>(
    tenant: string,
    action: string,
    payload: object,
    more = {},
  ): Promise<T> {
    const res = await call(tenant, action, payload, more);
    expect(res.kind, JSON.stringify(res.payload)).toBe(`udc.${action}.ok`);
    return res.payload as T;
  }

  async function err(tenant: string | null, action: string, payload: object, more = {}) {
    const res = await call(tenant, action, payload, more);
    expect(res.kind, JSON.stringify(res.payload)).toBe(`udc.${action}.err`);
    return res.payload as { code: string; message: string; details?: Record<string, unknown> };
  }

  type List = { rows: Row[]; total: number; next_cursor: string | null };
  const list = (tenant: string, payload: object, collection = "message") =>
    ok<List>(tenant, "list", { collection, ...payload });
  const ids = (rows: Row[]) => rows.map((r) => r.__meta.id).sort();
  /** Every row of `collection` as the unscoped admin sees it. */
  const all = async (collection = "message") =>
    (await list("admin", { page: { limit: 100 } }, collection)).rows;
  /** A row as stored, scope field included (the admin is unscoped, so nothing is hidden). */
  const raw = async (id: string, collection = "message") =>
    (await all(collection)).find((r) => r.__meta.id === id);

  describe("list", () => {
    it("shows each context only its own rows, the total counted in scope", async () => {
      const a = await list("a", {});
      const b = await list("b", {});
      expect(ids(a.rows)).toEqual(A_IDS);
      expect(a.total).toBe(3);
      expect(ids(b.rows)).toEqual(B_IDS);
      expect(b.total).toBe(3);
      expect((await all()).length).toBe(6);
    });

    it("leaves the scope field out of the rows", async () => {
      const { rows } = await list("a", {});
      for (const row of rows) expect(row).not.toHaveProperty("tenant");
      expect((await list("a", {}, "message_shown")).rows[0]).toHaveProperty("tenant", "a");
    });

    it("answers a filter or sort on the hidden scope field like an unknown field", async () => {
      const unknown = await err("a", "list", {
        collection: "message",
        filter: { field: "nope", op: "eq", value: "b" },
      });
      const hidden = await err("a", "list", {
        collection: "message",
        filter: { or: [{ field: "tenant", op: "eq", value: "b" }] },
      });
      expect(hidden).toEqual(JSON.parse(JSON.stringify(unknown).replaceAll("nope", "tenant")));
      expect(hidden.code).toBe("validation_error");
      const sort = await err("a", "list", { collection: "message", sort: [{ field: "tenant" }] });
      expect(sort).toMatchObject({ code: "validation_error", details: { field: "tenant" } });
    });

    it("ANDs a client filter naming a visible scope field with the scope", async () => {
      const lists = [
        { field: "tenant", op: "eq", value: "b" },
        {
          or: [
            { field: "tenant", op: "eq", value: "b" },
            { field: "subject", op: "eq", value: "alpha" },
          ],
        },
        { not: { field: "tenant", op: "eq", value: "a" } },
        { not: { not: { field: "tenant", op: "neq", value: "a" } } },
        { field: "tenant", op: "in", value: ["a", "b"] },
      ].map((filter) => list("a", { filter }, "message_shown"));
      const [eqB, orB, notA, notNotB, inAB] = await Promise.all(lists);
      expect(eqB).toMatchObject({ rows: [], total: 0 });
      expect(ids(orB?.rows ?? [])).toEqual([ID.a1]);
      expect(notA).toMatchObject({ rows: [], total: 0 });
      expect(notNotB).toMatchObject({ rows: [], total: 0 });
      expect(ids(inAB?.rows ?? [])).toEqual(A_IDS);
    });

    it("sorts inside the scope, on a visible scope field too", async () => {
      const bySubject = await list("b", { sort: [{ field: "subject", dir: "desc" }] });
      expect(bySubject.rows.map((r) => r.subject)).toEqual(["omega", "delta", "alpha"]);
      const byTenant = await list("a", { sort: [{ field: "tenant" }] }, "message_shown");
      expect(ids(byTenant.rows)).toEqual(A_IDS);
    });

    it("pages by offset inside the scope", async () => {
      const page = await list("a", { sort: [{ field: "order" }], page: { limit: 2, offset: 2 } });
      expect(page.rows.map((r) => r.__meta.id)).toEqual([ID.a1]);
      expect(page.total).toBe(3);
    });

    it("pages by cursor inside the scope (postgres_jsonb)", async () => {
      if (backend.name !== "postgres_jsonb") return;
      const first = await list("b", { sort: [{ field: "order" }], page: { limit: 2 } });
      expect(first.rows.map((r) => r.__meta.id)).toEqual([ID.b2, ID.b3]);
      expect(first.next_cursor).not.toBeNull();
      const second = await list("b", {
        sort: [{ field: "order" }],
        page: { limit: 2, cursor: first.next_cursor },
      });
      expect(second.rows.map((r) => r.__meta.id)).toEqual([ID.b1]);
      expect(second.next_cursor).toBeNull();
      expect(second.total).toBe(3);
    });

    it("resolves a lookup-style `in` on the other's ids to nothing", async () => {
      const res = await list("a", { filter: { field: "id", op: "in", value: B_IDS } });
      expect(res).toMatchObject({ rows: [], total: 0 });
      const own = await list("a", { filter: { field: "id", op: "in", value: [ID.a2, ID.b2] } });
      expect(ids(own.rows)).toEqual([ID.a2]);
    });
  });

  describe("read", () => {
    it("reads an own row without its scope field", async () => {
      const { row } = await ok<{ row: Row }>("a", "read", { collection: "message", id: ID.a1 });
      expect(row).toMatchObject({ __meta: { id: ID.a1 }, subject: "alpha" });
      expect(row).not.toHaveProperty("tenant");
    });

    it("answers a row of the other context exactly as a missing id", async () => {
      const missing = await err("a", "read", { collection: "message", id: MISSING });
      const other = await err("a", "read", { collection: "message", id: ID.b1 });
      expect(missing.code).toBe("not_found");
      expect(other).toEqual(JSON.parse(JSON.stringify(missing).replaceAll(MISSING, ID.b1)));
      expect(await err("b", "read", { collection: "message_shown", id: ID.a2 })).toMatchObject({
        code: "not_found",
      });
    });
  });

  describe("mutate", () => {
    it("writes the scope value into an insert, over a forged one", async () => {
      const { row } = await ok<{ row: Row }>("a", "mutate", {
        collection: "message_shown",
        op: "insert",
        row: { subject: "forged", tenant: "b" },
      });
      expect(row.tenant).toBe("a");
      expect((await raw(row.__meta.id, "message_shown"))?.tenant).toBe("a");
      expect(ids((await list("b", {}, "message_shown")).rows)).toEqual(B_IDS);
    });

    it("refuses the hidden scope field in a row like an unknown field, and pins it", async () => {
      const unknown = await err("a", "mutate", {
        collection: "message",
        op: "insert",
        row: { subject: "x", nope: "b" },
      });
      const hidden = await err("a", "mutate", {
        collection: "message",
        op: "insert",
        row: { subject: "x", tenant: "b" },
      });
      expect(hidden).toEqual(JSON.parse(JSON.stringify(unknown).replaceAll("nope", "tenant")));
      const { row } = await ok<{ row: Row }>("b", "mutate", {
        collection: "message",
        op: "insert",
        row: { subject: "mine" },
      });
      expect(row).not.toHaveProperty("tenant");
      expect((await raw(row.__meta.id))?.tenant).toBe("b");
      expect((await list("a", {})).total).toBe(3);
    });

    it("answers an update or delete of the other's row as a missing id, writing nothing", async () => {
      const before = await raw(ID.b1);
      const missing = await err("a", "mutate", {
        collection: "message",
        op: "update",
        id: MISSING,
        row: { subject: "x" },
      });
      for (const op of [
        { op: "update", row: { subject: "hacked" } },
        { op: "update", row: { subject: "hacked" }, expected_version: 1 },
        { op: "update", row: { subject: "hacked" }, expected_version: 7 },
        { op: "delete" },
        { op: "delete", expected_version: 7 },
      ]) {
        const e = await err("a", "mutate", { collection: "message", id: ID.b1, ...op });
        expect(e).toEqual(JSON.parse(JSON.stringify(missing).replaceAll(MISSING, ID.b1)));
      }
      expect(await raw(ID.b1)).toEqual(before);
    });

    it("cannot move a row out of its scope with a patch", async () => {
      const { row } = await ok<{ row: Row }>("a", "mutate", {
        collection: "message_shown",
        op: "update",
        id: ID.a1,
        row: { tenant: "b", subject: "moved?" },
      });
      expect(row).toMatchObject({ tenant: "a", subject: "moved?" });
      expect(ids((await list("b", {}, "message_shown")).rows)).toEqual(B_IDS);
      const hidden = await err("a", "mutate", {
        collection: "message",
        op: "update",
        id: ID.a1,
        row: { tenant: "b" },
      });
      expect(hidden.code).toBe("validation_error");
      expect((await raw(ID.a1, "message_shown"))?.tenant).toBe("a");
      expect((await raw(ID.a1))?.tenant).toBe("a");
    });

    it("updates and deletes own rows", async () => {
      const { row } = await ok<{ row: Row }>("a", "mutate", {
        collection: "message",
        op: "update",
        id: ID.a2,
        row: { subject: "beta 2" },
        expected_version: 1,
      });
      expect(row).toMatchObject({ __meta: { id: ID.a2, version: 2 }, subject: "beta 2" });
      expect(row).not.toHaveProperty("tenant");
      const conflict = await err("a", "mutate", {
        collection: "message",
        op: "update",
        id: ID.a2,
        row: { subject: "x" },
        expected_version: 1,
      });
      expect(conflict.code).toBe("version_conflict");
      await ok("a", "mutate", { collection: "message", op: "delete", id: ID.a3 });
      expect(ids((await list("a", {})).rows)).toEqual([ID.a1, ID.a2]);
      expect((await list("b", {})).total).toBe(3);
    });

    it("refuses with forbidden a row that would fall outside a non-eq part of the scope", async () => {
      const small = { "x-max-size": "25" };
      // `size` is a scope field as well, hidden on `message`: shown here.
      const insert = await err(
        "a",
        "mutate",
        { collection: "message_shown", op: "insert", row: { subject: "big", size: 500 } },
        small,
      );
      expect(insert.code, JSON.stringify(insert)).toBe("forbidden");
      const update = await err(
        "a",
        "mutate",
        { collection: "message_shown", op: "update", id: ID.a1, row: { size: 500 } },
        small,
      );
      expect(update.code).toBe("forbidden");
      expect(await raw(ID.a1, "message_shown")).toMatchObject({ size: 10, __meta: { version: 1 } });
      // a3 (size 30) is outside this scope: not found, like b's rows.
      const outside = await err(
        "a",
        "mutate",
        { collection: "message_shown", op: "delete", id: ID.a3 },
        small,
      );
      expect(outside.code).toBe("not_found");
      expect((await all("message_shown")).length).toBe(6);
      const fine = await ok<{ row: Row }>(
        "a",
        "mutate",
        { collection: "message_shown", op: "insert", row: { subject: "small", size: 5 } },
        small,
      );
      expect((await raw(fine.row.__meta.id, "message_shown"))?.tenant).toBe("a");
    });
  });

  describe("reindex", () => {
    it("renumbers only the rows of both scopes", async () => {
      const res = await ok<{ updated: number }>("a", "reindex", {
        collection: "message",
        scope: { folder: "inbox" },
      });
      expect(res.updated).toBe(2);
      const rows = await all();
      const by = (id: string) => rows.find((r) => r.__meta.id === id);
      expect(by(ID.a2)).toMatchObject({ order: 100, __meta: { version: 2 } });
      expect(by(ID.a1)).toMatchObject({ order: 200, __meta: { version: 2 } });
      expect(by(ID.a3)).toMatchObject({ order: 200, __meta: { version: 1 } });
      for (const id of B_IDS) expect(by(id)?.__meta.version).toBe(1);
      expect(by(ID.b1)?.order).toBe(300);
    });

    it("refuses the hidden scope field, renumbers nothing for the other's value", async () => {
      const hidden = await err("a", "reindex", { collection: "message", scope: { tenant: "b" } });
      expect(hidden).toMatchObject({ code: "validation_error", details: { field: "tenant" } });
      const other = await ok<{ updated: number }>("a", "reindex", {
        collection: "message_shown",
        scope: { tenant: "b" },
      });
      expect(other.updated).toBe(0);
      for (const r of await all()) expect(r.__meta.version).toBe(1);
    });

    it("holds a scope that is not only eq conditions (SQL) or refuses it (generic)", async () => {
      const small = { "x-max-size": "25" };
      const payload = { collection: "message", scope: { folder: "inbox" } };
      if (backend.name === "postgres_jsonb") {
        const res = await ok<{ updated: number }>("b", "reindex", payload, small);
        expect(res.updated).toBe(2);
      } else {
        expect((await err("b", "reindex", payload, small)).code).toBe("forbidden");
      }
      expect((await raw(ID.a1))?.__meta.version).toBe(1);
    });
  });

  describe("tree.reparent", () => {
    const fields = {
      parent_field: "parent_id",
      order_field: "order",
      depth_field: "depth",
      ancestor_ids_field: "ancestor_ids",
      children_count_field: "children_count",
    };
    const reparent = (tenant: string, id: string, parent: string | null) =>
      call(tenant, "tree.reparent", { collection: "message", id, parent, order: 50, fields });

    it("answers not_found for a node or a new parent outside the scope", async () => {
      const node = await reparent("a", ID.b2, null);
      const parent = await reparent("a", ID.a2, ID.b1);
      expect(node.payload).toMatchObject({ code: "not_found", details: { id: ID.b2 } });
      expect(parent.payload).toMatchObject({ code: "not_found", details: { id: ID.b1 } });
      for (const r of await all()) expect(r.__meta.version).toBe(1);
    });

    it("moves an own node, its parent's children counted inside the scope", async () => {
      const res = await reparent("a", ID.a3, ID.a1);
      expect(res.kind).toBe("udc.tree.reparent.ok");
      expect(res.payload.row).not.toHaveProperty("tenant");
      const a1 = await raw(ID.a1);
      // b3 also points at a1; only postgres_jsonb keeps the recount inside the scope.
      expect(a1?.children_count).toBe(backend.name === "postgres_jsonb" ? 1 : 2);
      expect(await raw(ID.a3)).toMatchObject({ parent_id: ID.a1, depth: 1 });
      expect((await raw(ID.b3))?.__meta.version).toBe(1);
    });

    it("restructures only the in-scope part of a subtree (postgres_jsonb)", async () => {
      if (backend.name !== "postgres_jsonb") return;
      const res = await reparent("a", ID.a1, ID.a2);
      expect(res.kind).toBe("udc.tree.reparent.ok");
      expect(await raw(ID.b3)).toMatchObject({
        depth: 1,
        ancestor_ids: [ID.a1],
        __meta: { version: 1 },
      });
      expect(await raw(ID.a1)).toMatchObject({ parent_id: ID.a2, depth: 1 });
    });
  });

  describe("describe, collections, schema edits", () => {
    it("hides the scope field from describe", async () => {
      const d = await ok<DescribeResponse>("a", "describe", { collection: "message" });
      const text = JSON.stringify({
        fields: Object.keys(d.schema.fields),
        order: d.schema.field_order,
        columns: d.view.columns?.map((c) => c.field),
        search: d.view.search?.fields,
        filters: d.view.filters?.map((f) => f.field),
        viewFilterable: d.view.filterable?.fields,
        filterable: d.filterable.fields.map((f) => f.field),
        sortable: (d as Described).sortable?.fields,
      });
      expect((d as Described).sortable?.fields).toContain("subject");
      expect(JSON.parse(text)).toMatchObject({ search: ["subject"], filters: ["folder"] });
      expect(d.view.columns?.slice(0, 2).map((c) => c.field)).toEqual(["subject", "folder"]);
      expect(text).not.toContain("tenant");
      expect(text).toContain("subject");
      for (const [tenant, collection] of [
        ["a", "message_shown"],
        ["admin", "message"],
      ] as const) {
        const shown = await ok<{ schema: { fields: object } }>(tenant, "describe", { collection });
        expect(shown.schema.fields).toHaveProperty("tenant");
      }
    });

    it("refuses schema edits and source.read on a scoped collection, and says so", async () => {
      const add = {
        collection: "message",
        name: "extra",
        fielddef: { type: "string" },
        position: { where: "end" },
      };
      const edits: [string, object][] = [
        ["schema.add_field", add],
        [
          "schema.update_field",
          { collection: "message", name: "subject", fielddef: { type: "text" } },
        ],
        ["schema.soft_delete_field", { collection: "message", field: "folder" }],
        ["source.read", { collection: "message" }],
      ];
      for (const [action, payload] of edits) {
        const e = await err("a", action, payload);
        expect(e, action).toMatchObject({ code: "forbidden", details: { action } });
      }
      const d = await ok<{ capabilities: Record<string, unknown> }>("a", "describe", {
        collection: "message",
      });
      expect(d.capabilities).toMatchObject({ schema_edit: false, source_yaml: false });
      const { collections } = await ok<{ collections: { name: string; capabilities: object }[] }>(
        "a",
        "collections",
        {},
      );
      for (const c of collections) {
        expect(c.capabilities).toMatchObject({ schema_edit: false, source_yaml: false });
      }
      // Unscoped (admin), and a scoped context `access` lets through, edit the schema as before.
      const pg = backend.name === "postgres_jsonb";
      const admin = await ok<{ capabilities: { schema_edit: boolean } }>("admin", "describe", {
        collection: "message",
      });
      expect(admin.capabilities.schema_edit).toBe(pg);
      const granted = await call("a", "schema.add_field", add, { "x-schema-admin": "1" });
      expect(granted.kind).toBe(pg ? "udc.schema.add_field.ok" : "udc.schema.add_field.err");
      if (!pg) expect(granted.payload.code).toBe("unsupported_op");
      const grantedDescribe = await ok<{ capabilities: { schema_edit: boolean } }>(
        "a",
        "describe",
        { collection: "message" },
        { "x-schema-admin": "1" },
      );
      expect(grantedDescribe.capabilities.schema_edit).toBe(pg);
    });
  });

  describe("context", () => {
    it("answers a request without a session with forbidden / unauthenticated, in-protocol", async () => {
      const e = await err(null, "list", { collection: "message" });
      expect(e).toEqual({
        code: "forbidden",
        message: "not signed in",
        details: { reason: "unauthenticated" },
      });
      expect(await err("banned", "read", { collection: "message", id: ID.a1 })).toEqual({
        code: "forbidden",
        message: "this tenant is suspended",
      });
    });

    it("answers a context that crashes with internal, its message not leaked", async () => {
      const res = await call("crash", "list", { collection: "message" });
      expect(res).toMatchObject({
        kind: "udc.list.err",
        payload: { code: "internal", message: "internal error" },
      });
      expect(JSON.stringify(res)).not.toContain("hunter2");
    });
  });
});
