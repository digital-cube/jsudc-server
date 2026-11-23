// @jsudc/server/better-sqlite3: the `better-sqlite3` adapter of `SqliteDatabase`,
// the same interface `@jsudc/server/sqlite` gives `node:sqlite`. `better-sqlite3`
// is an optional peer: only `openBetterSqlite` loads it (Node's `require`, on its
// first call; the package is CommonJS), so a host that does not use it installs
// nothing, and one that forgot to is told so. The wrapper and the `sqlite_table`
// source are re-exported here so a host needs one import.
//
// The public types name no `better-sqlite3` type (`BetterSqliteDatabase` is the
// part of its `Database` this adapter uses), so a host compiles without
// `@types/better-sqlite3`.

import { createRequire } from "node:module";
import {
  DEFAULT_SQLITE_BUSY_TIMEOUT_MS,
  type SqliteConnection,
  SqliteDatabase,
  type SqliteDatabaseOptions,
  type SqliteRunResult,
} from "./sqlite-database.js";

/** One prepared statement of `better-sqlite3`, as far as the adapter uses it. */
export interface BetterSqliteStatement {
  /** Whether the statement returns rows (a `SELECT`, a `RETURNING`). */
  readonly reader: boolean;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  raw(toggle?: boolean): BetterSqliteStatement;
}

/** A `better-sqlite3` `Database`, as far as the adapter uses it. */
export interface BetterSqliteDatabase {
  readonly open: boolean;
  prepare(sql: string): BetterSqliteStatement;
  exec(sql: string): unknown;
  close(): unknown;
  function(
    name: string,
    options: { deterministic?: boolean },
    fn: (...args: unknown[]) => unknown,
  ): unknown;
}

/**
 * A value as `better-sqlite3` binds it: a boolean as 1/0, `undefined` as
 * NULL, a Date as its ISO text, bytes as a Buffer (it refuses the others).
 */
function bindable(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array && !Buffer.isBuffer(v)) {
    return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  }
  return v;
}

const bound = (params: readonly unknown[]): unknown[] => params.map(bindable);

/**
 * A `SqliteConnection` over one `better-sqlite3` `Database`. Its `all` (and
 * `values`) refuses a statement that returns no rows; the adapter runs such a
 * statement and answers no rows, as `node:sqlite` does.
 */
export function betterSqliteConnection(db: BetterSqliteDatabase): SqliteConnection {
  return {
    all: (sql, params) => {
      const stmt = db.prepare(sql);
      if (!stmt.reader) {
        stmt.run(...bound(params));
        return [];
      }
      return stmt.all(...bound(params)) as Record<string, unknown>[];
    },
    values: (sql, params) => {
      const stmt = db.prepare(sql);
      if (!stmt.reader) {
        stmt.run(...bound(params));
        return [];
      }
      return stmt.raw(true).all(...bound(params)) as unknown[][];
    },
    run: (sql, params): SqliteRunResult => {
      const r = db.prepare(sql).run(...bound(params));
      return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
    },
    exec: (sql) => {
      db.exec(sql);
    },
    close: () => {
      if (db.open) db.close();
    },
  };
}

export interface OpenBetterSqliteOptions extends Omit<SqliteDatabaseOptions, "write" | "read"> {
  /** As `OpenNodeSqliteOptions.unicodeLower`: a Unicode `lower()` on both connections. Off by default. */
  unicodeLower?: boolean | undefined;
  /**
   * Called with each `Database` once it is open: a host's own functions,
   * extensions, pragmas. Typed by the part the adapter knows; it is the
   * `better-sqlite3` `Database` itself.
   */
  setup?: ((db: BetterSqliteDatabase) => void) | undefined;
}

/** The `Database` constructor of `better-sqlite3`, as far as the adapter uses it. */
type BetterSqliteConstructor = new (
  path: string,
  options?: { readonly?: boolean },
) => BetterSqliteDatabase;

let driver: BetterSqliteConstructor | undefined;

/** `better-sqlite3`, loaded once; a clear error when it is not installed. */
function loadDriver(): BetterSqliteConstructor {
  if (driver) return driver;
  try {
    driver = createRequire(import.meta.url)("better-sqlite3") as BetterSqliteConstructor;
  } catch (err) {
    throw new Error(
      'openBetterSqlite needs the optional peer "better-sqlite3" (npm install better-sqlite3)',
      { cause: err },
    );
  }
  return driver;
}

function registerLower(db: BetterSqliteDatabase): void {
  db.function("lower", { deterministic: true }, (s) =>
    s === null ? null : String(s).toLowerCase(),
  );
}

/**
 * Open a SQLite database file with `better-sqlite3` as one `SqliteDatabase`,
 * as `openNodeSqlite` does with `node:sqlite`: a write connection and a
 * read-only read connection, WAL mode, the wrapper's busy handling.
 * `:memory:` (or an empty path) opens a single connection.
 */
export function openBetterSqlite(path: string, opts: OpenBetterSqliteOptions = {}): SqliteDatabase {
  const Database = loadDriver();
  const memory = path === "" || path === ":memory:";
  const prepare = (db: BetterSqliteDatabase): BetterSqliteDatabase => {
    if (opts.unicodeLower) registerLower(db);
    opts.setup?.(db);
    return db;
  };
  // better-sqlite3 sets its own busy timeout of 5 s; the wrapper sets the writer's to 0.
  const writeDb = prepare(new Database(memory ? ":memory:" : path));
  const write = betterSqliteConnection(writeDb);
  try {
    if (memory) return new SqliteDatabase({ ...opts, write });
    // WAL before the read connection opens (see openNodeSqlite).
    if (opts.wal ?? true) {
      writeDb.exec(`PRAGMA busy_timeout = ${opts.busyTimeoutMs ?? DEFAULT_SQLITE_BUSY_TIMEOUT_MS}`);
      writeDb.exec("PRAGMA journal_mode = WAL");
    }
    const readDb = prepare(new Database(path, { readonly: true }));
    return new SqliteDatabase({ ...opts, write, read: betterSqliteConnection(readDb), wal: false });
  } catch (err) {
    write.close();
    throw err;
  }
}

export {
  type SqliteOnMutateHook,
  type SqliteTableFieldSpec,
  SqliteTableSource,
  type SqliteTableSourceOptions,
  sqliteVersionTriggerSql,
} from "./sources/sqlite-table.js";
export {
  DEFAULT_SQLITE_BUSY_TIMEOUT_MS,
  isSqliteBusy,
  type SqliteConnection,
  SqliteDatabase,
  type SqliteDatabaseOptions,
  type SqliteExecutor,
  type SqliteProxyCallback,
  type SqliteRunResult,
  type SqliteStatement,
} from "./sqlite-database.js";
