// Writes another process makes to a SQLite file reach the change feed: the wrapper polls
// `PRAGMA data_version` on its write connection (`watch`), and a dispatcher with a feed
// tells every stream of each collection served from the file, without ids. A raw
// connection of the same driver stands in for the other process (two SQLite builds in one
// process do not share locks, so it must be the wrapper's own driver).
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import {
  type ChangeEvent,
  type FilterNode,
  requestKind,
  type SchemaDocInput,
  SchemaDocSchema,
  ViewConfigSchema,
} from "@jsudc/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { betterSqliteConnection } from "../../src/better-sqlite3.js";
import { type ChangeNotice, createChangeFeed, MemoryChangeBus } from "../../src/changes.js";
import { createDispatcher, type Dispatcher } from "../../src/dispatcher.js";
import { CollectionRegistry } from "../../src/registry.js";
import {
  DEFAULT_SQLITE_WATCH_MS,
  nodeSqliteConnection,
  type SqliteConnection,
  SqliteDatabase,
  SqliteTableSource,
} from "../../src/sqlite.js";
import { DRIVERS, type Driver, openWith, tempFile } from "./helpers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The interval the suites poll at. */
const TICK = 20;

/** A raw connection to `path` with `driver`: another process, as far as the wrapper can tell. */
function rawConnection(driver: Driver, path: string): SqliteConnection {
  if (driver === "node:sqlite") {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA busy_timeout = 5000");
    return nodeSqliteConnection(db);
  }
  const Database = createRequire(import.meta.url)("better-sqlite3") as new (
    path: string,
  ) => Parameters<typeof betterSqliteConnection>[0];
  const db = new Database(path);
  db.exec("PRAGMA busy_timeout = 5000");
  return betterSqliteConnection(db);
}

/** `conn`, counting the `PRAGMA data_version` statements run on it. */
function counting(conn: SqliteConnection): SqliteConnection & { polls: number } {
  const wrapped = {
    polls: 0,
    all: (sql: string, params: readonly unknown[]) => {
      if (/data_version/i.test(sql)) wrapped.polls += 1;
      return conn.all(sql, params);
    },
    values: conn.values.bind(conn),
    run: conn.run.bind(conn),
    exec: conn.exec.bind(conn),
    close: conn.close.bind(conn),
  };
  return wrapped;
}

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

const schema = SchemaDocSchema.parse({
  version: "v1",
  fields: { tenant: { type: "string" }, subject: { type: "string", required: true } },
} satisfies SchemaDocInput);
const view = ViewConfigSchema.parse({ columns: [{ field: "subject" }] });

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const DDL = ["ext_task", "ext_note"]
  .map(
    (t) => `CREATE TABLE ${t} (
      id TEXT PRIMARY KEY, tenant TEXT, subject TEXT NOT NULL,
      row_version INTEGER NOT NULL DEFAULT 1);`,
  )
  .join("\n");

interface Ctx {
  tenant: string | null;
}
const rowScope = (ctx: Ctx): FilterNode | undefined =>
  ctx?.tenant ? { field: "tenant", op: "eq", value: ctx.tenant } : undefined;

