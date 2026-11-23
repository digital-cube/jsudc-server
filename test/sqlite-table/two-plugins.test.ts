// One process, two vaults: one Fastify app with `udcPlugin` registered twice, under
// `/vault-a` and `/vault-b`, each with its own SQLite file, registry, dispatcher (its own
// `context` and `rowScope`), change feed and Swagger. Both vaults serve a collection
// called `notes`, so a request that reached the wrong one would show. Requests, the SSE
// route and `/docs` of one never see the other; closing one leaves the other serving.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { unauthenticatedError } from "@jsudc/core";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { afterAll, beforeAll, describe, expect, it, type Mock, vi } from "vitest";
import {
  type ChangeFeed,
  createChangeFeed,
  createDispatcher,
  loadRegistry,
  makeSource,
  type SqliteDatabase,
  sqliteVersionTriggerSql,
  udcPlugin,
} from "../../src/index.js";
import { openNodeSqlite } from "../../src/sqlite.js";
import { listen, type OpenStream, openStream, received } from "../changes-helpers.js";
import { tempDir } from "./helpers.js";

interface Vault {
  name: "a" | "b";
  db: SqliteDatabase;
  feed: ChangeFeed;
  context: Mock<(req: FastifyRequest) => { user: string; vault: string }>;
  closed: boolean;
}

const ID = (v: string, n: number) =>
  `${v === "a" ? "aaaaaaaa" : "bbbbbbbb"}-0000-4000-8000-00000000000${n}`;

let app: FastifyInstance;
let base: string;
const vaults: Record<"a" | "b", Vault> = {} as Record<"a" | "b", Vault>;
const streams: OpenStream[] = [];

async function openVault(name: "a" | "b", dir: string): Promise<Vault> {
  const db = openNodeSqlite(join(dir, `vault-${name}.db`), { name: `vault-${name}` });
  await db.exec(`
    CREATE TABLE note (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1);
    ${sqliteVersionTriggerSql({ table: "note", versionColumn: "version" })}
    INSERT INTO note (id, owner, title) VALUES
      ('${ID(name, 1)}', 'ana', 'A note of vault ${name}'),
      ('${ID(name, 2)}', 'bob', 'Bob''s note of vault ${name}');`);
  const feed = createChangeFeed({ coalesce: false });
  const context = vi.fn((req: FastifyRequest) => {
    const user = req.headers["x-user"];
    if (typeof user !== "string") throw unauthenticatedError();
    return { user, vault: name };
  });
  return { name, db, feed, context, closed: false };
}

/** What a host mounts per vault: its own registry, dispatcher and change feed, under its prefix. */
async function mountVault(host: FastifyInstance, v: Vault, dir: string): Promise<void> {
  // The same collection directory for both: `database: vault` names a handle, and each
  // vault registers its own file under that name.
  const registry = loadRegistry(join(dir, "collections"), (asset, reg) =>
    makeSource(asset, { registry: reg, sqlite: { vault: v.db } }),
  );
  const dispatcher = createDispatcher<{ user: string; vault: string }>(registry, {
    log: { error: (...a: unknown[]) => console.error(...a) },
    rowScope: (ctx) => ({ field: "owner", op: "eq", value: ctx.user }),
    changes: v.feed,
  });
  await host.register(
    async (scope) => {
      // The host's guard: a closed vault is gone, every route of it answers 404.
      scope.addHook("onRequest", async (_req, reply) => {
        if (v.closed) return reply.code(404).send({ code: "not_found", message: "no such vault" });
      });
      await scope.register(udcPlugin, {
        dispatcher,
        registry,
        context: v.context,
        swagger: { title: `vault ${v.name}` },
      });
    },
    { prefix: `/vault-${v.name}` },
  );
}

beforeAll(async () => {
  const dir = tempDir();
  const notes = join(dir, "collections", "notes");
  mkdirSync(notes, { recursive: true });
  writeFileSync(
    join(notes, "schema.json"),
    JSON.stringify({
      version: "v1",
      core_fields: [],
      fields: { owner: { type: "string" }, title: { type: "string", required: true } },
    }),
  );
  writeFileSync(
    join(notes, "view.yaml"),
    "default_renderer: table\ncolumns:\n  - {field: title}\n",
  );
  writeFileSync(
    join(notes, "source.yaml"),
    "kind: sqlite_table\noptions:\n  database: vault\n  table: note\n  version_column: version\n",
  );
  vaults.a = await openVault("a", dir);
  vaults.b = await openVault("b", dir);
  app = Fastify({ logger: false });
  await mountVault(app, vaults.a, dir);
  await mountVault(app, vaults.b, dir);
  base = await listen(app);
});

afterAll(async () => {
  for (const s of streams.splice(0)) await s.stop();
  await app?.close();
  for (const v of Object.values(vaults)) {
    await v.feed.close();
    v.db.close();
  }
});

async function post(vault: string, action: string, payload: object, user = "ana") {
  const res = await app.inject({
    method: "POST",
    url: `/vault-${vault}/udc/${action}`,
    payload,
    headers: { "x-user": user },
  });
  return {
    status: res.statusCode,
    body: res.json() as { kind: string; payload: Record<string, unknown> },
  };
}

const titles = (p: Record<string, unknown>) => (p.rows as { title: string }[]).map((r) => r.title);

