// The change feed's scope rule, end to end: two tenants (`a`, `b`) and an admin stream over
// HTTP (core's `UdcClient.changes`), a scoped `chg_message` collection (`tenant = <ctx>`)
// and an unscoped `chg_note`, on postgres_jsonb, postgres_table and memory.
import {
  type FilterNode,
  type SchemaDocInput,
  SchemaDocSchema,
  UdcError,
  unauthenticatedError,
  ViewConfigSchema,
} from "@jsudc/core";
import { sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { type ChangeFeed, createChangeFeed } from "../src/changes.js";
import { createCollectionTableSql } from "../src/db/schema.js";
import { createDispatcher } from "../src/dispatcher.js";
import { CollectionRegistry } from "../src/registry.js";
import { MemorySource } from "../src/sources/memory.js";
import { PostgresJsonbSource } from "../src/sources/postgres-jsonb.js";
import { PostgresTableSource } from "../src/sources/postgres-table.js";
import type { Source } from "../src/sources/source.js";
import { listen, type OpenStream, openStream, received } from "./changes-helpers.js";
import { useTestDb } from "./helpers.js";

const schema = SchemaDocSchema.parse({
  version: "v1",
  fields: {
    tenant: { type: "string" },
    subject: { type: "string", required: true },
    order: { type: "integer" },
  },
} satisfies SchemaDocInput);
const noteSchema = SchemaDocSchema.parse({
  version: "v1",
  fields: { text: { type: "string", required: true } },
} satisfies SchemaDocInput);
const view = ViewConfigSchema.parse({ columns: [{ field: "subject" }] });

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ID = { a1: uuid(1), a2: uuid(2), b1: uuid(11), b2: uuid(12) };
const ROWS = [
  { id: ID.a1, tenant: "a", subject: "alpha", order: 1 },
  { id: ID.a2, tenant: "a", subject: "beta", order: 2 },
  { id: ID.b1, tenant: "b", subject: "gamma", order: 1 },
  { id: ID.b2, tenant: "b", subject: "delta", order: 2 },
];

interface Ctx {
  tenant: string | null;
}

/** `x-tenant` names the tenant (`admin`: no scope); none is not signed in. */
function context(request: FastifyRequest): Ctx {
  const tenant = request.headers["x-tenant"];
  if (typeof tenant !== "string") throw unauthenticatedError();
  if (tenant === "banned") throw new UdcError("forbidden", "suspended");
  return { tenant: tenant === "admin" ? null : tenant };
}

function rowScope(ctx: Ctx, collection: string): FilterNode | undefined {
  if (collection !== "chg_message" || ctx.tenant === null) return undefined;
  return { field: "tenant", op: "eq", value: ctx.tenant };
}

const { db } = useTestDb();

beforeAll(async () => {
  await db.execute(sql.raw(createCollectionTableSql("chg_message")));
  await db.execute(sql`DROP TABLE IF EXISTS chg_table_message`);
  await db.execute(sql`
    CREATE TABLE chg_table_message (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant text,
      subject text NOT NULL,
      "order" integer,
      row_version integer NOT NULL DEFAULT 1)`);
});

interface Backend {
  name: string;
  make(): Promise<Source>;
}

const BACKENDS: Backend[] = [
  {
    name: "postgres_jsonb",
    async make() {
      await db.execute(sql`truncate table chg_message`);
      await db.execute(sql`
        insert into chg_message (id, data)
        select (value->>'id')::uuid, value - 'id'
        from jsonb_array_elements(${JSON.stringify(ROWS)}::jsonb)`);
      return new PostgresJsonbSource({ db, table: "chg_message", initialSchema: schema });
    },
  },
  {
    name: "postgres_table",
    async make() {
      await db.execute(sql`truncate table chg_table_message`);
      for (const r of ROWS) {
        await db.execute(sql`
          insert into chg_table_message (id, tenant, subject, "order")
          values (${r.id}::uuid, ${r.tenant}, ${r.subject}, ${r.order})`);
      }
      return new PostgresTableSource({
        db,
        schema,
        table: "chg_table_message",
        versionColumn: "row_version",
      });
    },
  },
  {
    name: "memory",
    async make() {
      return new MemorySource({
        schema,
        rows: ROWS.map(({ id, ...data }) => ({ __meta: { id }, ...data })),
      });
    },
  },
];

describe.each(BACKENDS)("the scope rule on $name", (backend) => {
  let app: FastifyInstance;
  let feed: ChangeFeed;
  let base: string;
  const streams: OpenStream[] = [];

  beforeEach(async () => {
    const registry = new CollectionRegistry();
    registry.register({ name: "chg_message", source: await backend.make(), view });
    registry.register({ name: "chg_note", source: new MemorySource({ schema: noteSchema }), view });
    feed = createChangeFeed({ coalesce: false });
    const dispatcher = createDispatcher<Ctx>(registry, {
      log: { error: vi.fn() },
      rowScope,
      changes: feed,
    });
    app = await buildApp({ dispatcher, registry, context, swagger: false, checkLinks: false });
    base = await listen(app);
  });

  afterEach(async () => {
    for (const s of streams.splice(0)) await s.stop();
    await app.close();
    await feed.close();
  });

  async function stream(tenant: string, collections = ["chg_message", "chg_note"]) {
    const s = await openStream(base, collections, { "x-tenant": tenant });
    streams.push(s);
    return s;
  }

  async function call(tenant: string, action: string, payload: object) {
    const res = await app.inject({
      method: "POST",
      url: `/udc/${action}`,
      payload,
      headers: { "x-tenant": tenant },
    });
    const body = res.json() as { kind: string; payload: Record<string, unknown> };
    expect(body.kind, JSON.stringify(body.payload)).toBe(`udc.${action}.ok`);
    return body.payload;
  }

  /** A note every stream receives: what a stream got before it is all it will get. */
  async function sentinel(...all: OpenStream[]) {
    const { row } = (await call("admin", "mutate", {
      collection: "chg_note",
      op: "insert",
      row: { text: "sentinel" },
    })) as { row: { __meta: { id: string } } };
    for (const s of all) await received(s, { collection: "chg_note", ids: [row.__meta.id] });
    return row.__meta.id;
  }

  it("reports capabilities.changes on every collection", async () => {
    const { collections } = (await call("a", "collections", {})) as {
      collections: { name: string; capabilities: { changes?: boolean; subscribe: boolean } }[];
    };
    for (const c of collections) {
      expect(c.capabilities.changes, c.name).toBe(true);
      // `subscribe` promises udc-py's WebSocket actions: still false.
      expect(c.capabilities.subscribe).toBe(false);
    }
    const d = (await call("a", "describe", { collection: "chg_message" })) as {
      capabilities: { changes?: boolean };
    };
    expect(d.capabilities.changes).toBe(true);
  });

  it("A's mutate reaches A's stream and never B's; an admin stream sees it", async () => {
    const a = await stream("a");
    const b = await stream("b");
    const admin = await stream("admin");
    const { row } = (await call("a", "mutate", {
      collection: "chg_message",
      op: "insert",
      row: { subject: "new" },
    })) as { row: { __meta: { id: string } } };
    const id = row.__meta.id;
    await received(a, { collection: "chg_message", op: "insert", ids: [id] });
    await received(admin, { collection: "chg_message", op: "insert", ids: [id] });
    await sentinel(a, b, admin);
    expect(b.events.filter((e) => e.collection === "chg_message")).toEqual([]);
    // Nothing but collection, op and ids travels.
    for (const e of [...a.events, ...admin.events]) {
      expect(Object.keys(e).sort()).toEqual(expect.arrayContaining(["collection", "op"]));
      expect(Object.keys(e).every((k) => ["collection", "op", "ids"].includes(k))).toBe(true);
    }
  });

  it("an update reaches the owner with its id, not the other tenant", async () => {
    const a = await stream("a");
    const b = await stream("b");
    await call("a", "mutate", {
      collection: "chg_message",
      op: "update",
      id: ID.a1,
      row: { subject: "renamed" },
    });
    await received(a, { collection: "chg_message", op: "update", ids: [ID.a1] });
    await sentinel(a, b);
    expect(b.events.some((e) => e.collection === "chg_message")).toBe(false);
  });

  it("an admin moving a row from a to b tells both, by the row as it was and as it is", async () => {
    const a = await stream("a");
    const b = await stream("b");
    await call("admin", "mutate", {
      collection: "chg_message",
      op: "update",
      id: ID.a2,
      row: { tenant: "b" },
    });
    await received(a, { collection: "chg_message", op: "update", ids: [ID.a2] });
    await received(b, { collection: "chg_message", op: "update", ids: [ID.a2] });
  });

  it("a delete is delivered to the owner", async () => {
    const a = await stream("a");
    const b = await stream("b");
    await call("b", "mutate", { collection: "chg_message", op: "delete", id: ID.b2 });
    await received(b, { collection: "chg_message", op: "delete", ids: [ID.b2] });
    await sentinel(a, b);
    expect(a.events.some((e) => e.collection === "chg_message")).toBe(false);
  });

  it("an unscoped collection reaches both", async () => {
    const a = await stream("a");
    const b = await stream("b");
    const id = await sentinel(a, b);
    expect(a.events).toEqual([{ collection: "chg_note", op: "insert", ids: [id] }]);
    expect(b.events).toEqual([{ collection: "chg_note", op: "insert", ids: [id] }]);
  });

  it("a stream hears only the collections it asked for", async () => {
    const a = await stream("a", ["chg_note"]);
    const admin = await stream("admin", ["chg_note"]);
    await call("a", "mutate", { collection: "chg_message", op: "update", id: ID.a1, row: {} });
    await sentinel(a, admin);
    expect(a.events.map((e) => e.collection)).toEqual(["chg_note"]);
  });

  it("a host notify with ctx reaches only that scope", async () => {
    const a = await stream("a");
    const b = await stream("b");
    const admin = await stream("admin");
    await feed.notify<Ctx>("chg_message", {
      op: "insert",
      ids: ["x1", "x2"],
      ctx: { tenant: "b" },
    });
    await received(b, { collection: "chg_message", op: "insert", ids: ["x1", "x2"] });
    await received(admin, { collection: "chg_message", op: "insert", ids: ["x1", "x2"] });
    await sentinel(a, b, admin);
    expect(a.events.some((e) => e.collection === "chg_message")).toBe(false);
  });

  it("a host notify with rows tells each scope only its own rows' ids", async () => {
    const a = await stream("a");
    const b = await stream("b");
    await feed.notify("chg_message", {
      op: "update",
      rows: [
        { __meta: { id: "r1" }, tenant: "a" },
        { __meta: { id: "r2" }, tenant: "b" },
        { __meta: { id: "r3" }, tenant: "a" },
      ],
    });
    await received(a, { collection: "chg_message", op: "update", ids: ["r1", "r3"] });
    await received(b, { collection: "chg_message", op: "update", ids: ["r2"] });
  });

  it("notify without ctx or rows on a scoped collection throws; on an unscoped one it is sent", async () => {
    const a = await stream("a");
    await expect(feed.notify("chg_message", { op: "insert", ids: ["z"] })).rejects.toThrow(
      /row scope/,
    );
    await feed.notify("chg_note", { op: "delete" });
    await received(a, { collection: "chg_note", op: "delete" });
    expect(a.events.find((e) => e.collection === "chg_note")).toEqual({
      collection: "chg_note",
      op: "delete",
    });
  });

  it("a notify with the ctx of an unscoped request reaches unscoped streams only", async () => {
    const a = await stream("a");
    const admin = await stream("admin");
    await feed.notify<Ctx>("chg_message", { ctx: { tenant: null } });
    await received(admin, { collection: "chg_message", op: "update" });
    await sentinel(a, admin);
    expect(a.events.some((e) => e.collection === "chg_message")).toBe(false);
  });

  it("a failed mutate notifies nothing", async () => {
    const a = await stream("a");
    const res = await app.inject({
      method: "POST",
      url: "/udc/mutate",
      payload: { collection: "chg_message", op: "update", id: ID.b1, row: { subject: "x" } },
      headers: { "x-tenant": "a" },
    });
    expect((res.json() as { kind: string }).kind).toBe("udc.mutate.err");
    await sentinel(a);
    expect(a.events.some((e) => e.collection === "chg_message")).toBe(false);
  });
});

describe("without a feed", () => {
  it("collections report no changes capability and the route is not served", async () => {
    const registry = new CollectionRegistry();
    registry.register({ name: "chg_note", source: new MemorySource({ schema: noteSchema }), view });
    const dispatcher = createDispatcher(registry, { log: { error: vi.fn() } });
    expect(dispatcher.changes).toBeUndefined();
    const app = await buildApp({ dispatcher, registry, swagger: false, checkLinks: false });
    const res = await app.inject({ method: "POST", url: "/udc/collections", payload: {} });
    const { collections } = (res.json() as { payload: { collections: { capabilities: object }[] } })
      .payload;
    expect(collections[0]?.capabilities).not.toHaveProperty("changes");
    const stream = await app.inject({ method: "GET", url: "/udc/changes?collections=chg_note" });
    expect(stream.statusCode).toBe(404);
    await app.close();
  });
});
