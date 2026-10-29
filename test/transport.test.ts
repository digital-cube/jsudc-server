import { ACTIONS, SchemaDocSchema, ViewConfigSchema } from "@jsudc/core";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { createDispatcher } from "../src/dispatcher.js";
import { CollectionRegistry } from "../src/registry.js";
import { MemorySource } from "../src/sources/memory.js";

const schema = SchemaDocSchema.parse({
  version: "v1",
  fields: { name: { type: "string", required: true }, employees: { type: "integer" } },
});

let app: FastifyInstance;
const log = { error: vi.fn() };

beforeAll(async () => {
  const registry = new CollectionRegistry();
  registry.register({
    name: "firms",
    source: new MemorySource({ schema, rows: [{ name: "Alfa", employees: 3 }] }),
    view: ViewConfigSchema.parse({}),
  });
  const dispatcher = createDispatcher(registry, { log });
  dispatcher.register("boom", ACTIONS.collections.request, () => {
    throw new Error("password=hunter2");
  });
  app = await buildApp({ dispatcher });
  await app.ready();
});

afterAll(() => app.close());

const post = (action: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: `/udc/${action}`, payload: payload as object, headers });

describe("transport", () => {
  it("GET /healthz answers ok", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("wraps the body as the payload and answers the ok envelope, echoing the message id", async () => {
    const res = await post("list", { collection: "firms" }, { "x-udc-message-id": "abc-1" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.kind).toBe("udc.list.ok");
    expect(body.id).toBe("abc-1");
    expect(body.payload).toMatchObject({ total: 1, next_cursor: null, rows: [{ name: "Alfa" }] });
  });

  it("uses an empty id when the header is missing", async () => {
    const res = await post("collections", {});
    expect(res.json()).toMatchObject({ kind: "udc.collections.ok", id: "" });
  });

  it("treats a missing body as an empty payload", async () => {
    const res = await app.inject({ method: "POST", url: "/udc/collections" });
    expect(res.statusCode).toBe(200);
    expect(res.json().kind).toBe("udc.collections.ok");
  });

  it("answers err envelopes with HTTP 200", async () => {
    const res = await post(
      "read",
      { collection: "firms", id: "nope" },
      { "x-udc-message-id": "r" },
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      kind: "udc.read.err",
      id: "r",
      payload: { code: "not_found", message: expect.any(String), details: { id: "nope" } },
    });
  });

  it("answers unsupported_op for an unknown action", async () => {
    const res = await post("frobnicate", {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      kind: "udc.frobnicate.err",
      payload: { code: "unsupported_op" },
    });
  });

  it("answers validation_error with Zod issues for an invalid payload", async () => {
    const res = await post("list", { collection: "firms", sort: [{ field: "name", dir: "up" }] });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.payload.code).toBe("validation_error");
    expect(body.payload.details.issues[0].path).toEqual(["sort", 0, "dir"]);
  });

  it("answers validation_error for a body that is not JSON", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/udc/list",
      payload: "{not json",
      headers: { "content-type": "application/json", "x-udc-message-id": "bad" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      kind: "udc.list.err",
      id: "bad",
      payload: { code: "validation_error" },
    });
  });

  it("turns an unexpected exception into internal without leaking its message", async () => {
    const res = await post("boom", {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      kind: "udc.boom.err",
      id: "",
      payload: { code: "internal", message: "internal error" },
    });
    expect(res.body).not.toContain("hunter2");
    expect(log.error).toHaveBeenCalled();
  });

  it("serves the OpenAPI document with one operation per action, and the UI at /docs", async () => {
    const spec = await app.inject({ method: "GET", url: "/docs/json" });
    expect(spec.statusCode).toBe(200);
    const paths = Object.keys(spec.json().paths);
    for (const action of ["collections", "describe", "list", "read", "mutate"]) {
      expect(paths).toContain(`/udc/${action}`);
    }
    const ui = await app.inject({ method: "GET", url: "/docs/" });
    expect(ui.statusCode).toBe(200);
    expect(ui.headers["content-type"]).toContain("text/html");
  });
});
