// The one object per SQLite database file that every user of the file in this
// process goes through: the `sqlite_table` sources and the host's own SQL. A
// SQLite connection is one connection: a statement run on it while a
// transaction is open lands inside that transaction. So the file gets ONE
// write connection, behind an in-process queue, and (for a file, not
// `:memory:`) one read connection that never waits for a writer (WAL).
//
// No driver is imported here: a `SqliteConnection` adapts one (`node:sqlite`
// in `./sqlite-node.ts`, `better-sqlite3` in `./better-sqlite3.ts`).

import { AsyncLocalStorage } from "node:async_hooks";
import { UdcError } from "@jsudc/core";
import type { SQL } from "drizzle-orm";
import { type SqliteQuery, sqliteQuery } from "./sources/sqlite-sql.js";

/** What a write statement reports. */
export interface SqliteRunResult {
  /** Rows inserted, updated or deleted by the statement itself (not by its triggers). */
  changes: number;
  lastInsertRowid: number | bigint;
}

/**
 * One synchronous connection to a SQLite database: what a driver adapter
 * gives `SqliteDatabase`. Parameters are positional (`?`) and already in a
 * form SQLite binds (null, number, bigint, string, bytes); the adapter turns
 * anything else (a boolean, `undefined`) into one.
 */
export interface SqliteConnection {
  /** The rows of a statement as objects keyed by column name. */
  all(sql: string, params: readonly unknown[]): Record<string, unknown>[];
  /** The rows of a statement as arrays of values, in column order. */
  values(sql: string, params: readonly unknown[]): unknown[][];
  /** Run one statement for its effect. */
  run(sql: string, params: readonly unknown[]): SqliteRunResult;
  /** Run SQL text without parameters (several statements allowed): pragmas, `BEGIN`, `COMMIT`. */
  exec(sql: string): void;
  close(): void;
}

/** A statement: a drizzle `sql` template, an already rendered query, or plain text without parameters. */
export type SqliteStatement = SQL | SqliteQuery | string;

/**
 * Statements inside a turn of the database: a write transaction, or a read
 * snapshot. Synchronous: nothing else in this process runs on the connection
 * between two of them while the turn is held.
 */
export interface SqliteExecutor {
  all<T = Record<string, unknown>>(q: SqliteStatement): T[];
  get<T = Record<string, unknown>>(q: SqliteStatement): T | undefined;
  run(q: SqliteStatement): SqliteRunResult;
}

/** The callback of `drizzle-orm/sqlite-proxy`: `drizzle(database.proxy)`. */
export type SqliteProxyCallback = (
  sql: string,
  params: unknown[],
  method: "run" | "all" | "values" | "get",
) => Promise<{ rows: unknown[] }>;

export interface SqliteDatabaseOptions {
  /** The connection every write goes through (and every read, without `read`). */
  write: SqliteConnection;
  /**
   * A second connection to the same file, for reads: in WAL mode a read on it
   * never waits for a writer and sees only committed rows. Leave it out for
   * `:memory:` (a second connection would be another, empty database); reads
   * then take their turn in the write queue.
   */
  read?: SqliteConnection | undefined;
  /** The name of the database in messages and in a `busy` error's details; default `main`. */
  name?: string | undefined;
  /**
   * How long a write waits for its turn and for the file's write lock (held
   * by another transaction in this process, or by another process) before it
   * is answered with the protocol error `busy`. Default 5000 ms.
   */
  busyTimeoutMs?: number | undefined;
  /**
   * Put the file in WAL mode (`PRAGMA journal_mode = WAL`, persistent in the
   * file) so readers and the writer do not block each other. Default `true`;
   * a no-op on `:memory:`.
   */
  wal?: boolean | undefined;
}

export const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 5000;

/** SQLITE_BUSY (5) or SQLITE_LOCKED (6), with any extended code, as `node:sqlite` or `better-sqlite3` report it. */
export function isSqliteBusy(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { errcode, code } = err as { errcode?: unknown; code?: unknown };
  if (typeof errcode === "number") {
    const primary = errcode & 0xff;
    return primary === 5 || primary === 6;
  }
  return typeof code === "string" && /^SQLITE_(BUSY|LOCKED)/.test(code);
}

