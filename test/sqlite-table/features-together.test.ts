// Where the 0.8.0 features meet, each written on its own branch: a WAL checkpoint while
// `data_version` is watched, FTS5 search on a collection of a second SQLite file, and
// closing one vault's change feed while another vault's file is watched.
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import {
  type ChangeEvent,
  type ListResponse,
  requestKind,
  SchemaDocSchema,
  ViewConfigSchema,
} from "@jsudc/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { betterSqliteConnection } from "../../src/better-sqlite3.js";
import { createChangeFeed } from "../../src/changes.js";
import { createDispatcher } from "../../src/dispatcher.js";
import { CollectionRegistry } from "../../src/registry.js";
import {
  nodeSqliteConnection,
  type SqliteConnection,
  type SqliteDatabase,
  SqliteTableSource,
  sqliteFts5Search,
  sqliteFts5Sql,
} from "../../src/sqlite.js";
import { DRIVERS, type Driver, openWith, tempFile } from "./helpers.js";

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

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

const schema = SchemaDocSchema.parse({
  version: "v1",
  fields: { owner: { type: "string" }, title: { type: "string" } },
});
const view = ViewConfigSchema.parse({ columns: [{ field: "title" }] });

const table = (name: string) => `CREATE TABLE ${name} (
  id TEXT PRIMARY KEY, owner TEXT, title TEXT, row_version INTEGER NOT NULL DEFAULT 1)`;

const ids = (res: ListResponse) => res.rows.map((r) => r.__meta.id);

describe.each(DRIVERS)("checkpoint() while data_version is watched (%s)", (driver) => {
  // A poll interval no test reaches: every poll is an explicit pollExternalWrites().
  async function setup(busyTimeoutMs?: number) {
    const path = tempFile("vault.db");
    const db = await openWith(driver, path, {
      watch: { intervalMs: 60_000 },
      ...(busyTimeoutMs ? { busyTimeoutMs } : {}),
    });
    await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    const other = rawConnection(driver, path);
    closers.push(() => other.close());
    const heard: number[] = [];
    closers.push(db.onExternalWrite(() => heard.push(1)));
    return { db, path, other, heard };
  }

  it("the wrapper's own checkpoint is not an external write; another connection's commit still is", async () => {
    const { db, other, heard } = await setup();
    for (let i = 0; i < 10; i++) await db.run(`INSERT INTO t (v) VALUES ('own ${i}')`);
    const result = await db.checkpoint();
    expect(result.busy).toBe(false);
    expect(result.log).toBe(0);
    expect(db.pollExternalWrites()).toBe(false);
    expect(heard).toEqual([]);

    other.run("INSERT INTO t (v) VALUES (?)", ["outside"]);
    expect(db.pollExternalWrites()).toBe(true);
    expect(heard).toHaveLength(1);

    // A checkpoint folding the other connection's frames in announces nothing new.
    expect((await db.checkpoint()).busy).toBe(false);
    expect(db.pollExternalWrites()).toBe(false);
    expect(heard).toHaveLength(1);
    expect((await db.get<{ n: number }>("SELECT count(*) AS n FROM t"))?.n).toBe(11);
  });

  it("the poll waits while a checkpoint holds the write turn, and hears the commit after", async () => {
    const { db, path, other, heard } = await setup(150);
    await db.run("INSERT INTO t (v) VALUES ('own')");
    // A reader of another process on the WAL: TRUNCATE retries until busyTimeoutMs.
    const reader = rawConnection(driver, path);
    closers.push(() => reader.close());
    reader.exec("BEGIN");
    reader.all("SELECT count(*) AS n FROM t", []);

    const pending = db.checkpoint();
    // Another connection commits while the checkpoint waits for the reader.
    other.run("INSERT INTO t (v) VALUES (?)", ["during"]);
    expect(db.pollExternalWrites()).toBe(false); // the turn is held: the next poll sees it
    expect(heard).toEqual([]);

    const result = await pending;
    expect(result.busy).toBe(true);
    expect(db.pollExternalWrites()).toBe(true);
    expect(heard).toHaveLength(1);
    reader.exec("COMMIT");
    expect((await db.checkpoint()).busy).toBe(false);
  });
});

/** The file each wrapper of the next suite was opened on. */
const paths = new WeakMap<SqliteDatabase, string>();
function tempPathOf(db: SqliteDatabase): string {
  const path = paths.get(db);
  if (!path) throw new Error("no path recorded for this database");
  return path;
}
async function openRecorded(
  driver: Driver,
  path: string,
  opts: Parameters<typeof openWith>[2] = {},
): Promise<SqliteDatabase> {
  const db = await openWith(driver, path, opts);
  paths.set(db, path);
  return db;
}

