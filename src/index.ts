// @jsudc/server: the UDC protocol served from a collection directory, over Fastify.
// This entry imports no database driver: everything that needs `pg` or a
// Postgres database is in `@jsudc/server/postgres` (src/postgres.ts), and the
// `node:sqlite` adapter is in `@jsudc/server/sqlite` (src/sqlite.ts). The
// SQLite wrapper and the `sqlite_table` source need no driver and are here.

export {
  buildApp,
  type UdcPluginOptions,
  type UdcSwaggerOptions,
  udcPlugin,
} from "./app.js";
export {
  BLOB_MAX_BYTES,
  BLOB_ROUTE,
  BLOB_TYPES,
  type BlobRouteOptions,
  registerBlobRoute,
} from "./blob.js";
export {
  type ChangeBus,
  type ChangeCoalesceOptions,
  ChangeFeed,
  type ChangeFeedOptions,
  type ChangeListener,
  type ChangeMatch,
  type ChangeNotice,
  type ChangeSubscriber,
  createChangeFeed,
  eventFor,
  MemoryChangeBus,
  type NotifyOptions,
  scopeValues,
} from "./changes.js";
export {
  type ChangesRouteOptions,
  MAX_CHANGE_COLLECTIONS,
  registerChangesRoute,
} from "./changes-route.js";
export { deriveColumns } from "./columns.js";
export {
  buildDescribe,
  type Described,
  filterableFields,
  type SortableFields,
  sortableFields,
} from "./describe.js";
export {
  createDispatcher,
  Dispatcher,
  type DispatcherOptions,
  type DispatchLogger,
  type HostActionHandler,
} from "./dispatcher.js";
export {
  assertLookupTarget,
  assertRegistryLinks,
  checkRegistryLinks,
  type LinkedCollection,
  registryLinkProblems,
} from "./links.js";
export {
  type Collection,
  type CollectionAsset,
  CollectionRegistry,
  loadRegistry,
  readCollectionAssets,
  viewDefaultSortProblems,
} from "./registry.js";
export { wireVersion } from "./schema-rules.js";
export {
  type AccessRequest,
  andFilters,
  describeWithout,
  openCollection,
  type RowScopeOptions,
  rowScopePins,
  ScopedCollection,
  TENANT_WIDE_ACTIONS,
  withoutFields,
} from "./scope.js";
export { type ArrayLoad, ArraySource, READ_ONLY_ARRAY_CAPABILITIES } from "./sources/array.js";
export { DEFAULT_MUTATE_MANY_LIMIT } from "./sources/bulk.js";
export { type CursorValue, decodeCursor, encodeCursor } from "./sources/cursor.js";
export {
  cacheTtlEnvVar,
  filesystemRoot,
  httpSourcesEnabled,
  makeSource,
  rootEnvVar,
  type SourceDeps,
} from "./sources/factory.js";
export { FilesystemSource } from "./sources/filesystem.js";
export {
  type Env,
  type FetchLike,
  HttpApiSource,
  interpolateHeaders,
  mapItems,
  type SourceLog,
} from "./sources/http-api.js";
export { MemorySource } from "./sources/memory.js";
export type { OnMutateResult, RowChange } from "./sources/on-mutate.js";
export {
  assertSearchable,
  decodeSearchCursor,
  encodeSearchCursor,
  type SearchIndexOptions,
  type SearchIndexQuery,
  type SearchIndexResult,
  searchPage,
  searchText,
  withSearchIndex,
} from "./sources/search.js";
export type {
  MutateManyResult,
  Source,
  SourceAddField,
  SourceContext,
  SourceListRequest,
  SourceMutateMany,
  SourceMutation,
  SourceReindex,
  SourceTreeReparent,
  SourceUpdateField,
  TreeReparentResult,
} from "./sources/source.js";
export {
  codePointOrder,
  compileFilter,
  compileSort,
  cursorPredicate,
  dialectOf,
  escapeLike,
  type FieldResolver,
  idParam,
  orderBy,
  postgresDialect,
  type SortTerm,
  type SqlArrayForm,
  type SqlCast,
  type SqlDialect,
  type SqlIdType,
  type SqlTextOp,
  sortKeyColumns,
  sqlCastFor,
} from "./sources/sql.js";
export {
  escapeGlob,
  type SqliteColumnResolverOptions,
  type SqliteQuery,
  sqliteColumnResolver,
  sqliteDateTime,
  sqliteDialect,
  sqliteQuery,
} from "./sources/sqlite-sql.js";
export {
  type SqliteOnMutateHook,
  type SqliteTableFieldSpec,
  SqliteTableSource,
  type SqliteTableSourceOptions,
  sqliteVersionTriggerSql,
} from "./sources/sqlite-table.js";
export {
  type MenuCollection,
  YamlMenuSource,
  type YamlMenuSourceOptions,
} from "./sources/yaml-menu.js";
export {
  DEFAULT_SQLITE_BUSY_TIMEOUT_MS,
  DEFAULT_SQLITE_WATCH_MS,
  isSqliteBusy,
  type SqliteConnection,
  SqliteDatabase,
  type SqliteDatabaseOptions,
  type SqliteExecutor,
  type SqliteProxyCallback,
  type SqliteRunResult,
  type SqliteStatement,
} from "./sqlite-database.js";
