// @jsudc/server/testing: one SQLite database and one ready server per test file, for a
// host's own tests. `openTestApp` opens `:memory:` (or a file in a temp directory of
// its own) through the wrapper, runs the host's DDL, registers the collections over it
// and answers a `buildApp({ swagger: false })` that is already `ready()`; `close()`
// undoes all of it. Nothing is shared between two calls. No test runner is imported:
// call it from `beforeAll` / `beforeEach` of whichever runner the host uses.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { buildApp } from "./app.js";
import { type ChangeFeed, createChangeFeed } from "./changes.js";
import { createDispatcher, type Dispatcher, type DispatcherOptions } from "./dispatcher.js";
import { type Collection, CollectionRegistry, loadRegistry } from "./registry.js";
import { makeSource, type SourceDeps } from "./sources/factory.js";
import type { SqliteDatabase } from "./sqlite-database.js";
import { openNodeSqlite } from "./sqlite-node.js";

/** The UDC envelope an action answers with (`kind` ends in `.ok` or `.err`). */
export interface TestEnvelope<P = Record<string, unknown>> {
  kind: string;
  id: string;
  payload: P;
}

export interface OpenTestAppOptions<Ctx = unknown> {
  /**
   * The collections: a directory of collection directories (`schema.json`,
   * `view.yaml`, `source.yaml`), made by the root entry's `makeSource` with
   * this database as `SourceDeps.sqlite[database]` — or a function that
   * answers the collections to register, given the opened database.
   */
  collections: string | ((db: SqliteDatabase) => Iterable<Collection>);
  /** The host's DDL (and any seed rows), run in order on the fresh database before the collections are made. */
  ddl?: string | readonly string[] | undefined;
  /** `memory` (default): `:memory:`. `file`: `test.db` in a new temp directory, removed by `close()`. */
  where?: "memory" | "file" | undefined;
  /** The name a `sqlite_table` collection's `database` option gives. Default `main`. */
  database?: string | undefined;
  /** How the database is opened. Default `openNodeSqlite` (`node:sqlite`); pass `openBetterSqlite` for that driver. */
  open?: ((path: string, opts: { name: string }) => SqliteDatabase) | undefined;
  /** Who is asking, as in `udcPlugin`'s `context`. */
  context?: ((request: FastifyRequest) => Ctx) | undefined;
  /** The dispatcher's `rowScope`, `access`, … (its `log` defaults to `console.error`). */
  dispatcher?: Partial<Omit<DispatcherOptions<Ctx>, "changes">> | undefined;
  /** A change feed (`createChangeFeed()`): `GET /udc/changes` is served. Default off. */
  changes?: boolean | undefined;
  /** The rest of `SourceDeps` for a directory of collections (`env`, `fetch`, …). */
  sourceDeps?: Omit<SourceDeps, "sqlite" | "registry"> | undefined;
}

export interface TestApp {
  /** The Fastify instance, ready: `app.inject(...)`, or `app.listen(...)` for a real client. */
  app: FastifyInstance;
  /** The database the collections read and write: the test's own SQL goes through it too. */
  db: SqliteDatabase;
  registry: CollectionRegistry;
  dispatcher: Dispatcher;
  /** The change feed, when `changes: true`. */
  changes: ChangeFeed | undefined;
  /** The database file, or `:memory:`. */
  path: string;
  /** `POST /udc/<action>` through `app.inject`; the envelope, whatever its kind. Throws on an HTTP status other than 200. */
  call<P = Record<string, unknown>>(
    action: string,
    payload: unknown,
    headers?: Record<string, string>,
  ): Promise<TestEnvelope<P>>;
  /** Closes the app, the change feed and the database, and removes the temp directory. Safe to call twice. */
  close(): Promise<void>;
}

/**
 * A SQLite database and a ready `buildApp` over the given collections: one per
 * test file (or per test), nothing shared.
 *
 * ```ts
 * let t: TestApp;
 * beforeAll(async () => {
 *   t = await openTestApp({ collections: "collections", ddl: readFileSync("schema.sql", "utf8") });
 * });
 * afterAll(() => t.close());
 * it("lists", async () => expect((await t.call("list", { collection: "tasks" })).kind).toBe("udc.list.ok"));
 * ```
 */
export async function openTestApp<Ctx = unknown>(opts: OpenTestAppOptions<Ctx>): Promise<TestApp> {
  const name = opts.database ?? "main";
  const dir = opts.where === "file" ? mkdtempSync(join(tmpdir(), "jsudc-test-")) : undefined;
  const path = dir ? join(dir, "test.db") : ":memory:";
  const open = opts.open ?? ((p: string, o: { name: string }) => openNodeSqlite(p, o));
  let db: SqliteDatabase | undefined;
  let feed: ChangeFeed | undefined;
  let app: FastifyInstance | undefined;
  let closed = false;

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      await app?.close();
      await feed?.close();
    } finally {
      db?.close();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  };

  try {
    db = open(path, { name });
    const ddl = opts.ddl === undefined ? [] : typeof opts.ddl === "string" ? [opts.ddl] : opts.ddl;
    for (const text of ddl) await db.exec(text);

    const opened = db;
    let registry: CollectionRegistry;
    if (typeof opts.collections === "string") {
      registry = loadRegistry(opts.collections, (asset, reg) =>
        makeSource(asset, { ...opts.sourceDeps, registry: reg, sqlite: { [name]: opened } }),
      );
    } else {
      registry = new CollectionRegistry();
      for (const def of opts.collections(opened)) registry.register(def);
    }

    feed = opts.changes ? createChangeFeed() : undefined;
    const dispatcher = createDispatcher<Ctx>(registry, {
      log: { error: (...args: unknown[]) => console.error(...args) },
      ...opts.dispatcher,
      changes: feed,
    } as DispatcherOptions<Ctx>);
    app = await buildApp({
      dispatcher,
      registry,
      swagger: false,
      ...(opts.context ? { context: opts.context } : {}),
    });
    await app.ready();

    const ready = app;
    return {
      app: ready,
      db: opened,
      registry,
      dispatcher,
      changes: feed,
      path,
      async call<P>(action: string, payload: unknown, headers: Record<string, string> = {}) {
        const res = await ready.inject({
          method: "POST",
          url: `/udc/${action}`,
          payload: payload as object,
          headers,
        });
        if (res.statusCode !== 200) {
          throw new Error(`POST /udc/${action}: HTTP ${res.statusCode} ${res.body}`);
        }
        return res.json() as TestEnvelope<P>;
      },
      close,
    };
  } catch (err) {
    await close();
    throw err;
  }
}
