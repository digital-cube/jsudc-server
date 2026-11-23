// @jsudc/server/sqlite: SQLite with `node:sqlite` (Node 24, no native addon) —
// `openNodeSqlite` opens a database file as the one shared `SqliteDatabase` a
// host registers with the server (`SourceDeps.sqlite`) and runs its own SQL
// through. The wrapper and the `sqlite_table` source themselves import no
// driver and are in the root entry too; they are re-exported here so a SQLite
// host needs one import.

export {
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
export { nodeSqliteConnection, type OpenNodeSqliteOptions, openNodeSqlite } from "./sqlite-node.js";