describe("two udcPlugin instances in one Fastify app", () => {
  it("each prefix serves its own vault, through its own context and row scope", async () => {
    vaults.a.context.mockClear();
    vaults.b.context.mockClear();
    const a = await post("a", "list", { collection: "notes" });
    expect(a.body.kind).toBe("udc.list.ok");
    expect(titles(a.body.payload)).toEqual(["A note of vault a"]);
    expect(vaults.a.context).toHaveBeenCalledTimes(1);
    expect(vaults.b.context).not.toHaveBeenCalled();
    const b = await post("b", "list", { collection: "notes" }, "bob");
    expect(titles(b.body.payload)).toEqual(["Bob's note of vault b"]);
    expect(vaults.a.context).toHaveBeenCalledTimes(1);
    expect(vaults.b.context).toHaveBeenCalledTimes(1);
  });

  it("a write lands in its own vault's file only", async () => {
    const res = await post("a", "mutate", {
      collection: "notes",
      op: "insert",
      row: { title: "Written to a" },
    });
    expect(res.body.kind, JSON.stringify(res.body.payload)).toBe("udc.mutate.ok");
    expect(
      titles(
        (await post("a", "list", { collection: "notes", sort: [{ field: "title" }] })).body.payload,
      ),
    ).toEqual(["A note of vault a", "Written to a"]);
    expect(titles((await post("b", "list", { collection: "notes" })).body.payload)).toEqual([
      "A note of vault b",
    ]);
  });

  it("GET /healthz under each prefix", async () => {
    for (const v of ["a", "b"]) {
      const res = await app.inject({ url: `/vault-${v}/healthz` });
      expect(res.statusCode).toBe(200);
    }
  });

  it("each /docs documents its own vault: its title, its prefix's routes only", async () => {
    for (const [v, other] of [
      ["a", "b"],
      ["b", "a"],
    ]) {
      const res = await app.inject({ url: `/vault-${v}/docs/json` });
      expect(res.statusCode).toBe(200);
      const doc = res.json() as { info: { title: string }; paths: Record<string, unknown> };
      expect(doc.info.title).toBe(`vault ${v}`);
      const paths = Object.keys(doc.paths);
      expect(paths).toContain(`/vault-${v}/udc/list`);
      expect(
        paths.every((p) => p.startsWith(`/vault-${v}/`)),
        paths.join(", "),
      ).toBe(true);
      expect(paths.some((p) => p.startsWith(`/vault-${other}/`))).toBe(false);
      const ui = await app.inject({ url: `/vault-${v}/docs/` });
      expect(ui.statusCode).toBe(200);
      expect(ui.headers["content-type"]).toMatch(/text\/html/);
    }
  });

  it("a stream of one vault hears its own writes, never the other's", async () => {
    const sa = await openStream(base, ["notes"], { "x-user": "ana" }, { prefix: "/vault-a" });
    const sb = await openStream(base, ["notes"], { "x-user": "ana" }, { prefix: "/vault-b" });
    streams.push(sa, sb);
    const wb = await post("b", "mutate", {
      collection: "notes",
      op: "insert",
      row: { title: "b only" },
    });
    const idB = (wb.body.payload.row as { __meta: { id: string } }).__meta.id;
    await received(sb, { collection: "notes", op: "insert", ids: [idB] });
    const wa = await post("a", "mutate", {
      collection: "notes",
      op: "insert",
      row: { title: "a only" },
    });
    const idA = (wa.body.payload.row as { __meta: { id: string } }).__meta.id;
    await received(sa, { collection: "notes", op: "insert", ids: [idA] });
    // Each stream has seen exactly its own vault's write.
    expect(sa.events.flatMap((e) => e.ids ?? [])).toEqual([idA]);
    expect(sb.events.flatMap((e) => e.ids ?? [])).toEqual([idB]);
  });

  it("closing one vault ends its streams and leaves the other serving", async () => {
    const sa = await openStream(base, ["notes"], { "x-user": "ana" }, { prefix: "/vault-a" });
    const sb = await openStream(base, ["notes"], { "x-user": "ana" }, { prefix: "/vault-b" });
    streams.push(sa, sb);

    // Closing vault a's feed ends its open stream; the client's reconnect reaches the route
    // of a closed feed, which answers 404, and the client gives up.
    await vaults.a.feed.close();
    await expect(sa.done).rejects.toMatchObject({ code: "not_found" });
    expect(vaults.a.feed.listenerCount).toBe(0);
    // Then the rest of what a host does: stop routing to the vault, close its file.
    vaults.a.closed = true;
    vaults.a.db.close();
    expect((await post("a", "list", { collection: "notes" })).status).toBe(404);
    expect((await app.inject({ url: "/vault-a/docs/json" })).statusCode).toBe(404);

    // Vault b: requests, its stream, its docs.
    const b = await post("b", "list", { collection: "notes" });
    expect(b.body.kind).toBe("udc.list.ok");
    const wb = await post("b", "mutate", {
      collection: "notes",
      op: "insert",
      row: { title: "after a closed" },
    });
    expect(wb.body.kind).toBe("udc.mutate.ok");
    const id = (wb.body.payload.row as { __meta: { id: string } }).__meta.id;
    await received(sb, { collection: "notes", op: "insert", ids: [id] });
    expect((await app.inject({ url: "/vault-b/docs/json" })).statusCode).toBe(200);
  });
});
