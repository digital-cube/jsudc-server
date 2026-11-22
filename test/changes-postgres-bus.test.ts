// The Postgres change bus: two plugin instances (two server processes, as far as the feed
// can tell) on the test database share one LISTEN / NOTIFY channel. A change through one
// reaches a stream of the other; the listening connection comes back after it is killed;
// a notice over NOTIFY's limit travels without ids.
import {
  type FilterNode,
  SchemaDocSchema,
  unauthenticatedError,
  ViewConfigSchema,
} from "@jsudc/core";
import { sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { type ChangeNotice, createChangeFeed } from "../src/changes.js";
import {
  createPostgresChangeBus,
  encodeNotice,
  NOTIFY_PAYLOAD_LIMIT,
  PostgresChangeBus,
} from "../src/changes-postgres.js";
import { createCollectionTableSql } from "../src/db/schema.js";
import { createDispatcher } from "../src/dispatcher.js";
import { CollectionRegistry } from "../src/registry.js";
import { PostgresJsonbSource } from "../src/sources/postgres-jsonb.js";
import { listen, type OpenStream, openStream, received } from "./changes-helpers.js";
import { TEST_DATABASE_URL, useTestDb } from "./helpers.js";

const schema = SchemaDocSchema.parse({
  version: "v1",
  fields: { tenant: { type: "string" }, subject: { type: "string", required: true } },
});
const view = ViewConfigSchema.parse({ columns: [{ field: "subject" }] });

interface Ctx {
  tenant: string | null;
}
function context(request: FastifyRequest): Ctx {
  const tenant = request.headers["x-tenant"];
  if (typeof tenant !== "string") throw unauthenticatedError();
  return { tenant: tenant === "admin" ? null : tenant };
}
function rowScope(ctx: Ctx): FilterNode | undefined {
  return ctx.tenant === null ? undefined : { field: "tenant", op: "eq", value: ctx.tenant };
}

const CHANNEL = "jsudc_changes_test";
const { db } = useTestDb();
const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
afterAll(() => admin.end());

beforeAll(async () => {
  await db.execute(sql.raw(createCollectionTableSql("chg_bus")));
  await db.execute(sql`truncate table chg_bus`);
});

/** One server process: its own pool-backed source, feed, Postgres bus and HTTP listener. */
async function instance() {
  const bus = createPostgresChangeBus({
    connectionString: TEST_DATABASE_URL,
    channel: CHANNEL,
    reconnectDelayMs: 20,
    maxReconnectDelayMs: 100,
    log: { error: vi.fn() },
  });
  const feed = createChangeFeed({ bus, coalesce: false });
  const registry = new CollectionRegistry();
  registry.register({
    name: "chg_bus",
    source: new PostgresJsonbSource({ db, table: "chg_bus", initialSchema: schema }),
    view,
  });
  const dispatcher = createDispatcher<Ctx>(registry, {
    log: { error: vi.fn() },
    rowScope,
    changes: feed,
  });
  const app = await buildApp({ dispatcher, registry, context, swagger: false, checkLinks: false });
  const base = await listen(app);
  await bus.whenListening();
  return { app, base, bus, feed };
}

describe("two plugin instances sharing the Postgres bus", () => {
  const apps: FastifyInstance[] = [];
  const closers: (() => Promise<void>)[] = [];
  const streams: OpenStream[] = [];

  afterEach(async () => {
    for (const s of streams.splice(0)) await s.stop();
    for (const app of apps.splice(0)) await app.close();
    for (const close of closers.splice(0)) await close();
  });

  async function both() {
    const one = await instance();
    const two = await instance();
    apps.push(one.app, two.app);
    closers.push(
      () => one.feed.close(),
      () => two.feed.close(),
    );
    return { one, two };
  }

  async function insert(app: FastifyInstance, tenant: string, subject: string) {
    const res = await app.inject({
      method: "POST",
      url: "/udc/mutate",
      payload: { collection: "chg_bus", op: "insert", row: { subject } },
      headers: { "x-tenant": tenant },
    });
    const body = res.json() as { kind: string; payload: { row: { __meta: { id: string } } } };
    expect(body.kind).toBe("udc.mutate.ok");
    return body.payload.row.__meta.id;
  }

  it("a change through one reaches a subscriber of the other, under its scope", async () => {
    const { one, two } = await both();
    const a = await openStream(two.base, ["chg_bus"], { "x-tenant": "a" });
    const b = await openStream(two.base, ["chg_bus"], { "x-tenant": "b" });
    const local = await openStream(one.base, ["chg_bus"], { "x-tenant": "a" });
    streams.push(a, b, local);
    const id = await insert(one.app, "a", "over the bus");
    await received(a, { collection: "chg_bus", op: "insert", ids: [id] });
    // Its own process hears it once: delivered locally, its echo from NOTIFY skipped.
    await received(local, { collection: "chg_bus", op: "insert", ids: [id] });
    const idB = await insert(two.app, "b", "back");
    await received(b, { collection: "chg_bus", op: "insert", ids: [idB] });
    await new Promise((r) => setTimeout(r, 100));
    expect(local.events).toEqual([{ collection: "chg_bus", op: "insert", ids: [id] }]);
    expect(a.events).toEqual([{ collection: "chg_bus", op: "insert", ids: [id] }]);
    expect(b.events).toEqual([{ collection: "chg_bus", op: "insert", ids: [idB] }]);
  });

  it("the listener reconnects after its connection is killed", async () => {
    const { one, two } = await both();
    const a = await openStream(two.base, ["chg_bus"], { "x-tenant": "a" });
    streams.push(a);
    const before = two.bus.pid;
    expect(before).toBeTypeOf("number");
    await admin.query("select pg_terminate_backend($1)", [before]);
    await vi.waitFor(
      () => {
        expect(two.bus.listening).toBe(true);
        expect(two.bus.pid).not.toBe(before);
      },
      { timeout: 5000, interval: 20 },
    );
    const id = await insert(one.app, "a", "after the kill");
    await received(a, { collection: "chg_bus", op: "insert", ids: [id] });
  });

  it("a host notify on one reaches the other, with the ctx's scope", async () => {
    const { one, two } = await both();
    const a = await openStream(two.base, ["chg_bus"], { "x-tenant": "a" });
    const b = await openStream(two.base, ["chg_bus"], { "x-tenant": "b" });
    streams.push(a, b);
    await one.feed.notify<Ctx>("chg_bus", { op: "insert", ids: ["m1"], ctx: { tenant: "b" } });
    await received(b, { collection: "chg_bus", op: "insert", ids: ["m1"] });
    expect(a.events).toEqual([]);
  });
});

describe("PostgresChangeBus", () => {
  it("sends a notice too large for NOTIFY without ids, split when its values are large", async () => {
    const ids = Array.from(
      { length: 400 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    const notice: ChangeNotice = {
      collection: "c",
      op: "update",
      ids,
      match: ids.map((id) => ({ ids: [id], values: { tenant: "a", id } })),
    };
    const payloads = encodeNotice(notice, "me");
    expect(payloads.length).toBeGreaterThan(1);
    for (const p of payloads) {
      expect(Buffer.byteLength(p)).toBeLessThanOrEqual(NOTIFY_PAYLOAD_LIMIT);
      const { o, n } = JSON.parse(p) as { o: string; n: ChangeNotice };
      expect(o).toBe("me");
      expect(n.ids).toBeUndefined();
      for (const m of n.match ?? []) expect(m.ids).toBeUndefined();
    }
    // Every row's values are still there to test, over the payloads.
    const tested = payloads.flatMap((p) => (JSON.parse(p) as { n: ChangeNotice }).n.match ?? []);
    expect(tested).toHaveLength(400);

    // Ids alone too many: one payload, without ids.
    const plain = encodeNotice({ collection: "c", op: "insert", ids }, "me");
    expect(plain).toEqual([JSON.stringify({ o: "me", n: { collection: "c", op: "insert" } })]);
    // Without ids the values fit: one payload, the values kept.
    const fewer = encodeNotice(
      { collection: "c", op: "insert", ids, match: [{ values: { tenant: "a" } }] },
      "me",
    );
    expect(JSON.parse(fewer[0] as string).n).toEqual({
      collection: "c",
      op: "insert",
      match: [{ values: { tenant: "a" } }],
    });
    // One row alone too large: cut to its short values; nothing left that fits: no match at all.
    const long = "x".repeat(100);
    const wide = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`f${i}`, long]));
    const cut = encodeNotice(
      { collection: "c", op: "update", match: [{ values: { ...wide, tenant: "a" } }] },
      "me",
    );
    expect(JSON.parse(cut[0] as string).n.match).toEqual([{ values: { tenant: "a" } }]);
    const none = encodeNotice(
      { collection: "c", op: "update", match: [{ values: wide }] },
      "me",
      300,
    );
    expect(JSON.parse(none[0] as string).n).toEqual({
      collection: "c",
      op: "update",
      match: [{ values: {} }],
    });
    const nothing = encodeNotice(
      { collection: "c", op: "update", match: [{ values: wide }] },
      "me",
      60,
    );
    expect(JSON.parse(nothing[0] as string).n).toEqual({ collection: "c", op: "update" });
  });

  it("delivers across buses, skips its own echo and payloads that are not notices", async () => {
    const one = new PostgresChangeBus({ connectionString: TEST_DATABASE_URL, channel: CHANNEL });
    const two = new PostgresChangeBus({ connectionString: TEST_DATABASE_URL, channel: CHANNEL });
    const got1: ChangeNotice[] = [];
    const got2: ChangeNotice[] = [];
    const off = one.subscribe((n) => got1.push(n));
    two.subscribe((n) => got2.push(n));
    two.subscribe(() => {
      throw new Error("a listener that fails does not stop the others");
    });
    await one.whenListening();
    await two.whenListening();
    await admin.query("select pg_notify($1, $2)", [CHANNEL, "not json"]);
    await admin.query("select pg_notify($1, $2)", [
      CHANNEL,
      JSON.stringify({ o: "x", n: { collection: "c", op: "nope" } }),
    ]);
    await one.publish({ collection: "c", op: "insert", ids: ["1"] });
    await vi.waitFor(() => expect(got2).toEqual([{ collection: "c", op: "insert", ids: ["1"] }]));
    expect(got1).toEqual([{ collection: "c", op: "insert", ids: ["1"] }]);
    off();
    await two.publish({ collection: "c", op: "delete" });
    await vi.waitFor(() => expect(got2).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 50));
    expect(got1).toHaveLength(1);
    await one.close();
    await two.close();
    expect(one.listening).toBe(false);
    expect(one.pid).toBeUndefined();
    // Closed: no reconnect, and whenListening does not hang.
    await one.whenListening();
  });

  it("publishes through a pool the host passes, which it does not close", async () => {
    const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    const bus = new PostgresChangeBus({
      connectionString: TEST_DATABASE_URL,
      pool,
      channel: CHANNEL,
    });
    await bus.publish({ collection: "c", op: "update" });
    await bus.close();
    expect((await pool.query("select 1 as n")).rows[0]).toEqual({ n: 1 });
    await pool.end();
  });

  it("keeps trying while the database cannot be reached", async () => {
    const error = vi.fn();
    const bus = new PostgresChangeBus({
      connectionString: "postgresql://nobody:x@127.0.0.1:1/none",
      reconnectDelayMs: 10,
      maxReconnectDelayMs: 20,
      log: { error },
    });
    bus.start();
    await vi.waitFor(() => expect(error.mock.calls.length).toBeGreaterThanOrEqual(2), {
      timeout: 3000,
    });
    expect(bus.listening).toBe(false);
    await bus.close();
  });

  it("refuses a channel that is not an identifier", () => {
    expect(
      () => new PostgresChangeBus({ connectionString: TEST_DATABASE_URL, channel: "bad; drop" }),
    ).toThrow(/identifier/);
  });
});
