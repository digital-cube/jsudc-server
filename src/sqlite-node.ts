// The `node:sqlite` adapter of `SqliteDatabase` (Node 24: no native addon).

import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  DEFAULT_SQLITE_BUSY_TIMEOUT_MS,
  type SqliteConnection,
  SqliteDatabase,
  type SqliteDatabaseOptions,
  type SqliteRunResult,
} from "./sqlite-database.js";

/** A value as `node:sqlite` binds it: a boolean as 1/0, `undefined` as NULL, a Date as its ISO text. */
function bindable(v: unknown): SQLInputValue {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  return v as SQLInputValue;
}

const bound = (params: readonly unknown[]): SQLInputValue[] => params.map(bindable);

/** A `SqliteConnection` over one `node:sqlite` `DatabaseSync`. */
export function nodeSqliteConnection(db: DatabaseSync): SqliteConnection {
  return {
    all: (sql, params) => db.prepare(sql).all(...bound(params)) as Record<string, unknown>[],
    values: (sql, params) => {
      const stmt = db.prepare(sql);
      stmt.setReturnArrays(true);
      return stmt.all(...bound(params)) as unknown as unknown[][];
    },
    run: (sql, params): SqliteRunResult => {
      const r = db.prepare(sql).run(...bound(params));
      return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
    },
    exec: (sql) => db.exec(sql),
    close: () => {
      if (db.isOpen) db.close();
    },
  };
}

export interface OpenNodeSqliteOptions extends Omit<SqliteDatabaseOptions, "write" | "read"> {
  /**
   * Register a Unicode `lower()` (JavaScript's `toLowerCase`) on both
   * connections, so the case-insensitive filter ops fold `Č` like
   * `evaluateFilter` does; SQLite's own `lower()` folds ASCII only. Off by
   * default: it replaces the built-in for every statement of these
   * connections, and an index on `lower(x)` built by another program (the
   * `sqlite3` shell, which has the built-in) would then disagree with ours.
   */
  unicodeLower?: boolean | undefined;
  /** Called with each `DatabaseSync` once it is open: a host's own functions, extensions, pragmas. */
  setup?: ((db: DatabaseSync) => void) | undefined;
}

function registerLower(db: DatabaseSync): void {
  db.function("lower", { deterministic: true }, (s) =>
    s === null ? null : String(s).toLowerCase(),
  );
}

/**
 * Open a SQLite database file with `node:sqlite` as one `SqliteDatabase`: a
 * write connection and a read-only read connection, WAL mode, the wrapper's
 * busy handling. `:memory:` (or an empty path) opens a single connection:
 * a second one would be another, empty database.
 */
export function openNodeSqlite(path: string, opts: OpenNodeSqliteOptions = {}): SqliteDatabase {
  const memory = path === "" || path === ":memory:";
  const prepare = (db: DatabaseSync): DatabaseSync => {
    if (opts.unicodeLower) registerLower(db);
    opts.setup?.(db);
    return db;
  };
  const writeDb = prepare(new DatabaseSync(memory ? ":memory:" : path));
  const write = nodeSqliteConnection(writeDb);
  try {
    if (memory) return new SqliteDatabase({ ...opts, write });
    // WAL before the read connection opens: switching needs the file to itself for a moment,
    // which another process may hold (a sync wait here, at open time only).
    if (opts.wal ?? true) {
      writeDb.exec(`PRAGMA busy_timeout = ${opts.busyTimeoutMs ?? DEFAULT_SQLITE_BUSY_TIMEOUT_MS}`);
      writeDb.exec("PRAGMA journal_mode = WAL");
    }
    const readDb = prepare(new DatabaseSync(path, { readOnly: true }));
    return new SqliteDatabase({ ...opts, write, read: nodeSqliteConnection(readDb), wal: false });
  } catch (err) {
    write.close();
    throw err;
  }
}
