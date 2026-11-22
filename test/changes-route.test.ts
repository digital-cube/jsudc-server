// `GET /udc/changes`, the stream itself: the context resolved once (401 / 403 are plain
// HTTP answers), access per collection, the retry hint, ready and heartbeat, the listener
// removed when a client leaves, streams ended on close, behind a prefix beside the host's
// routes, bursts coalesced and long id lists dropped.
import {
  type FilterNode,
  SchemaDocSchema,
  UdcError,
  unauthenticatedError,
  ViewConfigSchema,
} from "@jsudc/core";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp, udcPlugin } from "../src/app.js";
import { type ChangeFeed, type ChangeFeedOptions, createChangeFeed } from "../src/changes.js";
import { createDispatcher } from "../src/dispatcher.js";
import { CollectionRegistry } from "../src/registry.js";
import { MemorySource } from "../src/sources/memory.js";
import { listen, type OpenStream, openStream, received } from "./changes-helpers.js";

const schema = SchemaDocSchema.parse({
  version: "v1",
  fields: { tenant: { type: "string" }, text: { type: "string" } },
});
const view = ViewConfigSchema.parse({ columns: [{ field: "text" }] });

interface Ctx {
  tenant: string | null;
}
function context(request: FastifyRequest): Ctx {
  const tenant = request.headers["x-tenant"];
  if (typeof tenant !== "string") throw unauthenticatedError();
  if (tenant === "banned") throw new UdcError("forbidden", "this tenant is suspended");
  if (tenant === "crash") throw new Error("db password=hunter2");
  return { tenant: tenant === "admin" ? null : tenant };
}
function rowScope(ctx: Ctx, collection: string): FilterNode | undefined {
  if (collection !== "items" || ctx.tenant === null) return undefined;
  return { field: "tenant", op: "eq", value: ctx.tenant };
}

function setup(feedOpts: ChangeFeedOptions = {}) {
  const registry = new CollectionRegistry();
  registry.register({ name: "items", source: new MemorySource({ schema }), view });
  registry.register({ name: "notes", source: new MemorySource({ schema }), view });
  registry.register({ name: "secret", source: new MemorySource({ schema }), view });
  const feed = createChangeFeed({ coalesce: false, ...feedOpts });
  const dispatcher = createDispatcher<Ctx>(registry, {
    log: { error: vi.fn() },
    rowScope,
    access: (_ctx, { collection }) => (collection === "secret" ? false : undefined),
    changes: feed,
  });
  return { registry, feed, dispatcher };
}

/** Read the raw stream until `until` matches the text so far. */
async function readRaw(url: string, headers: Record<string, string>, until: RegExp) {
  const ctl = new AbortController();
  const res = await fetch(url, { headers, signal: ctl.signal });
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!until.test(text)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  ctl.abort();
  return { res, text };
}

