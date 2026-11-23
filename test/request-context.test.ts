// The request context end to end: the plugin's `context` hook, `Dispatcher.dispatch(msg, ctx)`,
// a host's own action and source receiving it, `access` hiding a collection, and the file
// preview route held to the context, the access hook and the row scope.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FilterNode,
  type Row,
  SchemaDocSchema,
  UdcError,
  unauthenticatedError,
  ViewConfigSchema,
} from "@jsudc/core";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { buildApp } from "../src/app.js";
import { registerBlobRoute } from "../src/blob.js";
import { createDispatcher } from "../src/dispatcher.js";
import { CollectionRegistry } from "../src/registry.js";
import { FilesystemSource } from "../src/sources/filesystem.js";
import { MemorySource } from "../src/sources/memory.js";
import type { SourceContext, SourceListRequest } from "../src/sources/source.js";
import { COLLECTIONS_DIR } from "./common.js";

interface Ctx {
  tenant: string;
}

const noteSchema = SchemaDocSchema.parse({
  version: "v1",
  fields: { tenant: { type: "string" }, text: { type: "string", required: true } },
});
const filesSchema = SchemaDocSchema.parse(
  JSON.parse(readFileSync(join(COLLECTIONS_DIR, "files", "schema.json"), "utf8")),
);

/** A host's own source: it knows nothing of scopes and records the context it is given. */
class RecordingSource extends MemorySource {
  readonly seen: (SourceContext | undefined)[] = [];
  override async list(req: SourceListRequest, sctx?: SourceContext) {
    this.seen.push(sctx);
    return super.list(req, sctx);
  }
}

const root = mkdtempSync(join(tmpdir(), "jsudc-ctx-"));
writeFileSync(join(root, "a-notes.md"), "# a\n");
writeFileSync(join(root, "b-notes.md"), "# b\n");
writeFileSync(join(root, "nofiles-x.md"), "# n\n");
mkdirSync(join(root, "a-dir"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function context(request: FastifyRequest): Ctx {
  const tenant = request.headers["x-tenant"];
  if (tenant === "banned") throw new UdcError("forbidden", "suspended");
  if (tenant === "crash") throw new Error("secret=hunter2");
  if (typeof tenant !== "string") throw unauthenticatedError();
  return { tenant };
}

function rowScope(ctx: Ctx, collection: string): FilterNode | undefined {
  if (collection === "notes") return { field: "tenant", op: "eq", value: ctx.tenant };
  // A file belongs to the tenant its name starts with.
  if (collection === "files") return { field: "name", op: "starts_with", value: `${ctx.tenant}-` };
  // The filesystem source takes a `path` condition as its folder selector and drops it from
  // the filter: the generic layer still checks every row it answers.
  if (collection === "tree") return { field: "path", op: "starts_with", value: `${ctx.tenant}-` };
  return undefined;
}

const notes = new RecordingSource({
  schema: noteSchema,
  rows: [
    { tenant: "a", text: "a's note" },
    { tenant: "b", text: "b's note" },
  ],
});

function makeRegistry() {
  const registry = new CollectionRegistry();
  registry.register({ name: "notes", source: notes, view: ViewConfigSchema.parse({}) });
  registry.register({
    name: "secret",
    source: new MemorySource({ schema: noteSchema, rows: [{ text: "for a only" }] }),
    view: ViewConfigSchema.parse({}),
  });
  registry.register({
    name: "files",
    source: new FilesystemSource({ name: "files", schema: filesSchema, root }),
    view: ViewConfigSchema.parse({ folder_options: { path_field: "path", preview: true } }),
  });
  registry.register({
    name: "tree",
    source: new FilesystemSource({ name: "tree", schema: filesSchema, root }),
    view: ViewConfigSchema.parse({}),
  });
  return registry;
}

const registry = makeRegistry();
const log = { error: vi.fn() };
const dispatcher = createDispatcher<Ctx>(registry, {
  log,
  rowScope,
  access: (ctx, { collection }) =>
    (collection === "secret" && ctx.tenant !== "a") ||
    (collection === "files" && ctx.tenant === "nofiles")
      ? false
      : undefined,
});
const whoami = vi.fn((_: unknown, ctx: Ctx) => ({ tenant: ctx.tenant }));
dispatcher.register("whoami", z.object({}), whoami);
// Today's one-argument handler still registers and runs.
dispatcher.register("ping", z.object({}), () => ({ pong: true }));

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({ dispatcher, registry, context, swagger: false, checkLinks: false });
  await app.ready();
});
afterAll(() => app.close());

