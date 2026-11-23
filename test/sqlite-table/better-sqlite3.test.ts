// The `better-sqlite3` adapter (@jsudc/server/better-sqlite3): what is its own — binding,
// a statement that returns no rows through `all` / `values`, its busy errors, the read
// connection, the open options, Drizzle through the proxy. The source's suites
// (mutate-many, on-mutate, changes-writes) run on it too. Runs only when the optional peer
// is installed and its native addon loads.

import { createRequire } from "node:module";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { beforeAll, describe, expect, it } from "vitest";
import { betterSqliteConnection, openBetterSqlite } from "../../src/better-sqlite3.js";
import { isSqliteBusy } from "../../src/sqlite.js";
import { betterSqliteAvailable, openWith, rejectsWith, tempFile } from "./helpers.js";

describe.runIf(betterSqliteAvailable)("the better-sqlite3 adapter", () => {
  // Node's own require, in beforeAll: a skipped suite never runs it (its body still runs, to collect).
  let Database: typeof import("better-sqlite3");
  beforeAll(() => {
    Database = createRequire(import.meta.url)("better-sqlite3");
  });

  it("binds booleans, undefined, dates and bytes; reads rows as objects or arrays", () => {
    const conn = betterSqliteConnection(new Database(":memory:"));
    expect(
      conn.all("SELECT ? AS a, ? AS b, ? AS c, hex(?) AS d", [
        true,
        undefined,
        new Date(0),
        new Uint8Array([1, 255]),
      ]),
    ).toEqual([{ a: 1, b: null, c: "1970-01-01T00:00:00.000Z", d: "01FF" }]);
    expect(conn.values("SELECT 1, 'x'", [])).toEqual([[1, "x"]]);
    conn.close();
    conn.close(); // twice is fine
  });

  it("runs a statement without rows through all and values, answering none", () => {
    const conn = betterSqliteConnection(new Database(":memory:"));
    conn.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    expect(conn.all("INSERT INTO t (v) VALUES (?)", ["a"])).toEqual([]);
    expect(conn.values("INSERT INTO t (v) VALUES (?)", ["b"])).toEqual([]);
    expect(conn.all("INSERT INTO t (v) VALUES (?) RETURNING id", ["c"])).toEqual([{ id: 3 }]);
    expect(conn.run("UPDATE t SET v = 'z'", [])).toEqual({ changes: 3, lastInsertRowid: 3 });
    conn.close();
  });

  it("its busy error is recognised; a second process's write is answered busy", async () => {
    const file = tempFile();
    const a = await openWith("better-sqlite3", file);
    await a.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    const b = await openWith("better-sqlite3", file, { busyTimeoutMs: 30 });
    expect((await a.get<{ journal_mode: string }>("PRAGMA journal_mode"))?.journal_mode).toBe(
      "wal",
    );
    let caught: unknown;
    await a.transaction(async (tx) => {
      tx.run("INSERT INTO t (v) VALUES ('a')");
      const raw = new Database(file, { timeout: 0 });
      try {
        raw.exec("BEGIN IMMEDIATE");
      } catch (e) {
        caught = e;
      } finally {
        raw.close();
      }
      await rejectsWith(b.run("INSERT INTO t (v) VALUES ('b')"), "busy");
      // The read connection of the other process reads the committed rows, without waiting.
      expect(await b.all("SELECT v FROM t")).toEqual([]);
    });
    expect(isSqliteBusy(caught)).toBe(true);
    expect(await b.all("SELECT v FROM t")).toEqual([{ v: "a" }]);
  });

  it("the read connection is read-only", async () => {
    const file = tempFile();
    const db = openBetterSqlite(file);
    try {
      await db.exec("CREATE TABLE t (v TEXT)");
      // `read` goes to the read connection outside a transaction.
      await expect(db.read((r) => r.run("INSERT INTO t VALUES ('x')"))).rejects.toThrow(
        /readonly/i,
      );
    } finally {
      db.close();
    }
  });

  it("unicodeLower folds Č; setup sees each connection", async () => {
    const seen: string[] = [];
    const folded = await openWith("better-sqlite3", "memory", { unicodeLower: true });
    expect((await folded.get<{ l: string }>("SELECT lower('ČAK') AS l"))?.l).toBe("čak");
    const file = tempFile();
    const db = openBetterSqlite(file, {
      setup: (conn) => {
        conn.function("tag", { deterministic: true }, () => "mine");
        seen.push("opened");
      },
    });
    try {
      expect(seen).toEqual(["opened", "opened"]);
      expect(await db.get("SELECT tag() AS t")).toEqual({ t: "mine" });
    } finally {
      db.close();
    }
  });

  it("Drizzle through the proxy reads, writes and takes part in a transaction", async () => {
    const notes = sqliteTable("t", { id: integer("id").primaryKey(), v: text("v").notNull() });
    const db = await openWith("better-sqlite3", "file");
    await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
    const orm = drizzle(db.proxy);
    await orm.insert(notes).values({ v: "one" });
    expect(await orm.insert(notes).values({ v: "two" }).returning()).toEqual([{ id: 2, v: "two" }]);
    await expect(
      db.transaction(async () => {
        await orm.insert(notes).values({ v: "three" });
        expect(await orm.select().from(notes)).toHaveLength(3);
        throw new Error("undo");
      }),
    ).rejects.toThrow("undo");
    expect(await orm.select().from(notes)).toEqual([
      { id: 1, v: "one" },
      { id: 2, v: "two" },
    ]);
  });
});