describe("GET /udc/changes", () => {
  let app: FastifyInstance;
  let feed: ChangeFeed;
  let base: string;
  const streams: OpenStream[] = [];

  async function start(feedOpts: ChangeFeedOptions = {}) {
    const s = setup(feedOpts);
    feed = s.feed;
    app = await buildApp({
      dispatcher: s.dispatcher,
      registry: s.registry,
      context,
      swagger: false,
      checkLinks: false,
    });
    base = await listen(app);
  }

  afterEach(async () => {
    for (const s of streams.splice(0)) await s.stop();
    await app?.close();
    await feed?.close();
  });

  it("sends the retry hint, ready, then a heartbeat comment at the interval", async () => {
    await start({ heartbeatMs: 30, retryMs: 1234 });
    const { res, text } = await readRaw(
      `${base}/udc/changes?collections=items,notes,items`,
      { "x-tenant": "a" },
      /: heartbeat\n\n[\s\S]*: heartbeat\n\n/,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    expect(
      text.startsWith('retry: 1234\n\nevent: ready\ndata: {"collections":["items","notes"]}\n\n'),
    ).toBe(true);
    expect(text.match(/: heartbeat/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("the listener count returns to zero after clients disconnect", async () => {
    await start();
    expect(feed.listenerCount).toBe(0);
    for (const tenant of ["a", "b", "admin"]) {
      streams.push(await openStream(base, ["items"], { "x-tenant": tenant }));
    }
    expect(feed.listenerCount).toBe(3);
    await (streams.pop() as OpenStream).stop();
    await vi.waitFor(() => expect(feed.listenerCount).toBe(2));
    for (const s of streams.splice(0)) await s.stop();
    await vi.waitFor(() => expect(feed.listenerCount).toBe(0));
  });

  it("context refusing ends the request with 401 / 403 (500 for a crash), no stream", async () => {
    await start();
    const get = (headers: Record<string, string>) =>
      app.inject({ method: "GET", url: "/udc/changes?collections=items", headers });
    const none = await get({});
    expect(none.statusCode).toBe(401);
    expect(none.json()).toMatchObject({
      code: "forbidden",
      details: { reason: "unauthenticated" },
    });
    const banned = await get({ "x-tenant": "banned" });
    expect(banned.statusCode).toBe(403);
    expect(banned.json()).toEqual({ code: "forbidden", message: "this tenant is suspended" });
    const crash = await get({ "x-tenant": "crash" });
    expect(crash.statusCode).toBe(500);
    expect(crash.body).not.toContain("hunter2");
    expect(feed.listenerCount).toBe(0);
  });

  it("refuses a missing or overlong collection list (400) and a collection it may not list (404)", async () => {
    await start();
    const get = (q: string) =>
      app.inject({ method: "GET", url: `/udc/changes${q}`, headers: { "x-tenant": "a" } });
    expect((await get("")).statusCode).toBe(400);
    expect((await get("?collections=,%20,")).json()).toMatchObject({ code: "validation_error" });
    const many = Array.from({ length: 101 }, (_, i) => `c${i}`).join(",");
    expect((await get(`?collections=${many}`)).statusCode).toBe(400);
    const unknown = await get("?collections=items,nope");
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ code: "not_found" });
    expect((await get("?collections=secret")).statusCode).toBe(404);
    // Repeated keys are read as well.
    const ok = await readRaw(
      `${base}/udc/changes?collections=items&collections=notes`,
      { "x-tenant": "a" },
      /event: ready/,
    );
    expect(ok.text).toContain('{"collections":["items","notes"]}');
  });

  it("core's client stops on those refusals", async () => {
    await start();
    const refused = await openStream(base, ["items"], {});
    await expect(refused.done).rejects.toMatchObject({ code: "forbidden" });
    const hidden = await openStream(base, ["secret"], { "x-tenant": "a" });
    await expect(hidden.done).rejects.toMatchObject({ code: "not_found" });
  });

  it("ends open streams when the server closes, and the client reconnects to a new one", async () => {
    await start();
    const s = await openStream(base, ["notes"], { "x-tenant": "a" });
    streams.push(s);
    const port = new URL(base).port;
    await app.close();
    expect(feed.listenerCount).toBe(0);
    // A new server on the same port: the client comes back and says it reconnected.
    const next = setup();
    feed = next.feed;
    app = await buildApp({
      dispatcher: next.dispatcher,
      registry: next.registry,
      context,
      swagger: false,
      checkLinks: false,
    });
    await app.listen({ port: Number(port), host: "127.0.0.1" });
    await vi.waitFor(() => expect(s.opens).toEqual([false, true]), { timeout: 3000 });
    await feed.notify("notes", { op: "insert", ids: ["n1"] });
    await received(s, { collection: "notes", ids: ["n1"] });
  });

  it("coalesces a burst into one event without ids", async () => {
    await start({ coalesce: { windowMs: 80, maxEvents: 3 } });
    const s = await openStream(base, ["notes", "items"], { "x-tenant": "admin" });
    streams.push(s);
    for (let i = 0; i < 10; i += 1) await feed.notify("notes", { op: "insert", ids: [`n${i}`] });
    for (let i = 0; i < 5; i += 1) {
      await feed.notify("items", {
        op: i % 2 ? "delete" : "insert",
        ids: [`i${i}`],
        ctx: { tenant: null },
      });
    }
    await vi.waitFor(() => expect(s.events).toHaveLength(8), { timeout: 2000 });
    const notes = s.events.filter((e) => e.collection === "notes");
    expect(notes).toEqual([
      { collection: "notes", op: "insert", ids: ["n0"] },
      { collection: "notes", op: "insert", ids: ["n1"] },
      { collection: "notes", op: "insert", ids: ["n2"] },
      { collection: "notes", op: "insert" },
    ]);
    // Mixed operations coalesce as an update.
    expect(s.events.filter((e) => e.collection === "items").at(-1)).toEqual({
      collection: "items",
      op: "update",
    });
    // A new window passes events through again.
    await new Promise((r) => setTimeout(r, 100));
    await feed.notify("notes", { op: "update", ids: ["later"] });
    await received(s, { collection: "notes", ids: ["later"] });
  });

  it("sends an event naming more rows than maxIds without ids", async () => {
    await start({ maxIds: 2 });
    const s = await openStream(base, ["notes", "items"], { "x-tenant": "a" });
    streams.push(s);
    await feed.notify("notes", { op: "update", ids: ["1", "2", "3"] });
    await received(s, { collection: "notes" });
    expect(s.events[0]).toEqual({ collection: "notes", op: "update" });
    await feed.notify("items", {
      op: "update",
      rows: ["1", "2", "3"].map((id) => ({ __meta: { id }, tenant: "a" })),
    });
    await received(s, { collection: "items" });
    expect(s.events[1]).toEqual({ collection: "items", op: "update" });
  });
});

describe("behind a prefix, beside the host's routes", () => {
  it("serves the stream under the prefix and keeps the host's headers", async () => {
    const { registry, feed, dispatcher } = setup();
    const app = Fastify();
    app.addHook("onRequest", async (_req, reply) => {
      reply.header("access-control-allow-origin", "https://app.example");
    });
    app.get("/api/health", async () => ({ host: true }));
    await app.register(udcPlugin, {
      prefix: "/api",
      dispatcher,
      registry,
      context,
      swagger: false,
      checkLinks: false,
    });
    const base = await listen(app);
    expect((await app.inject({ method: "GET", url: "/api/health" })).json()).toEqual({
      host: true,
    });
    expect(
      (await app.inject({ method: "GET", url: "/udc/changes?collections=notes" })).statusCode,
    ).toBe(404);
    const s = await openStream(base, ["notes"], { "x-tenant": "a" }, { prefix: "/api" });
    await feed.notify("notes", { op: "insert", ids: ["p1"] });
    await received(s, { collection: "notes", ids: ["p1"] });
    const raw = await readRaw(
      `${base}/api/udc/changes?collections=notes`,
      { "x-tenant": "a" },
      /ready/,
    );
    expect(raw.res.headers.get("access-control-allow-origin")).toBe("https://app.example");
    await s.stop();
    await app.close();
    await feed.close();
  });

  it("refuses a feed without the registry", async () => {
    const { feed, dispatcher } = setup();
    await expect(buildApp({ dispatcher, swagger: false })).rejects.toThrow(/registry/);
    await feed.close();
  });
});
