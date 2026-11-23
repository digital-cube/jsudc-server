// SqliteDatabase.checkpoint(): a WAL checkpoint on the write connection, outside any
// transaction, in its turn of the write queue — so a host can fold the WAL into the main
// file and copy the database directory while the server keeps it open.

import { copyFileSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { DRIVERS, openWith, rejectsWith, tempFile } from "./helpers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => {
    open = r;
  });
  return { open, opened };
}

/**
 * Another connection reading the file, as another process would. On the wrapper's own
 * driver: two SQLite builds in one process (node's and better-sqlite3's) do not see each
 * other's POSIX locks, so a node:sqlite reader would not hold back a better-sqlite3 writer.
 */
function rawReader(driver: string, file: string): { exec(sql: string): void; close(): void } {
  if (driver === "node:sqlite") return new DatabaseSync(file, { readOnly: true });
  const Database = createRequire(import.meta.url)("better-sqlite3");
  return new Database(file, { readonly: true });
}

const walSize = (file: string) => (existsSync(`${file}-wal`) ? statSync(`${file}-wal`).size : -1);

describe.each(DRIVERS)("checkpoint() on %s", (driver) => {
  async function vault(opts: { busyTimeoutMs?: number } = {}) {
    const file = tempFile("vault.db");
    const db = await openWith(driver, file, opts);
    await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    for (let i = 0; i < 20; i++) await db.run(`INSERT INTO t (v) VALUES ('row ${i}')`);
    return { file, db };
  }

  it("folds the WAL into the main file and truncates -wal to 0 bytes, the wrapper still open", async () => {
    const { file, db } = await vault();
    expect(walSize(file)).toBeGreaterThan(0);

    const result = await db.checkpoint();

    expect(result.busy).toBe(false);
    expect(result.log).toBe(0); // TRUNCATE: the log is empty afterwards
    expect(result.checkpointed).toBe(0);
    expect(walSize(file)).toBe(0);
    // The main file alone, copied while the wrapper is open, holds every row.
    const copy = tempFile("copy.db");
    copyFileSync(file, copy);
    const other = new DatabaseSync(copy, { readOnly: true });
    expect(other.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 20 });
    other.close();
    // And the wrapper goes on writing and reading.
    await db.run("INSERT INTO t (v) VALUES ('after')");
    expect((await db.get<{ n: number }>("SELECT count(*) AS n FROM t"))?.n).toBe(21);
  });

  it("PASSIVE checkpoints the frames and reports the log it left", async () => {
    const { file, db } = await vault();
    const result = await db.checkpoint("PASSIVE");
    expect(result.busy).toBe(false);
    expect(result.log).toBeGreaterThan(0);
    expect(result.checkpointed).toBe(result.log);
    expect(walSize(file)).toBeGreaterThan(0); // PASSIVE never truncates
  });

  it("waits for a transaction that holds the write queue, and checkpoints what it wrote", async () => {
    const { file, db } = await vault();
    const release = gate();
    const held = db.transaction(async (tx) => {
      tx.run("INSERT INTO t (v) VALUES ('held')");
      await release.opened;
    });
    await sleep(5);
    let done = false;
    const checkpoint = db.checkpoint().then((r) => {
      done = true;
      return r;
    });
    await sleep(60);
    expect(done).toBe(false);

    release.open();
    await held;
    expect((await checkpoint).busy).toBe(false);
    expect(walSize(file)).toBe(0);
    const copy = tempFile("copy.db");
    copyFileSync(file, copy);
    const other = new DatabaseSync(copy, { readOnly: true });
    expect(other.prepare("SELECT count(*) AS n FROM t WHERE v = 'held'").get()).toEqual({ n: 1 });
    other.close();
  });

  it("a write queued behind the checkpoint runs after it", async () => {
    const { db } = await vault();
    const order: string[] = [];
    const release = gate();
    const held = db.transaction(async () => {
      await release.opened;
    });
    await sleep(5);
    const checkpoint = db.checkpoint().then(() => order.push("checkpoint"));
    const write = db.run("INSERT INTO t (v) VALUES ('w')").then(() => order.push("write"));
    release.open();
    await Promise.all([held, checkpoint, write]);
    expect(order).toEqual(["checkpoint", "write"]);
  });

  it("answers busy while another connection reads the WAL past busyTimeoutMs, then succeeds", async () => {
    const { file, db } = await vault({ busyTimeoutMs: 80 });
    // Another process in the middle of a read: its snapshot needs the WAL.
    const reader = rawReader(driver, file);
    reader.exec("BEGIN; SELECT count(*) FROM t;");

    const started = Date.now();
    const blocked = await db.checkpoint();
    expect(blocked.busy).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
    expect(walSize(file)).toBeGreaterThan(0);
    // The write queue was released: a write goes through.
    await db.run("INSERT INTO t (v) VALUES ('meanwhile')");

    reader.exec("COMMIT");
    reader.close();
    const result = await db.checkpoint();
    expect(result.busy).toBe(false);
    expect(walSize(file)).toBe(0);
  });

  it("waiting in the queue past busyTimeoutMs is the protocol error busy", async () => {
    const { db } = await vault({ busyTimeoutMs: 40 });
    const release = gate();
    const held = db.transaction(async () => {
      await release.opened;
    });
    await sleep(5);
    const err = await rejectsWith(db.checkpoint(), "busy");
    expect(err.details).toMatchObject({ database: "main" });
    release.open();
    await held;
  });

  it("is refused inside a transaction of the database, and for an unknown mode", async () => {
    const { db } = await vault();
    await db.transaction(async () => {
      await expect(db.checkpoint()).rejects.toThrow(/inside a transaction/);
    });
    // @ts-expect-error not a checkpoint mode
    await expect(db.checkpoint("TRUNCATE; DROP TABLE t")).rejects.toThrow(/mode/);
    expect((await db.get<{ n: number }>("SELECT count(*) AS n FROM t"))?.n).toBe(20);
  });

  it("on :memory: (no WAL) answers log and checkpointed -1", async () => {
    const db = await openWith(driver, "memory");
    expect(await db.checkpoint()).toEqual({ busy: false, log: -1, checkpointed: -1 });
  });
});