describe.each(DRIVERS)("SqliteDatabase watch (%s)", (driver) => {
  async function setup(watch: boolean | { intervalMs?: number } | undefined) {
    const path = tempFile();
    const db = await openWith(driver, path, watch === undefined ? {} : { watch });
    await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    const other = rawConnection(driver, path);
    closers.push(() => other.close());
    const heard: number[] = [];
    const stop = db.onExternalWrite(() => heard.push(Date.now()));
    return { db, other, heard, stop };
  }

  it("another connection's commit is heard once, within the interval", async () => {
    const { db, other, heard } = await setup({ intervalMs: TICK });
    expect(db.watchIntervalMs).toBe(TICK);
    expect(db.watching).toBe(true);
    await sleep(TICK * 3);
    expect(heard).toEqual([]);
    const at = Date.now();
    other.run("INSERT INTO t (v) VALUES (?)", ["outside"]);
    await vi.waitFor(() => expect(heard).toHaveLength(1), { timeout: TICK * 10, interval: 5 });
    expect((heard[0] ?? 0) - at).toBeLessThanOrEqual(TICK * 5);
    await sleep(TICK * 4);
    expect(heard).toHaveLength(1);
  });

  it("several commits between two polls are one call", async () => {
    const { db, other, heard } = await setup({ intervalMs: 60_000 });
    for (let i = 0; i < 5; i++) other.run("INSERT INTO t (v) VALUES (?)", [`x${i}`]);
    expect(db.pollExternalWrites()).toBe(true);
    expect(heard).toHaveLength(1);
    expect(db.pollExternalWrites()).toBe(false);
    expect(heard).toHaveLength(1);
  });

  it("the wrapper's own commits are never heard: run, exec, transaction, proxy", async () => {
    const { db, heard } = await setup({ intervalMs: TICK });
    await db.run("INSERT INTO t (v) VALUES ('own')");
    await db.exec("UPDATE t SET v = 'own2'");
    await db.transaction(async (tx) => {
      tx.run("INSERT INTO t (v) VALUES ('tx')");
      await db.transaction((inner) => inner.run("INSERT INTO t (v) VALUES ('sp')"));
    });
    await db.proxy("DELETE FROM t WHERE v = ?", ["tx"], "run");
    await sleep(TICK * 4);
    expect(db.pollExternalWrites()).toBe(false);
    expect(heard).toEqual([]);
  });

  it("an external commit between two of ours is still heard", async () => {
    const { db, other, heard } = await setup({ intervalMs: 60_000 });
    await db.run("INSERT INTO t (v) VALUES ('own')");
    other.run("INSERT INTO t (v) VALUES (?)", ["outside"]);
    await db.run("INSERT INTO t (v) VALUES ('own again')");
    expect(db.pollExternalWrites()).toBe(true);
    expect(heard).toHaveLength(1);
  });

  it("no poll while a transaction of ours is open; the next one sees the change", async () => {
    const { db, other, heard } = await setup({ intervalMs: 60_000 });
    other.run("INSERT INTO t (v) VALUES (?)", ["outside"]);
    await db.transaction(async () => {
      expect(db.pollExternalWrites()).toBe(false);
    });
    expect(db.pollExternalWrites()).toBe(true);
    expect(heard).toHaveLength(1);
  });

  it("a throwing listener does not keep the others from hearing", async () => {
    const { db, other, heard } = await setup({ intervalMs: 60_000 });
    db.onExternalWrite(() => {
      throw new Error("boom");
    });
    other.run("INSERT INTO t (v) VALUES (?)", ["outside"]);
    expect(db.pollExternalWrites()).toBe(true);
    expect(heard).toHaveLength(1);
  });

  it("polling stops with the last unsubscribe, and at close", async () => {
    const { db, stop } = await setup({ intervalMs: TICK });
    const second = db.onExternalWrite(() => undefined);
    stop();
    expect(db.watching).toBe(true);
    second();
    expect(db.watching).toBe(false);
    db.onExternalWrite(() => undefined);
    expect(db.watching).toBe(true);
    db.close();
    expect(db.watching).toBe(false);
    expect(db.pollExternalWrites()).toBe(false);
  });

  it("watch: true polls every DEFAULT_SQLITE_WATCH_MS", async () => {
    const { db } = await setup(true);
    expect(DEFAULT_SQLITE_WATCH_MS).toBe(1000);
    expect(db.watchIntervalMs).toBe(DEFAULT_SQLITE_WATCH_MS);
    expect(db.watching).toBe(true);
  });

  it("off by default: nothing polls, and an external write is not heard", async () => {
    const { db, other, heard } = await setup(undefined);
    expect(db.watchIntervalMs).toBeUndefined();
    expect(db.watching).toBe(false);
    other.run("INSERT INTO t (v) VALUES (?)", ["outside"]);
    expect(db.pollExternalWrites()).toBe(false);
    expect(heard).toEqual([]);
  });

  it("a bad interval is refused", async () => {
    await expect(openWith(driver, tempFile(), { watch: { intervalMs: 0 } })).rejects.toThrow(
      /intervalMs/,
    );
    await expect(openWith(driver, tempFile(), { watch: { intervalMs: 1.5 } })).rejects.toThrow(
      /intervalMs/,
    );
  });
});

describe("SqliteDatabase watch: the statements it runs", () => {
  /** A wrapper over a counting write connection to a new file (node:sqlite). */
  function wrapper(watch: boolean | { intervalMs: number } | undefined) {
    const path = tempFile();
    const write = counting(nodeSqliteConnection(new DatabaseSync(path)));
    const db = new SqliteDatabase({ write, ...(watch === undefined ? {} : { watch }) });
    closers.push(() => db.close());
    return { db, write };
  }

  it("with the option off, nothing polls even with listeners", async () => {
    const { db, write } = wrapper(undefined);
    db.onExternalWrite(() => undefined);
    await sleep(TICK * 5);
    expect(write.polls).toBe(0);
    const off = wrapper(false);
    off.db.onExternalWrite(() => undefined);
    await sleep(TICK * 2);
    expect(off.write.polls).toBe(0);
  });

  it("with the option on, nothing polls until a listener is registered; then every interval", async () => {
    const { db, write } = wrapper({ intervalMs: TICK });
    await sleep(TICK * 3);
    expect(write.polls).toBe(0);
    const stop = db.onExternalWrite(() => undefined);
    await vi.waitFor(() => expect(write.polls).toBeGreaterThanOrEqual(3), { timeout: TICK * 20 });
    stop();
    const after = write.polls;
    await sleep(TICK * 3);
    expect(write.polls).toBe(after);
  });
});