/** The text and parameters of a statement. */
function render(q: SqliteStatement): SqliteQuery {
  if (typeof q === "string") return { sql: q, params: [] };
  if ("sql" in q && Array.isArray((q as SqliteQuery).params)) return q as SqliteQuery;
  return sqliteQuery(q as SQL);
}

/** A statement that only reads (the proxy sends it to the read connection); anything else takes the write path. */
const READ_ONLY_SQL = /^\s*(select|values)\b/i;

/** One level of an open write transaction, as the async context of the code running in it sees it. */
interface TxScope {
  db: SqliteDatabase;
  /** Set when the transaction (or savepoint) has ended: a straggler's statement is refused. */
  closed: boolean;
  depth: number;
  /** Savepoints opened by concurrent code at this level run one after the other. */
  chain: Promise<unknown>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Waiter {
  grant(): void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * One SQLite database file, shared by everything in this process that uses
 * it: one write connection behind an in-process write queue, and one read
 * connection. The host registers it with the server under a name
 * (`SourceDeps.sqlite`), and runs its own SQL through it too — for Drizzle
 * through `drizzle-orm/sqlite-proxy`: `drizzle(database.proxy)`.
 *
 * - `transaction(fn)` takes the queue, then the file's write lock with
 *   `BEGIN IMMEDIATE` (so a transaction never fails half-way on a lock another
 *   process took after it began), and commits when `fn` resolves, rolls back
 *   when it throws. The lock is waited for without blocking the event loop:
 *   the write connection's own `busy_timeout` is 0 and `BEGIN IMMEDIATE` is
 *   retried until `busyTimeoutMs` has passed; then the answer is the protocol
 *   error `busy`.
 * - Code running inside `fn` — awaited or not, through this object or its
 *   `proxy` — runs in the transaction: a nested `transaction` is a
 *   `SAVEPOINT`, a `run` / `all` goes to the write connection. Code anywhere
 *   else waits for the transaction to end.
 * - `read(fn)` runs `fn` on one snapshot of the committed rows.
 *
 * Nothing is cached about rows between calls: other processes write the file.
 */
export class SqliteDatabase {
  readonly name: string;
  readonly busyTimeoutMs: number;
  private readonly writer: SqliteConnection;
  private readonly reader: SqliteConnection | undefined;
  private readonly als = new AsyncLocalStorage<TxScope>();
  private held = false;
  private readonly waiting: Waiter[] = [];
  private closed = false;

  constructor(opts: SqliteDatabaseOptions) {
    this.writer = opts.write;
    this.reader = opts.read;
    this.name = opts.name ?? "main";
    this.busyTimeoutMs = opts.busyTimeoutMs ?? DEFAULT_SQLITE_BUSY_TIMEOUT_MS;
    if (!Number.isInteger(this.busyTimeoutMs) || this.busyTimeoutMs < 0) {
      throw new Error(`SqliteDatabase: busyTimeoutMs must be a non-negative integer`);
    }
    // The writer waits for the lock itself, asynchronously; a reader waits in SQLite
    // (in WAL mode only for a checkpoint or a recovery, briefly).
    this.writer.exec("PRAGMA busy_timeout = 0");
    this.reader?.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`);
    if (opts.wal ?? true) this.mapBusy(() => this.writer.exec("PRAGMA journal_mode = WAL"));
  }

  /**
   * `fn` in one write transaction (`BEGIN IMMEDIATE` … `COMMIT`), its result
   * answered once committed; a throw rolls everything back and is rethrown.
   * Inside another transaction of this database (the same async context), a
   * `SAVEPOINT` instead: its rollback undoes only what `fn` wrote.
   */
  async transaction<T>(fn: (tx: SqliteExecutor) => Promise<T> | T): Promise<T> {
    const outer = this.scope();
    if (outer) return this.savepoint(outer, fn);
    const started = Date.now();
    await this.acquire(started);
    try {
      await this.begin(started);
      const scope: TxScope = { db: this, closed: false, depth: 0, chain: Promise.resolve() };
      let result: T;
      try {
        result = await this.als.run(scope, () => fn(this.executor(this.writer, scope)));
      } catch (err) {
        scope.closed = true;
        this.rollback();
        throw err;
      }
      scope.closed = true;
      await this.commit();
      return result;
    } finally {
      this.release();
    }
  }

  /**
   * `fn` on one snapshot of the committed rows, synchronously (nothing else
   * runs meanwhile). Inside a transaction of this database, on its connection,
   * so it sees what the transaction wrote.
   */
  async read<T>(fn: (r: SqliteExecutor) => T): Promise<T> {
    const scope = this.scope();
    if (scope) return fn(this.executor(this.writer, scope));
    const reader = this.reader;
    if (reader) {
      this.assertOpen();
      return this.snapshot(reader, fn);
    }
    // One connection: a read waits for an open write transaction to end.
    if (!this.held && this.waiting.length === 0) return this.snapshot(this.writer, fn);
    await this.acquire(Date.now());
    try {
      return this.snapshot(this.writer, fn);
    } finally {
      this.release();
    }
  }

  /** The rows of one read statement (see `read`). */
  all<T = Record<string, unknown>>(q: SqliteStatement): Promise<T[]> {
    return this.read((r) => r.all<T>(q));
  }

  /** The first row of one read statement, or `undefined` (see `read`). */
  get<T = Record<string, unknown>>(q: SqliteStatement): Promise<T | undefined> {
    return this.read((r) => r.get<T>(q));
  }

  /**
   * SQL text of several statements without parameters (a migration, a
   * trigger) in one write transaction (or in the open one). The text must not
   * open or end a transaction itself.
   */
  exec(text: string): Promise<void> {
    const scope = this.scope();
    if (scope) return Promise.resolve(this.guard(scope, () => this.writer.exec(text)));
    return this.transaction(() => this.writer.exec(text));
  }

  /** One write statement in a transaction of its own (or in the open one; see `transaction`). */
  run(q: SqliteStatement): Promise<SqliteRunResult> {
    const scope = this.scope();
    if (scope) return Promise.resolve(this.executor(this.writer, scope).run(q));
    return this.transaction((tx) => tx.run(q));
  }

  /**
   * The callback of `drizzle-orm/sqlite-proxy`, so a host's Drizzle shares
   * this object: `drizzle(database.proxy)`. A `SELECT` outside a transaction
   * reads the read connection; every other statement is written as `run`
   * would (inside an open transaction of this async context, in it).
   */
  readonly proxy: SqliteProxyCallback = async (text, params, method) => {
    const q: SqliteQuery = { sql: text, params };
    if (method === "run") {
      await this.run(q);
      return { rows: [] };
    }
    const values = (c: SqliteConnection) => c.values(text, params);
    const scope = this.scope();
    let rows: unknown[][];
    if (scope) rows = this.guard(scope, () => values(this.writer));
    else if (READ_ONLY_SQL.test(text)) {
      rows = await this.read(() => values(this.reader ?? this.writer));
    } else {
      rows = await this.transaction(() => values(this.writer));
    }
    return { rows: method === "get" ? (rows[0] as unknown[]) : rows };
  };

  /** Close both connections; a transaction still waiting for its turn is refused. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.writer.close();
    this.reader?.close();
  }

  /** The protocol error of a write that could not get the file's write lock in time. */
  busyError(waitedMs: number): UdcError {
    return new UdcError(
      "busy",
      `the database ${this.name} is locked by another writer; nothing was written, try again`,
      { database: this.name, waited_ms: waitedMs },
    );
  }

  // --- the turn -------------------------------------------------------------

  /** The open transaction of this database in the current async context, if any. */
  private scope(): TxScope | undefined {
    const s = this.als.getStore();
    return s && s.db === this && !s.closed ? s : undefined;
  }

  /** Wait for the turn (the in-process write queue) until `busyTimeoutMs` after `started`. */
  private acquire(started: number): Promise<void> {
    this.assertOpen();
    if (!this.held) {
      this.held = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { grant: resolve, timer: undefined };
      const left = started + this.busyTimeoutMs - Date.now();
      waiter.timer = setTimeout(
        () => {
          const at = this.waiting.indexOf(waiter);
          if (at >= 0) this.waiting.splice(at, 1);
          reject(this.busyError(Date.now() - started));
        },
        Math.max(0, left),
      );
      this.waiting.push(waiter);
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      clearTimeout(next.timer);
      next.grant();
    } else this.held = false;
  }

  /** `BEGIN IMMEDIATE`, retried while another process holds the write lock, until the deadline. */
  private async begin(started: number): Promise<void> {
    for (let pause = 2; ; pause = Math.min(pause * 2, 50)) {
      this.assertOpen();
      try {
        this.writer.exec("BEGIN IMMEDIATE");
        return;
      } catch (err) {
        if (!isSqliteBusy(err)) throw err;
      }
      const left = started + this.busyTimeoutMs - Date.now();
      if (left <= 0) throw this.busyError(Date.now() - started);
      await sleep(Math.min(pause, left));
    }
  }

  /**
   * `COMMIT`. In WAL mode it never waits; in a rollback journal it needs the
   * readers of other processes gone, and is retried until the deadline, then
   * rolled back and answered `busy`.
   */
  private async commit(): Promise<void> {
    const started = Date.now();
    for (let pause = 2; ; pause = Math.min(pause * 2, 50)) {
      try {
        this.writer.exec("COMMIT");
        return;
      } catch (err) {
        if (!isSqliteBusy(err)) {
          this.rollback();
          throw err;
        }
      }
      const left = started + this.busyTimeoutMs - Date.now();
      if (left <= 0) {
        this.rollback();
        throw this.busyError(Date.now() - started);
      }
      await sleep(Math.min(pause, left));
    }
  }

  /** `ROLLBACK`, quietly when SQLite already rolled the transaction back itself. */
  private rollback(): void {
    try {
      this.writer.exec("ROLLBACK");
    } catch {
      // No transaction is open any more (SQLite rolls back by itself on some errors).
    }
  }

  private async savepoint<T>(
    outer: TxScope,
    fn: (tx: SqliteExecutor) => Promise<T> | T,
  ): Promise<T> {
    const run = async (): Promise<T> => {
      const name = `jsudc_sp_${outer.depth + 1}`;
      this.guard(outer, () => this.writer.exec(`SAVEPOINT ${name}`));
      const inner: TxScope = {
        db: this,
        closed: false,
        depth: outer.depth + 1,
        chain: Promise.resolve(),
      };
      try {
        const result = await this.als.run(inner, () => fn(this.executor(this.writer, inner)));
        inner.closed = true;
        this.guard(outer, () => this.writer.exec(`RELEASE ${name}`));
        return result;
      } catch (err) {
        inner.closed = true;
        if (!outer.closed) {
          try {
            this.writer.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
          } catch {
            // The whole transaction is gone already; the outer level rolls back.
          }
        }
        throw err;
      }
    };
    const turn = outer.chain.then(run, run);
    outer.chain = turn.catch(() => undefined);
    return turn;
  }

  /** `fn` on `conn` inside `BEGIN` … `COMMIT`: one snapshot. */
  private snapshot<T>(conn: SqliteConnection, fn: (r: SqliteExecutor) => T): T {
    this.mapBusy(() => conn.exec("BEGIN"));
    try {
      return fn(this.executor(conn, undefined));
    } finally {
      try {
        conn.exec("COMMIT");
      } catch {
        conn.exec("ROLLBACK");
      }
    }
  }

  private executor(conn: SqliteConnection, scope: TxScope | undefined): SqliteExecutor {
    const call = <T>(f: () => T): T => (scope ? this.guard(scope, f) : this.mapBusy(f));
    return {
      all: <T>(q: SqliteStatement) => {
        const { sql, params } = render(q);
        return call(() => conn.all(sql, params)) as T[];
      },
      get: <T>(q: SqliteStatement) => {
        const { sql, params } = render(q);
        return call(() => conn.all(sql, params))[0] as T | undefined;
      },
      run: (q: SqliteStatement) => {
        const { sql, params } = render(q);
        return call(() => conn.run(sql, params));
      },
    };
  }

  /** `f` inside the transaction `scope`, refused once it has ended. */
  private guard<T>(scope: TxScope, f: () => T): T {
    if (scope.closed) {
      throw new Error(`SqliteDatabase ${this.name}: the transaction has already ended`);
    }
    return this.mapBusy(f);
  }

  /** A SQLITE_BUSY from a statement is the protocol error `busy`. */
  private mapBusy<T>(f: () => T): T {
    try {
      return f();
    } catch (err) {
      if (isSqliteBusy(err)) throw this.busyError(0);
      throw err;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error(`SqliteDatabase ${this.name} is closed`);
  }
}
