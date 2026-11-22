// @jsudc/server: the UDC protocol served from a collection directory, over Fastify.

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
export { deriveColumns } from "./columns.js";
export { connect, type Db, type DbHandle, type Executor } from "./db/client.js";
export { ensureUdcSchema, UDC_MIGRATIONS_DIR, udcMigrations } from "./db/ensure.js";
export { collectionTable, createCollectionTableSql, udcSchemaRevisions } from "./db/schema.js";
export { buildDescribe, filterableFields } from "./describe.js";
export {
  createDispatcher,
  Dispatcher,
  type DispatcherOptions,
  type DispatchLogger,
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
} from "./registry.js";
export { activeSchema, wireVersion, writeSchemaRevision } from "./schema-store.js";
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
export { type SeedOptions, type SeedResult, seedCollection } from "./seed.js";
export { type ArrayLoad, ArraySource, READ_ONLY_ARRAY_CAPABILITIES } from "./sources/array.js";
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
export type { OnMutateHook, OnMutateResult, RowChange } from "./sources/on-mutate.js";
export { PostgresJsonbSource, type PostgresJsonbSourceOptions } from "./sources/postgres-jsonb.js";
export {
  type ColumnResolverOptions,
  columnResolver,
  PostgresTableSource,
  type PostgresTableSourceOptions,
  type TableFieldSpec,
} from "./sources/postgres-table.js";
export type {
  Source,
  SourceAddField,
  SourceContext,
  SourceListRequest,
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
  escapeLike,
  type FieldResolver,
  idParam,
  jsonbResolver,
  orderBy,
  type SortTerm,
  type SqlArrayForm,
  type SqlCast,
  type SqlIdType,
  sortKeyColumns,
  sqlCastFor,
} from "./sources/sql.js";
export {
  type MenuCollection,
  YamlMenuSource,
  type YamlMenuSourceOptions,
} from "./sources/yaml-menu.js";
