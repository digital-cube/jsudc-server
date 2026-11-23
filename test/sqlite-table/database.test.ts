// SqliteDatabase, the one object per SQLite file: the in-process write queue, BEGIN
// IMMEDIATE against another process (a second wrapper on the same file stands in for it),
// the busy error, a host's writes inside a transaction (savepoints, the source's own
// transaction), and Drizzle through drizzle-orm/sqlite-proxy.
import { DatabaseSync } from "node:sqlite";
import { isBusy, SchemaDocSchema, UdcError, ViewConfigSchema } from "@jsudc/core";
import { eq } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { describe, expect, it, vi } from "vitest";
import { createDispatcher } from "../../src/dispatcher.js";
import { CollectionRegistry } from "../../src/registry.js";
import type { SourceContext } from "../../src/sources/source.js";
import {
  isSqliteBusy,
  nodeSqliteConnection,
  openNodeSqlite,
  SqliteDatabase,
  SqliteTableSource,
} from "../../src/sqlite.js";
import { openDb, rejectsWith, tempFile } from "./helpers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A promise and the function that settles it. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => {
    open = r;
  });
  return { open, opened };
}

const count = async (db: SqliteDatabase, table = "t") =>
  (await db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))?.n;

/** Two wrappers on one file: `a` and `b` stand for two processes. */
async function twoProcesses(bTimeout = 5000) {
  const file = tempFile();
  const a = openNodeSqlite(file, { name: "vault" });
  await a.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  const b = openNodeSqlite(file, { name: "vault", busyTimeoutMs: bTimeout });
  return {
    a,
    b,
    [Symbol.dispose]() {
      a.close();
      b.close();
    },
  };
}