describe.each(DRIVERS)("several SQLite files with search and watch (%s)", (driver) => {
  /** `boards` in boards.db, `notes` in notes.db with FTS5 search; both files watched. */
  async function vaults() {
    const boardsDb = await openRecorded(driver, tempFile("boards.db"), {
      watch: { intervalMs: 60_000 },
    });
    const notesPath = tempFile("notes.db");
    const notesDb = await openRecorded(driver, notesPath, { watch: { intervalMs: 60_000 } });
    await boardsDb.exec(table("board"));
    await notesDb.exec(table("note"));
    await notesDb.exec(sqliteFts5Sql({ table: "note", columns: ["title"] }));
    const boards = new SqliteTableSource({
      db: boardsDb,
      schema,
      table: "board",
      versionColumn: "row_version",
    });
    const notes = new SqliteTableSource({
      db: notesDb,
      schema,
      table: "note",
      versionColumn: "row_version",
      search: sqliteFts5Search({ table: "note" }),
    });
    return { boardsDb, notesDb, notesPath, boards, notes };
  }

  function served(sources: Record<string, SqliteTableSource>) {
    const registry = new CollectionRegistry();
    for (const [name, source] of Object.entries(sources)) {
      registry.register({ name, source, view });
    }
    const feed = createChangeFeed();
    const dispatcher = createDispatcher(registry, { log: { error: vi.fn() }, changes: feed });
    const call = async (kind: "list" | "mutate", payload: object) => {
      const res = await dispatcher.dispatch(
        { kind: requestKind(kind), id: "1", payload },
        undefined,
      );
      expect(res.kind, JSON.stringify(res.payload)).toBe(`${requestKind(kind)}.ok`);
      return res.payload;
    };
    return { feed, call };
  }

  it("search answers on the collection of the second file; a write through the dispatcher is found", async () => {
    const { boardsDb, notesDb, boards, notes } = await vaults();
    expect(notes.capabilities.search).toBe("source");
    expect("search" in boards.capabilities).toBe(false);
    const { call } = served({ boards, notes });

    await call("mutate", { collection: "boards", op: "insert", row: { title: "Zebra board" } });
    const inserted = (await call("mutate", {
      collection: "notes",
      op: "insert",
      row: { owner: "ana", title: "Zebra crossing" },
    })) as { row: { __meta: { id: string } } };
    await call("mutate", {
      collection: "notes",
      op: "insert",
      row: { owner: "bob", title: "Okapi" },
    });

    const found = (await call("list", { collection: "notes", search: "zebra" })) as ListResponse;
    expect(ids(found)).toEqual([inserted.row.__meta.id]);
    // The FTS5 table lives in notes.db only; boards.db has none.
    const fts = (db: SqliteDatabase) =>
      db.get<{ n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE '%_fts%'");
    expect((await fts(notesDb))?.n).toBeGreaterThan(0);
    expect((await fts(boardsDb))?.n).toBe(0);
  });

  it("a row another process writes into the second file is searchable and announced on its stream", async () => {
    const { notesDb, notesPath, boards, notes } = await vaults();
    const { feed, call } = served({ boards, notes });
    const events: ChangeEvent[] = [];
    feed.subscribe({
      scopes: new Map([
        ["boards", undefined],
        ["notes", undefined],
      ]),
      send: (e) => events.push(e),
    });
    const other = rawConnection(driver, notesPath);
    closers.push(() => other.close());

    other.run("INSERT INTO note (id, owner, title) VALUES (?, ?, ?)", [
      "00000000-0000-4000-8000-000000000001",
      "ana",
      "Zebra from outside",
    ]);
    expect(notesDb.pollExternalWrites()).toBe(true);
    expect(events).toEqual([{ collection: "notes", op: "update" }]);
    const found = (await call("list", { collection: "notes", search: "zebra" })) as ListResponse;
    expect(ids(found)).toEqual(["00000000-0000-4000-8000-000000000001"]);
  });

  it("closing one vault's feed stops watching its file; the other vault keeps watching its own", async () => {
    const { boardsDb, notesDb, boards, notes } = await vaults();
    const a = served({ boards });
    const b = served({ notes });
    expect(boardsDb.watching).toBe(true);
    expect(notesDb.watching).toBe(true);

    await a.feed.close();
    expect(boardsDb.watching).toBe(false);
    expect(notesDb.watching).toBe(true);
    // A closed feed starts no new watch (a vault shutting down).
    a.feed.watchExternal("boards", boards);
    expect(boardsDb.watching).toBe(false);

    const events: ChangeEvent[] = [];
    b.feed.subscribe({ scopes: new Map([["notes", undefined]]), send: (e) => events.push(e) });
    const other = rawConnection(driver, tempPathOf(notesDb));
    closers.push(() => other.close());
    other.run("INSERT INTO note (id, owner, title) VALUES (?, ?, ?)", [
      "00000000-0000-4000-8000-000000000002",
      "ana",
      "still heard",
    ]);
    expect(notesDb.pollExternalWrites()).toBe(true);
    expect(events).toEqual([{ collection: "notes", op: "update" }]);
  });
});
