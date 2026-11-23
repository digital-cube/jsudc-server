// @jsudc/server/postgres: everything that needs `pg` or a Postgres database —
// the connection, the udc_* migrations, the schema revision store, seeding,
// the LISTEN/NOTIFY change bus and the postgres_jsonb / postgres_table
// sources. Importing this entry needs `pg` installed; the root entry does not.

export {
  createPostgresChangeBus,
  DEFAULT_CHANGE_CHANNEL,
  encodeNotice,
  NOTIFY_PAYLOAD_LIMIT,
  PostgresChangeBus,
  type PostgresChangeBusOptions,
} from "./changes-postgres.js";
export { connect, type Db, type DbHandle, type Executor } from "./db/client.js";
export { ensureUdcSchema, UDC_MIGRATIONS_DIR, udcMigrations } from "./db/ensure.js";
export { collectionTable, createCollectionTableSql, udcSchemaRevisions } from "./db/schema.js";
export {
  activeSchema,
  type RevisionEdit,
  type WriteRevisionOptions,
  writeSchemaRevision,
} from "./schema-store.js";
export { type SeedOptions, type SeedResult, seedCollection } from "./seed.js";
export { makeSource, type PostgresSourceDeps } from "./sources/postgres-factory.js";
export type { OnMutateHook } from "./sources/postgres-hook.js";
export { PostgresJsonbSource, type PostgresJsonbSourceOptions } from "./sources/postgres-jsonb.js";
export {
  type ColumnResolverOptions,
  columnResolver,
  type PostgresTableSearch,
  PostgresTableSource,
  type PostgresTableSourceOptions,
  type TableFieldSpec,
} from "./sources/postgres-table.js";
export { jsonbResolver } from "./sources/sql.js";