const post = async (tenant: string | null, action: string, payload: object = {}) => {
  const res = await app.inject({
    method: "POST",
    url: `/udc/${action}`,
    payload,
    headers: tenant === null ? {} : { "x-tenant": tenant },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { kind: string; payload: Record<string, unknown> };
};

describe("the request context", () => {
  it("reaches a host action registered on the dispatcher", async () => {
    expect(await post("a", "whoami")).toMatchObject({
      kind: "udc.whoami.ok",
      payload: { tenant: "a" },
    });
    expect(whoami).toHaveBeenLastCalledWith({}, { tenant: "a" });
    expect((await post("b", "ping")).payload).toEqual({ pong: true });
  });

  it("refuses a request without a session before the handler runs", async () => {
    whoami.mockClear();
    const res = await post(null, "whoami");
    expect(res).toEqual({
      kind: "udc.whoami.err",
      id: "",
      payload: {
        code: "forbidden",
        message: "not signed in",
        details: { reason: "unauthenticated" },
      },
    });
    expect(whoami).not.toHaveBeenCalled();
    // An unknown action is refused the same way: the context runs first.
    expect((await post(null, "nope")).payload).toMatchObject({
      details: { reason: "unauthenticated" },
    });
  });

  it("reaches every source method, with the resolved row scope, a host source included", async () => {
    notes.seen.length = 0;
    const res = await post("b", "list", { collection: "notes" });
    expect((res.payload.rows as Row[]).map((r) => r.text)).toEqual(["b's note"]);
    expect(notes.seen).toEqual([
      {
        ctx: { tenant: "b" },
        collection: "notes",
        rowScope: { field: "tenant", op: "eq", value: "b" },
      },
    ]);
  });

  it("is passed by a dispatcher driven without HTTP, and scopes it the same", async () => {
    const msg = { kind: "udc.list", id: "m1", payload: { collection: "notes" } };
    const a = await dispatcher.dispatch(msg, { tenant: "a" });
    expect(a.kind).toBe("udc.list.ok");
    expect((a.payload as { rows: Row[] }).rows.map((r) => r.text)).toEqual(["a's note"]);
    expect((a.payload as { rows: Row[] }).rows[0]).not.toHaveProperty("tenant");
    const who = await dispatcher.dispatch(
      { kind: "udc.whoami", id: "m2", payload: {} },
      {
        tenant: "z",
      },
    );
    expect(who.payload).toEqual({ tenant: "z" });
  });

  it("keeps today's behaviour for a dispatcher without context, scope or access", async () => {
    const plain = createDispatcher(makeRegistry(), { log });
    const res = await plain.dispatch({
      kind: "udc.list",
      id: "p",
      payload: { collection: "notes" },
    });
    expect((res.payload as { total: number }).total).toBe(2);
    expect((res.payload as { rows: Row[] }).rows[0]).toHaveProperty("tenant");
  });
});

describe("access", () => {
  it("hides a collection from collections and answers not_found on it", async () => {
    const names = async (tenant: string) =>
      ((await post(tenant, "collections")).payload.collections as { name: string }[]).map(
        (c) => c.name,
      );
    expect(await names("a")).toContain("secret");
    expect(await names("b")).not.toContain("secret");
    const unknown = await post("b", "describe", { collection: "nothing" });
    for (const action of ["describe", "list", "read", "mutate", "schema.add_field"]) {
      const payload =
        action === "read"
          ? { collection: "secret", id: "x" }
          : action === "mutate"
            ? { collection: "secret", op: "delete", id: "x" }
            : action === "schema.add_field"
              ? {
                  collection: "secret",
                  name: "f",
                  fielddef: { type: "string" },
                  position: { where: "end" },
                }
              : { collection: "secret" };
      const res = await post("b", action, payload);
      expect(res.kind, action).toBe(`udc.${action}.err`);
      expect(res.payload, action).toEqual(
        JSON.parse(JSON.stringify(unknown.payload).replaceAll("nothing", "secret")),
      );
    }
    expect((await post("a", "describe", { collection: "secret" })).kind).toBe("udc.describe.ok");
  });
});

describe("a source that drops a scope condition", () => {
  it("still answers only in-scope rows", async () => {
    const res = await post("a", "list", { collection: "tree" });
    expect((res.payload.rows as Row[]).map((r) => r.__meta.id).sort()).toEqual([
      "a-dir",
      "a-notes.md",
    ]);
    const read = await post("a", "read", { collection: "tree", id: "b-notes.md" });
    expect(read.payload).toMatchObject({ code: "not_found" });
  });
});

describe("GET /udc/files/blob under a context", () => {
  const get = (tenant: string | null, query: string) =>
    app.inject({
      method: "GET",
      url: `/udc/files/blob?${query}`,
      headers: tenant === null ? {} : { "x-tenant": tenant },
    });

  it("serves a file inside the scope", async () => {
    const res = await get("a", "collection=files&path=a-notes.md");
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("# a\n");
  });

  it("answers 404 for a file outside the scope, as for one that does not exist", async () => {
    const outside = await get("a", "collection=files&path=b-notes.md");
    const missing = await get("a", "collection=files&path=a-missing.md");
    expect(outside.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(outside.json()).toEqual(
      JSON.parse(JSON.stringify(missing.json()).replaceAll("a-missing", "b-notes")),
    );
    expect((await get("b", "collection=files&path=b-notes.md")).statusCode).toBe(200);
  });

  it("answers 401 without a session, 403 for another refusal, 500 for a crash", async () => {
    expect((await get(null, "collection=files&path=a-notes.md")).statusCode).toBe(401);
    expect((await get("banned", "collection=files&path=a-notes.md")).statusCode).toBe(403);
    const crash = await get("crash", "collection=files&path=a-notes.md");
    expect(crash.statusCode).toBe(500);
    expect(crash.body).not.toContain("hunter2");
  });

  it("answers 404 for a collection access hides, and keeps a folder a 400", async () => {
    // nofiles-x.md is inside the scope of `nofiles`, but `access` hides the collection from it.
    const hidden = await get("nofiles", "collection=files&path=nofiles-x.md");
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toEqual({ error: "no file preview for files" });
    expect((await get("a", "collection=files&path=a-dir")).statusCode).toBe(400);
  });

  it("is registered without options as before", async () => {
    const Fastify = (await import("fastify")).default;
    const bare = Fastify();
    registerBlobRoute(bare, makeRegistry());
    const res = await bare.inject({
      method: "GET",
      url: "/udc/files/blob?collection=files&path=b-notes.md",
    });
    expect(res.statusCode).toBe(200);
    await bare.close();
  });
});
