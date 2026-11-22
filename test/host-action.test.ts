// A host action defined once with core's `defineHostAction`, registered on the dispatcher
// (handler typed from it, given the request context), served by the plugin, called through
// `UdcClient` with a fetch that goes to Fastify's `inject`; and in the OpenAPI document.
import {
  defineHostAction,
  type FilterNode,
  SchemaDocSchema,
  UdcError,
  unauthenticatedError,
  ViewConfigSchema,
} from "@jsudc/core";
import { UdcClient } from "@jsudc/core/client";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { z } from "zod";
import { buildApp } from "../src/app.js";
import { createDispatcher, type Dispatcher } from "../src/dispatcher.js";
import { CollectionRegistry } from "../src/registry.js";
import { MemorySource } from "../src/sources/memory.js";

// What the host's shared module would export: imported by its server and its browser code.
const archiveThread = defineHostAction({
  name: "mail.archive_thread",
  request: z.object({ thread: z.string().min(1), notify: z.boolean().default(false) }),
  response: z.object({ archived: z.number().int(), by: z.string() }),
});

interface Ctx {
  user: string;
  tenant: string;
}

function context(request: FastifyRequest): Ctx {
  const user = request.headers["x-user"];
  if (typeof user !== "string") throw unauthenticatedError();
  return { user, tenant: user === "bob" ? "b" : "a" };
}

const schema = SchemaDocSchema.parse({
  version: "v1",
  fields: { tenant: { type: "string" }, thread: { type: "string" }, archived: { type: "bool" } },
});
const rows = [
  { __meta: { id: "m1" }, tenant: "a", thread: "t1", archived: false },
  { __meta: { id: "m2" }, tenant: "a", thread: "t1", archived: false },
  { __meta: { id: "m3" }, tenant: "b", thread: "t1", archived: false },
];
const rowScope = (ctx: Ctx): FilterNode => ({ field: "tenant", op: "eq", value: ctx.tenant });

describe("a typed host action through the plugin", () => {
  let app: FastifyInstance;
  let dispatcher: Dispatcher;
  let client: UdcClient;
  const seen: { payload: unknown; ctx: unknown }[] = [];

  beforeEach(async () => {
    seen.length = 0;
    const registry = new CollectionRegistry();
    registry.register({
      name: "mail",
      source: new MemorySource({ schema, rows }),
      view: ViewConfigSchema.parse({}),
    });
    dispatcher = createDispatcher<Ctx>(registry, { log: { error: vi.fn() }, rowScope });
    // The handler is typed from the definition; `ctx` is the plugin's context.
    dispatcher.register(archiveThread, async (payload, ctx: Ctx) => {
      expectTypeOf(payload).toEqualTypeOf<{ thread: string; notify: boolean }>();
      seen.push({ payload, ctx });
      // A host action may use the protocol itself, under the same context and scope.
      const res = await dispatcher.dispatch(
        {
          kind: "udc.mutate_many",
          id: "",
          payload: {
            collection: "mail",
            op: "update",
            filter: { field: "thread", op: "eq", value: payload.thread },
            row: { archived: true },
          },
        },
        ctx,
      );
      if (res.kind.endsWith(".err")) throw new UdcError("internal", "archive failed");
      return { archived: (res.payload as { updated: number }).updated, by: ctx.user };
    });
    app = await buildApp({ dispatcher, context, checkLinks: false });
    await app.ready();
    client = clientAs("ana");
  });

  afterEach(() => app.close());

  /** A `UdcClient` whose fetch goes to `app.inject`, signed in as `user`. */
  function clientAs(user: string | null): UdcClient {
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const res = await app.inject({
        method: "POST",
        url: String(input),
        headers: init?.headers as Record<string, string>,
        payload: String(init?.body ?? ""),
      });
      return new Response(res.body, { status: res.statusCode });
    };
    return new UdcClient({
      httpUrl: "",
      fetch: fetch as typeof globalThis.fetch,
      ...(user === null ? {} : { headers: { "x-user": user } }),
    });
  }

  it("is called through UdcClient with its own types, and receives the context", async () => {
    const res = await client.call(archiveThread, { thread: "t1" });
    expectTypeOf(res).toEqualTypeOf<{ archived: number; by: string }>();
    expect(res).toEqual({ archived: 2, by: "ana" });
    expect(seen).toEqual([
      { payload: { thread: "t1", notify: false }, ctx: { user: "ana", tenant: "a" } },
    ]);
    // Another context: another scope.
    expect(await clientAs("bob").call(archiveThread, { thread: "t1", notify: true })).toEqual({
      archived: 1,
      by: "bob",
    });
  });

  it("answers a bad payload with validation_error, without calling the handler", async () => {
    const err = await client.call(archiveThread, { thread: "" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UdcError);
    expect(err).toMatchObject({ code: "validation_error" });
    const bad = await client.call<unknown, object>("mail.archive_thread", { thread: 42 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(bad).toMatchObject({ code: "validation_error" });
    expect(seen).toEqual([]);
  });

  it("is refused when the context refuses the request", async () => {
    const err = await clientAs(null)
      .call(archiveThread, { thread: "t1" })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toMatchObject({ code: "forbidden", details: { reason: "unauthenticated" } });
    expect(seen).toEqual([]);
  });

  it("is listed with the built-in actions and documented with its response in OpenAPI", async () => {
    expect(dispatcher.actions()).toContain("mail.archive_thread");
    expect(dispatcher.schemaOf("mail.archive_thread")).toBe(archiveThread.request);
    expect(dispatcher.responseOf("mail.archive_thread")).toBe(archiveThread.response);
    expect(dispatcher.responseOf("list")).toBeUndefined();
    const spec = (await app.inject({ method: "GET", url: "/docs/json" })).json();
    const op = spec.paths["/udc/mail.archive_thread"]?.post;
    expect(op?.operationId).toBe("mail.archive_thread");
    expect(JSON.stringify(op?.requestBody)).toContain("thread");
    expect(JSON.stringify(op?.responses?.["200"])).toContain("archived");
  });

  it("refuses something that is not a host action", () => {
    expect(() =>
      (dispatcher.register as (a: unknown, h: unknown) => unknown)({ name: "x" }, () => null),
    ).toThrow(/not a host action/);
  });

  it("keeps the by-name register for an action without a definition", async () => {
    dispatcher.register("ping", z.object({}), (_payload, ctx: Ctx) => ({ pong: ctx.user }));
    const fresh = await buildApp({ dispatcher, context, swagger: false, checkLinks: false });
    const res = await fresh.inject({
      method: "POST",
      url: "/udc/ping",
      headers: { "x-user": "ana" },
      payload: {},
    });
    expect(res.json()).toMatchObject({ kind: "udc.ping.ok", payload: { pong: "ana" } });
    await fresh.close();
  });
});