// close(): SQLite checkpoints and deletes -wal / -shm on the close of the LAST connection
// to the file, and only when that connection can write. The read-only reader has to go
// first, or the newest commits stay in -wal and a copy of the main file alone lacks them.
describe.each(DRIVERS)("close() on %s", (driver) => {
  const copyRows = (file: string): number => {
    const copy = tempFile("copy.db");
    copyFileSync(file, copy); // the main file ALONE: no -wal next to the copy
    const other = new DatabaseSync(copy, { readOnly: true });
    try {
      return Number((other.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n);
    } finally {
      other.close();
    }
  };

  for (const watch of [false, true]) {
    it(`folds the WAL into the main file and removes -wal and -shm (watch: ${watch})`, async () => {
      const file = tempFile("vault.db");
      const db = await openWith(driver, file, { watch });
      await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
      for (let i = 0; i < 5; i++) await db.run(`INSERT INTO t (v) VALUES ('row ${i}')`);
      await db.get("SELECT count(*) AS n FROM t"); // the reader has been on the WAL
      expect(walSize(file)).toBeGreaterThan(0);

      db.close();

      expect(existsSync(`${file}-wal`)).toBe(false);
      expect(existsSync(`${file}-shm`)).toBe(false);
      expect(copyRows(file)).toBe(5);
    });
  }

  it("with another connection still on the file, the commits are folded in anyway", async () => {
    const file = tempFile("vault.db");
    const db = await openWith(driver, file);
    await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    for (let i = 0; i < 5; i++) await db.run(`INSERT INTO t (v) VALUES ('row ${i}')`);
    // Another process is in a read transaction on the file: the close of the wrapper's
    // writer is then not the last close, and SQLite would not checkpoint on its own.
    const other = rawReader(driver, file);
    other.exec("BEGIN");
    other.exec("SELECT count(*) FROM t");

    db.close();

    // -wal stays (the other connection is on it), but its frames are in the main file.
    expect(existsSync(`${file}-wal`)).toBe(true);
    expect(copyRows(file)).toBe(5);
    other.exec("COMMIT");
    other.close();
  });

  it("is idempotent, and closes a database that is not in WAL mode", async () => {
    const db = await openWith(driver, tempFile("vault.db"));
    db.close();
    expect(() => db.close()).not.toThrow();
    const memory = await openWith(driver, "memory");
    expect(() => memory.close()).not.toThrow();
  });
});