describe.each(DRIVERS)("external writes reach the change feed (%s)", (driver) => {
  let dispatcher: Dispatcher;
  let bus: { notices: ChangeNotice[] } & MemoryChangeBus;
  let db: SqliteDatabase;
  let other: SqliteConnection;
  let toA: ChangeEvent[];
  let toB: ChangeEvent[];
  let toAdmin: ChangeEvent[];
  let feed: ReturnType<typeof createChangeFeed>;

  async function build(watch: { intervalMs: number } | undefined) {
    const path = tempFile();
    db = await openWith(driver, path, watch ? { watch } : {});
    await db.exec(DDL);
    other = rawConnection(driver, path);
    closers.push(() => other.close());
    const registry = new CollectionRegistry();
    for (const table of ["ext_task", "ext_note"]) {
      registry.register({
        name: table,
        source: new SqliteTableSource({ db, schema, table, versionColumn: "row_version" }),
        view,
      });
    }
    const notices: ChangeNotice[] = [];
    bus = Object.assign(new MemoryChangeBus(), { notices });
    const publish = bus.publish.bind(bus);
    bus.publish = (n: ChangeNotice) => {
      notices.push(n);
      publish(n);
    };
    feed = createChangeFeed({ bus });
    dispatcher = createDispatcher<Ctx>(registry, {
      log: { error: vi.fn() },
      rowScope,
      changes: feed,
    });
    toA = [];
    toB = [];
    toAdmin = [];
    const both = (ctx: Ctx) =>
      new Map([
        ["ext_task", rowScope(ctx)],
        ["ext_note", rowScope(ctx)],
      ]);
    feed.subscribe({ scopes: both({ tenant: "a" }), send: (e) => toA.push(e) });
    feed.subscribe({
      scopes: new Map([["ext_task", rowScope({ tenant: "b" })]]),
      send: (e) => toB.push(e),
    });
    feed.subscribe({ scopes: both({ tenant: null }), send: (e) => toAdmin.push(e) });
  }

  const byCollection = (events: ChangeEvent[]) =>
    [...events].sort((x, y) => x.collection.localeCompare(y.collection));

  it("another process's row: one event per collection of the file, to every stream, no ids", async () => {
    await build({ intervalMs: TICK });
    other.run("INSERT INTO ext_task (id, tenant, subject) VALUES (?, ?, ?)", [
      uuid(1),
      "a",
      "outside",
    ]);
    await vi.waitFor(() => expect(toAdmin).toHaveLength(2), { timeout: TICK * 10, interval: 5 });
    await sleep(TICK * 4);
    const coarse = (collection: string) => ({ collection, op: "update" });
    expect(byCollection(toAdmin)).toEqual([coarse("ext_note"), coarse("ext_task")]);
    // Scoped streams too: their scope cannot be tested without rows.
    expect(byCollection(toA)).toEqual([coarse("ext_note"), coarse("ext_task")]);
    expect(toB).toEqual([coarse("ext_task")]);
    // Local only: every process that watches the file notices the write itself.
    expect(bus.notices).toEqual([]);
  });

  it("a write through the source: its exact notice, and no coarse one after it", async () => {
    await build({ intervalMs: TICK });
    const res = await dispatcher.dispatch(
      {
        kind: requestKind("mutate"),
        id: "t",
        payload: {
          collection: "ext_task",
          op: "insert",
          row: { subject: "own" },
        },
      },
      { tenant: "a" },
    );
    expect(res.kind, JSON.stringify(res.payload)).toBe("udc.mutate.ok");
    const id = (res.payload as { row: { __meta: { id: string } } }).row.__meta.id;
    await sleep(TICK * 6);
    expect(bus.notices).toHaveLength(1);
    expect(toA).toEqual([{ collection: "ext_task", op: "insert", ids: [id] }]);
    expect(toAdmin).toEqual([{ collection: "ext_task", op: "insert", ids: [id] }]);
    expect(toB).toEqual([]);
  });

  it("a burst of external writes is coalesced like any other", async () => {
    await build({ intervalMs: 60_000 });
    for (let i = 0; i < 30; i++) {
      other.run("INSERT INTO ext_task (id, tenant, subject) VALUES (?, 'a', 'x')", [uuid(100 + i)]);
      db.pollExternalWrites();
    }
    // 20 events per collection per 250 ms window, then one held for the rest.
    expect(toAdmin.filter((e) => e.collection === "ext_task")).toHaveLength(20);
    await vi.waitFor(
      () => expect(toAdmin.filter((e) => e.collection === "ext_task")).toHaveLength(21),
      { timeout: 1000 },
    );
  });

  it("without watch, nothing polls and nothing is announced", async () => {
    await build(undefined);
    expect(db.watching).toBe(false);
    other.run("INSERT INTO ext_task (id, tenant, subject) VALUES (?, 'a', 'x')", [uuid(3)]);
    await sleep(TICK * 4);
    expect([...toA, ...toB, ...toAdmin]).toEqual([]);
  });

  it("closing the feed stops watching the file", async () => {
    await build({ intervalMs: TICK });
    expect(db.watching).toBe(true);
    await feed.close();
    expect(db.watching).toBe(false);
  });
});