describe("one file, two processes", () => {
  it("opens the file in WAL mode", async () => {
    using p = await twoProcesses();
    expect((await p.a.get<{ journal_mode: string }>("PRAGMA journal_mode"))?.journal_mode).toBe(
      "wal",
    );
  });

  it("a write while the other holds a write transaction waits, then succeeds", async () => {
    using p = await twoProcesses();
    const release = gate();
    const held = p.a.transaction(async (tx) => {
      tx.run("INSERT INTO t (v) VALUES ('a')");
      await release.opened;
    });
    await sleep(10);
    let done = false;
    const started = Date.now();
    const write = p.b.run("INSERT INTO t (v) VALUES ('b')").then((r) => {
      done = true;
      return r;
    });
    // Reads of the waiting side are not blocked, and see only what is committed.
    expect(await count(p.b)).toBe(0);
    await sleep(150);
    expect(done).toBe(false);
    release.open();
    await held;
    expect((await write).changes).toBe(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(await p.b.all("SELECT v FROM t ORDER BY id")).toEqual([{ v: "a" }, { v: "b" }]);
  });

  it("a lock held longer than busyTimeoutMs answers busy, and nothing is written", async () => {
    using p = await twoProcesses(100);
    const release = gate();
    const held = p.a.transaction(async () => {
      await release.opened;
    });
    await sleep(10);
    const err = await rejectsWith(p.b.run("INSERT INTO t (v) VALUES ('b')"), "busy");
    expect(isBusy(err)).toBe(true);
    expect(err.details).toMatchObject({ database: "vault" });
    expect(err.details?.waited_ms).toBeGreaterThanOrEqual(100);
    expect(err.message).toMatch(/locked by another writer/);
    release.open();
    await held;
    expect(await count(p.b)).toBe(0);
    // Free again: the same write goes through.
    await p.b.run("INSERT INTO t (v) VALUES ('b')");
    expect(await count(p.a)).toBe(1);
  });

  it("the source on the waiting side: a mutate waits, or is answered busy over the dispatcher", async () => {
    using p = await twoProcesses(80);
    await p.a.exec("CREATE TABLE note (id TEXT PRIMARY KEY, title TEXT, version INTEGER)");
    const schema = SchemaDocSchema.parse({ version: "v1", fields: { title: { type: "string" } } });
    const source = new SqliteTableSource({
      db: p.b,
      schema,
      table: "note",
      versionColumn: "version",
    });
    const registry = new CollectionRegistry();
    registry.register({ name: "note", source, view: ViewConfigSchema.parse({}) });
    const dispatcher = createDispatcher(registry, { log: { error: vi.fn() } });
    const mutate = () =>
      dispatcher.dispatch({
        kind: "udc.mutate",
        id: "1",
        payload: { collection: "note", op: "insert", row: { title: "x" } },
      });

    const release = gate();
    const held = p.a.transaction(async () => {
      await release.opened;
    });
    const refused = await mutate();
    expect(refused.kind).toBe("udc.mutate.err");
    expect(refused.payload).toMatchObject({ code: "busy", details: { database: "vault" } });

    const waiting = mutate();
    await sleep(30);
    release.open();
    await held;
    expect((await waiting).kind).toBe("udc.mutate.ok");
    expect(await count(p.a, "note")).toBe(1);
  });
});

describe("the in-process write queue", () => {
  it("runs transactions one after the other, each seeing the one before committed", async () => {
    const db = openDb("memory");
    await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    const order: string[] = [];
    const tx = (name: string, ms: number) =>
      db.transaction(async (t) => {
        order.push(`${name}:start`);
        t.run({ sql: "INSERT INTO t (v) VALUES (?)", params: [name] });
        await sleep(ms);
        order.push(`${name}:end`);
        return t.all<{ v: string }>("SELECT v FROM t ORDER BY id").map((r) => r.v);
      });
    const [one, two] = await Promise.all([tx("one", 40), tx("two", 0)]);
    expect(order).toEqual(["one:start", "one:end", "two:start", "two:end"]);
    expect(one).toEqual(["one"]);
    expect(two).toEqual(["one", "two"]);
  });

  it("on :memory: a read waits for an open transaction and never sees its rows", async () => {
    const db = openDb("memory");
    await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    const release = gate();
    const held = db.transaction(async (t) => {
      t.run("INSERT INTO t (v) VALUES ('x')");
      await release.opened;
      throw new Error("changed my mind");
    });
    const read = count(db);
    await sleep(20);
    release.open();
    await expect(held).rejects.toThrow("changed my mind");
    expect(await read).toBe(0);
  });

  it("a transaction waiting in the queue past busyTimeoutMs is answered busy", async () => {
    const db = openNodeSqlite(":memory:", { busyTimeoutMs: 50, name: "solo" });
    await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    const release = gate();
    const held = db.transaction(() => release.opened);
    const err = await rejectsWith(db.run("INSERT INTO t DEFAULT VALUES"), "busy");
    expect(err.details).toMatchObject({ database: "solo" });
    release.open();
    await held;
    await db.run("INSERT INTO t DEFAULT VALUES");
    expect(await count(db)).toBe(1);
    db.close();
  });

  it("commits what fn wrote and answers its value; a throw rolls everything back", async () => {
    const db = openDb("file");
    await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    expect(await db.transaction((t) => t.run("INSERT INTO t (v) VALUES ('ok')").changes)).toBe(1);
    await expect(
      db.transaction((t) => {
        t.run("INSERT INTO t (v) VALUES ('no')");
        throw new UdcError("validation_error", "no");
      }),
    ).rejects.toThrow("no");
    expect(await db.all("SELECT v FROM t")).toEqual([{ v: "ok" }]);
  });

  it("refuses a statement of a transaction that has ended", async () => {
    const db = openDb("memory");
    await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    let late: (() => unknown) | undefined;
    await db.transaction((t) => {
      late = () => t.run("INSERT INTO t DEFAULT VALUES");
    });
    expect(() => late?.()).toThrow(/already ended/);
    expect(await count(db)).toBe(0);
  });
});

describe("a host's writes and the source's transaction", () => {
  const schema = SchemaDocSchema.parse({
    version: "v1",
    fields: { tenant: { type: "string" }, title: { type: "string" }, size: { type: "integer" } },
  });

  async function setup() {
    const db = openDb("file");
    await db.exec(`
      CREATE TABLE note (id TEXT PRIMARY KEY, tenant TEXT, title TEXT, size INTEGER, version INTEGER);
      CREATE TABLE audit (id INTEGER PRIMARY KEY, what TEXT);`);
    const source = new SqliteTableSource({ db, schema, table: "note", versionColumn: "version" });
    return { db, source };
  }

  const scoped: SourceContext = {
    ctx: null,
    collection: "note",
    rowScope: {
      and: [
        { field: "tenant", op: "eq", value: "a" },
        { field: "size", op: "lt", value: 10 },
      ],
    },
  };

  it("a host write made inside the source's transaction rolls back with it", async () => {
    const { db, source } = await setup();
    const row = await source.mutate({ op: "insert", row: { title: "x", size: 1 } }, scoped);
    // A host hook running in the source's transaction (here: just before the row is read
    // back) writes through the same object, then the row turns out to have left the scope.
    const internals = source as unknown as { readBack: (...a: unknown[]) => unknown };
    const original = internals.readBack.bind(source);
    const hook = vi.spyOn(internals, "readBack").mockImplementation((...args) => {
      void db.run("INSERT INTO audit (what) VALUES ('host')");
      return original(...args);
    });
    await rejectsWith(
      source.mutate({ op: "update", id: row.__meta.id, row: { size: 50 } }, scoped),
      "forbidden",
    );
    expect(hook).toHaveBeenCalled();
    hook.mockRestore();
    expect(await count(db, "audit")).toBe(0);
    expect(await source.read(row.__meta.id)).toEqual(row);

    // The same hook on a write that stays in scope commits both.
    const ok = vi.spyOn(internals, "readBack").mockImplementation((...args) => {
      void db.run("INSERT INTO audit (what) VALUES ('host')");
      return original(...args);
    });
    await source.mutate({ op: "update", id: row.__meta.id, row: { size: 5 } }, scoped);
    ok.mockRestore();
    expect(await count(db, "audit")).toBe(1);
  });

  it("the source's write inside a host transaction rolls back with it", async () => {
    const { db, source } = await setup();
    await expect(
      db.transaction(async (tx) => {
        tx.run("INSERT INTO audit (what) VALUES ('host')");
        await source.mutate({ op: "insert", row: { title: "inside" } });
        expect(await count(db, "note")).toBe(1); // the transaction sees its own write
        throw new Error("host gives up");
      }),
    ).rejects.toThrow("host gives up");
    expect(await count(db, "note")).toBe(0);
    expect(await count(db, "audit")).toBe(0);
  });

  it("a source failure inside a host transaction undoes only the source's part (a savepoint)", async () => {
    const { db, source } = await setup();
    const row = await source.mutate({ op: "insert", row: { tenant: "a", title: "x", size: 1 } });
    await db.transaction(async (tx) => {
      tx.run("INSERT INTO audit (what) VALUES ('before')");
      await rejectsWith(
        source.mutate({ op: "update", id: row.__meta.id, row: { size: 99 } }, scoped),
        "forbidden",
      );
      tx.run("INSERT INTO audit (what) VALUES ('after')");
    });
    expect(await db.all("SELECT what FROM audit ORDER BY id")).toEqual([
      { what: "before" },
      { what: "after" },
    ]);
    expect((await source.read(row.__meta.id)).size).toBe(1);
  });

  it("nested transactions are savepoints; siblings run one after the other", async () => {
    const db = openDb("memory");
    await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    await db.transaction(async () => {
      await db.run("INSERT INTO t (v) VALUES ('outer')");
      await Promise.all([
        db.transaction(async (t) => {
          t.run("INSERT INTO t (v) VALUES ('kept')");
          await sleep(5);
          await db.transaction((u) => u.run("INSERT INTO t (v) VALUES ('deep')"));
        }),
        db
          .transaction((t) => {
            t.run("INSERT INTO t (v) VALUES ('dropped')");
            throw new Error("inner");
          })
          .catch(() => undefined),
      ]);
    });
    expect((await db.all<{ v: string }>("SELECT v FROM t ORDER BY id")).map((r) => r.v)).toEqual([
      "outer",
      "kept",
      "deep",
    ]);
  });
});

describe("Drizzle through drizzle-orm/sqlite-proxy", () => {
  const notes = sqliteTable("t", {
    id: integer("id").primaryKey(),
    v: text("v").notNull(),
  });

  it("reads, writes, and takes part in a transaction of the wrapper", async () => {
    const db = openDb("file");
    await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
    const orm = drizzle(db.proxy);
    await orm.insert(notes).values({ v: "one" });
    const inserted = await orm.insert(notes).values({ v: "two" }).returning();
    expect(inserted).toEqual([{ id: 2, v: "two" }]);
    expect(await orm.select().from(notes).where(eq(notes.v, "one"))).toEqual([{ id: 1, v: "one" }]);
    expect(await orm.select().from(notes).where(eq(notes.id, 2)).get()).toEqual({
      id: 2,
      v: "two",
    });

    await expect(
      db.transaction(async () => {
        await orm.insert(notes).values({ v: "three" });
        expect(await orm.select().from(notes)).toHaveLength(3);
        throw new Error("undo");
      }),
    ).rejects.toThrow("undo");
    expect(await orm.select().from(notes)).toHaveLength(2);
  });
});

describe("the adapter and the error mapping", () => {
  it("binds booleans, undefined and dates; reads rows as objects or arrays", () => {
    const conn = nodeSqliteConnection(new DatabaseSync(":memory:"));
    expect(conn.all("SELECT ? AS a, ? AS b, ? AS c", [true, undefined, new Date(0)])).toEqual([
      { a: 1, b: null, c: "1970-01-01T00:00:00.000Z" },
    ]);
    expect(conn.values("SELECT 1, 'x'", [])).toEqual([[1, "x"]]);
    conn.close();
    conn.close(); // twice is fine
  });

  it("recognises SQLITE_BUSY and SQLITE_LOCKED of either driver", () => {
    expect(isSqliteBusy({ errcode: 5 })).toBe(true);
    expect(isSqliteBusy({ errcode: 5 | (2 << 8) })).toBe(true);
    expect(isSqliteBusy({ errcode: 6 })).toBe(true);
    expect(isSqliteBusy({ errcode: 1 })).toBe(false);
    expect(isSqliteBusy({ code: "SQLITE_BUSY_SNAPSHOT" })).toBe(true);
    expect(isSqliteBusy({ code: "SQLITE_CONSTRAINT" })).toBe(false);
    expect(isSqliteBusy(null)).toBe(false);
  });

  it("refuses a bad busyTimeoutMs, and work after close", async () => {
    const write = nodeSqliteConnection(new DatabaseSync(":memory:"));
    expect(() => new SqliteDatabase({ write, busyTimeoutMs: -1 })).toThrow(/busyTimeoutMs/);
    const db = new SqliteDatabase({ write, wal: false });
    db.close();
    await expect(db.run("SELECT 1")).rejects.toThrow(/closed/);
  });

  it("unicodeLower folds Č for the case-insensitive ops", async () => {
    const plain = openDb("memory");
    const folded = openDb("memory", { unicodeLower: true });
    for (const db of [plain, folded]) {
      expect((await db.get<{ l: string }>("SELECT lower('ČAK') AS l"))?.l).toBe(
        db === plain ? "Čak" : "čak",
      );
    }
  });
});
