# Changelog

All notable changes to `@jsudc/server` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). `@jsudc/core`,
`@jsudc/server` and `@jsudc/react` share one version line and release together.

## [Unreleased]

### Added

- `reindex` on `postgres_table` (`capabilities.reindex: true` when the source
  writes), so a kanban board over a relational Postgres table no longer
  answers `unsupported_op` once a drop finds two neighbours with adjacent
  orders. The rows of the scope, inside the base `where` and the row scope,
  are locked in the write table and renumbered `gap`, `2*gap`, … in their
  current order (NULLs last, ties by id) in one transaction, each version
  bumped; the order and scope fields must be writable columns of the write
  table. The renumbered rows go to `changedRows`, so the change feed names
  them. Works over a `from` with joins and a `writeTable`.

### Changed

- `sqlite_table` and `postgres_table` build their `reindex` statement with one
  shared function (`reindexUpdate`, `src/sources/sql-reindex.ts`); the SQLite
  statement is unchanged.

## [0.7.0] - 2026-11-23

Three pieces of work, released together with `@jsudc/core` 0.7.0 and
`@jsudc/react` 0.7.0; needs `@jsudc/core` 0.7.0 (the `sqlite_table` kind and
the `busy` error code):

1. `@jsudc/server` imports without `pg`: everything that needs `pg` or a
   Postgres database moves to a second entry, `@jsudc/server/postgres`, and
   `pg` becomes an optional peer. A host that serves only `memory`,
   `filesystem`, `http_api`, `yaml_menu` or `sqlite_table` collections installs
   no Postgres driver.
2. A dialect in the SQL compiler: the same filter, sort and keyset cursor
   compiled for Postgres or SQLite.
3. `sqlite_table`, a SQLite table as a collection (read, write, row scope,
   `reindex`), over one shared `SqliteDatabase` per file, with `node:sqlite`
   from `@jsudc/server/sqlite`.

Breaking: a Postgres host changes its imports (below), nothing else.

### Migration

Import these from `@jsudc/server/postgres` instead of `@jsudc/server` (one
line each; the names, signatures and behaviour are unchanged):

- `connect`, `Db`, `DbHandle`, `Executor`
- `ensureUdcSchema`, `udcMigrations`, `UDC_MIGRATIONS_DIR`
- `collectionTable`, `createCollectionTableSql`, `udcSchemaRevisions`
- `activeSchema`, `writeSchemaRevision`
- `seedCollection`, `SeedOptions`, `SeedResult`
- `createPostgresChangeBus`, `PostgresChangeBus`, `PostgresChangeBusOptions`,
  `encodeNotice`, `DEFAULT_CHANGE_CHANNEL`, `NOTIFY_PAYLOAD_LIMIT`
- `PostgresJsonbSource`, `PostgresJsonbSourceOptions`
- `PostgresTableSource`, `PostgresTableSourceOptions`, `TableFieldSpec`,
  `PostgresTableSearch`
- `columnResolver`, `ColumnResolverOptions`, `jsonbResolver`
- `OnMutateHook` (its `tx` is a Postgres `Executor`; `OnMutateResult` and
  `RowChange` stay in the root entry)
- `makeSource` when a collection is `postgres_jsonb` or `postgres_table`, or
  when you pass `db`: the subpath's `makeSource` makes every kind and takes
  `PostgresSourceDeps` (`SourceDeps` plus `db`). The root entry's `makeSource`
  makes the other kinds (`memory`, `filesystem`, `http_api`, `yaml_menu` and
  `sqlite_table`); `SourceDeps` no longer has `db`.

### Changed

- The `@jsudc/core` peer range is `^0.7.0` (`sqlite_table`, `busy`); `^0.6.0`
  does not accept 0.7.0.
- New subpath export `@jsudc/server/postgres` (`dist/postgres.js`). The root
  entry imports neither `pg` nor `drizzle-orm/node-postgres`, at runtime or in
  its `.d.ts`, directly or through another module.
- `pg` is an optional peer (`peerDependenciesMeta`). `drizzle-orm` stays a
  required peer: the root entry's SQL compiler (`compileFilter`, `orderBy`, …)
  and the `mutate_many` helpers build `drizzle-orm` `SQL`, and the dialect
  work compiles the same filters for SQLite through it. Only `drizzle-orm`'s
  core and its driver-free `sqlite-core` (the SQLite renderer) are loaded by
  the root entry; neither has dependencies of its own.
- The root entry's `makeSource` refuses a `postgres_jsonb` or `postgres_table`
  collection with an error that names `@jsudc/server/postgres` and `pg`.
- `wireVersion` stays in the root entry; it and the registry's check of a
  `postgres_jsonb` schema (`core_fields` empty) no longer go through the
  Postgres schema store.

### Added

- A dialect in the SQL compiler: `compileFilter`, `compileSort`, `orderBy`,
  `cursorPredicate`, `sortKeyColumns` and `idParam` compile the same filter,
  sort and keyset cursor for Postgres or SQLite. `SqlDialect`,
  `postgresDialect` (the default: the Postgres text of every existing caller
  is byte-identical, pinned by `test/sql-postgres-golden.test.ts`) and
  `sqliteDialect`; a `FieldResolver` carries its `dialect`. `sortKeyColumns`
  takes the resolver as an optional second argument, `idParam` and
  `codePointOrder` a dialect as an optional last one.
- `sqliteColumnResolver`, `sqliteQuery` (a compiled `SQL` as `?` text +
  params, through drizzle's SQLite renderer; no drizzle database object),
  `sqliteDateTime` (the stored and bound datetime form) and `escapeGlob`. The
  jsonb read suites (`pg-filter`, `pg-paging`, `pg-parity`, `pg-array`,
  `pg-allowlist`) run a third time against SQLite `:memory:` (`node:sqlite`).
- `PostgresSourceDeps`, `RevisionEdit` and `WriteRevisionOptions` exported
  from `@jsudc/server/postgres`.
- `npm run test:no-pg` and a CI job without a database: `npm pack`, the
  tarball installed in an empty directory (no `pg` there), then the root entry
  loads a `memory` collection and `buildApp({ swagger: false })` answers
  `describe` and `list`; importing `@jsudc/server/postgres` there fails on
  the missing `pg` only.
- `sqlite_table`: `SqliteTableSource`, one table of a SQLite file with typed
  columns — filter, sort, keyset and offset paging, `read`, and `mutate` with
  the row scope in the `WHERE` of every statement (`enforcesRowScope`), its
  `eq` pins written over an insert or a patch, the written row read back in
  scope and the transaction rolled back when it left it. The options of
  `PostgresTableSourceOptions` that carry over (no `from` with joins, no
  `onMutate`, no search); `capabilities.mutate_many` and `search` are off.
  Values are served in the protocol's JSON types without `to_jsonb`. A `uuid`
  id is lower-case TEXT, assigned with `crypto.randomUUID()` on insert.
- `sqlite_table` `reindex` (`capabilities.reindex: true` when the source
  writes): the scope's rows renumbered to `gap`, `2*gap`, … in their current
  order (NULLs last, ties by id), each version bumped, in one `BEGIN
  IMMEDIATE` transaction and one `UPDATE … FROM` with the base `where` and
  the row scope ANDed in. The order field and the scope fields must be
  writable columns (`validation_error` otherwise). A kanban board over a
  SQLite table no longer fails a drop whose neighbours leave no room.
- `reindex` hands `SourceContext.changedRows` to the source as `mutate_many`
  does: a source that reports the rows it renumbered (`sqlite_table`) gets a
  change notice with their ids; the others keep the notice without ids.
- `SqliteDatabase`, the one object per SQLite file a host shares with the
  sources: one write connection behind an in-process queue, one read
  connection, WAL, `BEGIN IMMEDIATE` for every write transaction, the write
  lock waited for asynchronously up to `busyTimeoutMs` and then answered with
  the protocol error `busy`. Code running inside a transaction joins it
  (nested ones are savepoints); `proxy` is the callback of
  `drizzle-orm/sqlite-proxy`. No driver is imported: a `SqliteConnection`
  adapts one.
- `@jsudc/server/sqlite`: `openNodeSqlite(path, opts)` and
  `nodeSqliteConnection(db)`, the `node:sqlite` adapter (Node 24, no native
  addon), with the wrapper and the source re-exported. The root entry stays
  driver-free.
- `sqliteVersionTriggerSql({ table, versionColumn })`: the `AFTER UPDATE`
  trigger that bumps the version for writers that do not, never twice for
  the source.
- `makeSource` (root entry) makes a `sqlite_table` collection from
  `source.yaml` over `SourceDeps.sqlite[options.database]`.
- `npm run test:sqlite`: the SQLite suites, no database server needed. The
  `sqlite` Vitest project now runs the jsonb read suites through
  `SqliteTableSource`. `test:no-pg` also serves a `sqlite_table` collection
  from the packed tarball (`NO_PG_CORE_DIR` installs a local core).

## [0.6.0] - 2026-11-23

What a mail client's list views asked for after 0.5.0, on the server side: the
fields a source sorts on in `describe`, schema fields kept out of the table, a
`postgres_table` default order and a checked `default_sort`; released together
with `@jsudc/core` 0.6.0 and `@jsudc/react` 0.6.0.

### Added

- `describe.sortable` (`@jsudc/core` 0.6.0): `{ fields }`, the live schema
  fields in `field_order` that the source sorts on, without the scope's hidden
  fields. A `PostgresTableSource` field with `sortable: false` is left out, so
  a client no longer offers a sort the source refuses with `validation_error`.
  New optional `Source.notSortable` (as `notFilterable`), set by
  `PostgresTableSource` and carried by `withSearchIndex`; `sortableFields`,
  `Described` and `SortableFields` are exported. Typed here, so the server
  still builds against `@jsudc/core` 0.5.0.
- `describe` leaves a schema field out of the table on request: a column marked
  `hidden: true` is not served (and its field gets no default column), and a
  view with `columns_mode: listed` gets no default column for the fields it
  does not list. The fields stay in the schema, the rows and the filter
  builder. `deriveColumns` takes the mode as an optional fourth argument
  (`"all"` by default). Both keys are read loosely, so `@jsudc/core` 0.5.0
  views carry them too.
- `PostgresTableSource` option `defaultSort` (as `ArraySource` has): the order
  of a `list` whose `sort` is absent or empty, instead of the id alone. A
  ranked search without a sort still comes by rank; cursor paging follows the
  default order. The constructor refuses a field that is unknown or
  `sortable: false`.
- The registry refuses a view whose `default_sort` (`@jsudc/core` 0.6.0) names
  a field the schema lacks or has deleted, names one twice, or is not a list
  of sort keys (`viewDefaultSortProblems`, exported). The key is read loosely,
  so this works against `@jsudc/core` ^0.5.0.

### Changed

- The `@jsudc/core` peer range is `^0.6.0` (`default_sort`, `hidden` and
  `columns_mode`, `describe.sortable`, `width: fill` with `grow`, `min_width`
  and `hide_below`); `^0.5.0` does not accept 0.6.0. The new keys are still
  read loosely.

## [0.5.0] - 2026-11-22

Many rows changed in one request (`mutate_many`) under the caller's context
and scope, the host's own actions typed end to end, search answered by the
source and the change feed (notify, a bus across processes, an SSE stream under
the scope), released together with `@jsudc/core` 0.5.0 and `@jsudc/react`
0.5.0. Needs `@jsudc/core` 0.5.0. A host that changes nothing keeps 0.4.0's
behaviour.

### Added

- The `mutate_many` action (`@jsudc/core`): update or delete many rows in one
  request, by `ids` or by `filter` minus `except_ids`, under the context,
  row scope and access rules of `mutate`. An id that is missing or outside
  the scope is reported in `failed` as `not_found` and left alone; a filter
  is ANDed with the scope. The patch is validated once, before anything is
  written (read-only and hidden scope fields refused, pins kept); a patch
  that would take a row out of the scope refuses the request. Each changed
  row's version is bumped; no `expected_version`.
- `PostgresJsonbSource` and `PostgresTableSource` implement it natively in
  one transaction: the target rows locked in id order, one `UPDATE` /
  `DELETE` without `onMutate`; with it, row by row, the hook called per row
  with `before` / `after`, and a hook failure rolls the whole request back.
- `createDispatcher` option `mutateManyLimit` (default
  `DEFAULT_MUTATE_MANY_LIMIT`, 10 000): more ids, or a filter matching more
  rows (counted with a bounded query, so with `total_count: false` too), is a
  `validation_error` with `details.reason: "too_many_rows"`, nothing written.
- A generic `mutate_many` for any source without a native one (`memory`, a
  host's own): the rows read under scope, the checks done, then `mutate` per
  row. `Source.mutateMany?(req, sctx)` (`SourceMutateMany`,
  `MutateManyResult`) lets a host's source do it natively.
- `capabilities.mutate_many` is `true` wherever `mutate` is (`describe`,
  `collections`), unless a source sets it `false`.
- Host actions typed end to end: `Dispatcher.register(action, handler)` takes
  a `HostAction` from `@jsudc/core`'s `defineHostAction`; the handler
  (`HostActionHandler`) is typed from it and receives the request context,
  the payload is validated with its request schema, and the OpenAPI document
  shows its response schema (`Dispatcher.responseOf(action)`).
  `register(name, schema, handler)` is unchanged.
- Search answered by the source. The dispatcher passes `ListRequest.search`
  (`@jsudc/core`) to the source as `SourceListRequest.search` (optional,
  trimmed; a blank text is no search), ANDed with the row scope and the
  client's filter. A collection whose source does not report
  `capabilities.search: "source"` refuses a `search` with `unsupported_op`
  (`details.field: "search"`) instead of ignoring it.
- `PostgresTableSource` option `search` (`PostgresTableSearch`): `match(q,
  text)`, a condition in SQL with the text as a bound parameter, and
  optional `rank(q, text)`. With it the source reports `search: "source"`;
  a search without `sort` comes by rank (ties by id), paged by offset, with a
  `next_cursor` that carries the next offset.
- `withSearchIndex(source, { search })`: the search answered by an external
  index (OpenSearch and the like). The host returns one page of ids in
  relevance order (and a `total`) for `{ text, page, ctx, collection,
  rowScope, filter?, sort? }` (`SearchIndexQuery`, `SearchIndexResult`,
  `SearchIndexOptions`); jsudc loads those rows under the scope and the
  filter, in that order, dropping the ones the scope hides.
- `searchText`, `assertSearchable`, `searchPage`, `encodeSearchCursor`,
  `decodeSearchCursor` for a source of your own that answers `search`.
- `mutate_many` by `filter` does not take search text (documented).
- The change feed: `createChangeFeed({ bus?, heartbeatMs?, retryMs?,
  coalesce?, maxIds?, log? })` (`ChangeFeed`) given to `createDispatcher` as
  the new option `changes`. With it, every collection reports
  `capabilities.changes: true` (`subscribe` stays `false`), and `udcPlugin`
  serves `GET /udc/changes?collections=a,b` as Server-Sent Events (it then
  needs `registry`): `context` once at connect (a refusal is HTTP 401 / 403,
  not a stream), each collection under the `access` rule of `list` (404
  otherwise) and its row scope, a `retry:` hint, a `ready` event, `change`
  events `{ collection, op, ids? }` with no row data, a heartbeat comment,
  the listener removed when the client leaves, every stream ended on
  `app.close()`. Works under the plugin's `prefix` and keeps headers a
  host's hooks set (CORS). No replay. `registerChangesRoute`,
  `ChangesRouteOptions`, `MAX_CHANGE_COLLECTIONS`.
- jsudc's own writes notify after they commit, once per request, never for
  a failed one: `mutate` (the row's id; an update also tested on the row as
  it was), `mutate_many` (the changed ids), `reindex` and `tree.reparent`
  (without ids). Without `changes` nothing runs and nothing changes.
- `ChangeFeed.notify(collection, { op?, ids?, ctx?, rows? })` for a host's
  own writes. The scope rule: a stream is told when its collection has no
  row scope for it, or its scope (core's `evaluateFilter`) holds for at
  least one changed row's values, and then only those rows' ids; the values
  come from the written rows, the `eq` conditions of `rowScope(ctx,
  collection)`, or the host's `rows`. A notify with neither `ctx` nor `rows`
  on a collection that has a row scope throws. `NotifyOptions`, `eventFor`,
  `scopeValues`, `ChangeSubscriber`, `ChangeFeed.listenerCount`.
- Buses between server processes: `ChangeBus` (`publish` / `subscribe`, a
  `ChangeNotice` with server-side `ChangeMatch` values), the default
  in-process `MemoryChangeBus`, and `createPostgresChangeBus({
  connectionString, pool?, channel?, reconnectDelayMs?, maxReconnectDelayMs?,
  log? })` (`PostgresChangeBus`): a dedicated `LISTEN` connection that
  reconnects with backoff, local delivery without the echo, a payload over
  NOTIFY's limit sent without ids (`encodeNotice`, `NOTIFY_PAYLOAD_LIMIT`,
  `DEFAULT_CHANGE_CHANNEL`).
- Burst control per stream and collection (`coalesce`: past 20 events in
  250 ms, one event without ids), and `maxIds` (500): a longer id list is
  sent without ids.
- `SourceContext.changedRows` (optional): on a `mutate_many` with a feed, a
  source hands over the rows it wrote; both Postgres sources do. `ScopedCollection`
  and `openCollection` take the feed as a new optional last argument.

### Changed

- The `@jsudc/core` peer range is `^0.5.0` (`mutate_many`, host actions, `ListRequest.search` and the change feed's
  `ChangeEvent` come from core 0.5.0). The development
  dependency is pinned to core's `release-0.5.0` commit until core 0.5.0 is on
  npm.

## [0.4.0] - 2026-11-22

Request context and a host-imposed row scope, the `postgres_table` source
(reads, writes, `onMutate`) and the SQL compiler exported, released together
with `@jsudc/core` 0.4.0 and `@jsudc/react` 0.4.0. Needs `@jsudc/core` 0.4.0.

### Added

- Request context: `udcPlugin` option `context(request)` (sync or async). Its
  value travels through `Dispatcher.dispatch(msg, ctx?)` (new optional
  argument) to every handler — `register` handlers get `(payload, ctx)`, a
  one-argument handler still works — and to every `Source` method as a
  trailing optional `SourceContext` (`{ctx, collection, rowScope?}`); every
  shipped source accepts it. A `UdcError` thrown by `context` refuses the
  request in-protocol (HTTP 200, `.err`); the file preview route answers 401
  (unauthenticated) / 403. Anything else is `internal`, logged, not leaked.
- Host-imposed row scope: `createDispatcher` options `rowScope(ctx,
  collection)`, `access(ctx, {action, collection})` and `showScopeFields`
  (`DispatcherOptions`, `RowScopeOptions`, `AccessRequest`). One generic layer
  (`ScopedCollection`, `openCollection`) holds every source to the scope on
  `list` (total and both pagings in scope), `read` and `mutate` (outside →
  `not_found`, identical to a missing id), insert / patch (top-level `eq`
  values pinned; a row still outside → `forbidden`, `reason: "out_of_scope"`),
  `reindex` (ANDed with the request's `scope`) and `tree.reparent`;
  `postgres_jsonb` also enforces it inside its SQL (`Source.enforcesRowScope`).
  The scope's fields are hidden from `describe` and the rows unless the
  collection is in `showScopeFields`. `schema.*` and `source.read` on a scoped
  collection are `forbidden` unless `access` answers `true`; `access: false`
  hides a collection (`collections`, `not_found`). `GET /udc/files/blob` runs
  `context`, `access` and the scope (404 outside).
- `registerBlobRoute(app, registry, opts?)`: optional `BlobRouteOptions`
  (`context`, `scope`). Helpers `andFilters`, `rowScopePins`, `withoutFields`,
  `describeWithout`, `TENANT_WIDE_ACTIONS`.
- `postgres_table` source (`PostgresTableSource`, `PostgresTableSourceOptions`,
  `TableFieldSpec`), read side: a collection served from an ordinary relational
  table with typed columns, or a `FROM` with joins given in code, through the
  same filter / sort / keyset-cursor / offset compiler as `postgres_jsonb`.
  Field → column or SQL expression (a computed field, e.g. a count from a join,
  lists, sorts and filters; `filterable: false` / `sortable: false` refuse it
  like an unknown field), id column of type `uuid` (default), `text` or
  `integer`, optional version column, a base `where`, `totalCount: false` (no
  `count(*)`, `total: null`, `capabilities.total_count: false`). The row scope
  is compiled into the `WHERE` of `list` and `read`. `capabilities`:
  `schema_edit`, `reindex`, `tree_reparent` false. `makeSource` builds it for
  `kind: postgres_table` in `source.yaml` (table, id / version columns, field →
  column names, `total_count`).
- `postgres_table` writes: `mutate` inserts, updates (partial patch) and
  deletes rows of the source's `table`, or of `writeTable` (with
  `writeAlias`) under a `from` with joins; a `from` without one stays
  read-only (`capabilities.mutate: false`, `unsupported_op`), as does any
  source with `readOnly: true`. Only plain mapped columns are written: a
  computed field, a column marked `readOnly` (`TableFieldSpec.readOnly`) or a
  column of another table of the `from` in an insert or patch is refused with
  `validation_error` naming it (`source.readOnlyFields`). With a
  `versionColumn`, every update increments it and `expected_version` is
  checked with the row locked (`version_conflict`, `details.current_version`);
  without one the version is always `1` and `expected_version` is accepted and
  not checked (no optimistic locking). The row scope is in the `WHERE` of
  update and delete (outside → `not_found`), its `eq` values are forced on
  insert, and the written row is read back through the `from` (outside the
  scope or the base `where` → `forbidden`, rolled back). Every write is one
  transaction.
- `onMutate(ctx, change, tx)`, an option of `PostgresTableSource` and
  `PostgresJsonbSource` (`OnMutateHook`, `OnMutateResult`, `RowChange`): a
  host's own write on every mutation, run inside the transaction after the
  source's statement and before `COMMIT`, with the row locked. `change` is `{
  op, collection, id, before, after, patch }`, `tx` an executor on the same
  transaction. A returned row is what the caller receives. A throw rolls
  everything back: a `UdcError` reaches the caller as it is, anything else is
  `internal` and logged. Without the option `postgres_jsonb` issues the same
  statements as before, with no transaction added.
- The SQL compiler is exported, around a field resolver: `compileFilter(node,
  schema, resolve?)`, `compileSort`, `orderBy`, `sortKeyColumns`,
  `cursorPredicate`, `encodeCursor`, `decodeCursor(cursor, keys, idType?)`,
  `escapeLike`, `FieldResolver`, `jsonbResolver`, `columnResolver`, `SortTerm`,
  `SqlCast`, `SqlIdType`, `SqlArrayForm`, `sqlCastFor`, `codePointOrder`,
  `idParam`, `CursorValue`. Every `resolve` defaults to `jsonbResolver`, which
  writes exactly the SQL text of 0.3.0 (the expression indexes and query plans
  of `postgres_jsonb` are unchanged).
- `Source.notFilterable` (optional): fields `describe` leaves out of
  `filterable`.

### Changed

- The `@jsudc/core` peer range is `^0.4.0` (the request context imports
  `unauthenticatedError` / `isUnauthenticated`, which only core 0.4.0
  exports). The development dependency is pinned to core's `release-0.4.0`
  commit until core 0.4.0 is on npm.

## [0.3.0] - 2026-11-15

Lookups, level 1, on the server side, released together with `@jsudc/core`
0.3.0 and `@jsudc/react` 0.3.0. Needs `@jsudc/core` 0.3.0.

### Added

- Lookups, level 1: `lookup` / `lookup_array` fields store their key, sort
  by it (as text) and filter on it with `eq neq in not_in is_null
  is_not_null` (`lookup_array`: `in not_in is_null is_not_null`); any other op
  on them is `unsupported_op`. An indexed `lookup` gets an expression index.
- `id` in a filter is the row id when the schema has no `id` field, in every
  source (`eq neq in not_in is_null is_not_null`).
- `loadRegistry` checks lookup targets and `row_link`s against the served
  collections and stops the start on a mismatch; `udcPlugin` (with
  `registry`) checks the active schemas too (`checkLinks: false` skips it).
  New exports: `registryLinkProblems`, `assertRegistryLinks`,
  `checkRegistryLinks`, `assertLookupTarget`.
- `schema.add_field` accepts `lookup` / `lookup_array` and checks the target;
  `schema.update_field` checks it too.

### Changed

- The `@jsudc/core` peer range (and the development dependency) is `^0.3.0`.

## [0.2.1] - 2026-10-30

Released in lockstep with `@jsudc/react` 0.2.1; `@jsudc/core` stays 0.2.0 and
the peer range `^0.2.0` is unchanged.

### Fixed

- String comparisons and sorts no longer depend on the database's collation.
  `gt`, `gte`, `lt`, `lte` and `between` on a text field, `ORDER BY` and the
  cursor of `list` compare by code point (`COLLATE "C"`), as `evaluateFilter`
  in `@jsudc/core` does. On a database with a linguistic collation (the
  `postgres` image's default `en_US.utf8`) the same filter used to give the
  server one result and the browser another: `gt "a"` matched `Alfa`, and
  sorting put `beta` before `Gama`. `case_insensitive` comparisons lower-case
  under the database's collation, then compare by code point.
- The expression index of an `index: true` text field is built on the same
  `COLLATE "C"` expression, so the planner keeps using it. The new migration
  `0002_udc_text_index_collation.sql` (run by `ensureUdcSchema`) rebuilds an
  index made before on the bare expression; that locks writes on the table
  while it runs, once.

### Changed

- CI tests against `postgres:16` with its default locale (`en_US.utf8`) and
  with `C.UTF-8`; the publish workflow uses the default locale. The
  `--locale=C.UTF-8` workaround of 0.2.0 is gone.

## [0.2.0] - 2026-10-30

No changes to the code or the API; released in lockstep with `@jsudc/react`
0.2.0, whose breaking changes move the shared version line to 0.2.

### Changed

- The `@jsudc/core` peer range is `^0.2.0`. Install `@jsudc/core@0.2.0`
  next to this package (its code is that of 0.1.1).
- Development installs `@jsudc/core` from npm (`^0.1.1`) instead of
  `github:digital-cube/jsudc-core#v0.1.0`; `package-lock.json` no longer pins
  it over SSH, and CI and the publish workflow drop the deploy-key step.
- CI and the publish workflow initialise their Postgres with
  `--locale=C.UTF-8`, the byte-order collation of development: under the
  image's default `en_US.utf8` the string comparisons of `pg-filter.test.ts`
  (`gt`, `gte`, `lte`, `between`) disagree with the in-memory evaluator, so CI
  was red and a tag could not publish. The library's SQL is unchanged.

## [0.1.1] - 2026-10-29

First release on npmjs.org. No change to the code or the API.

### Added

- Published to npmjs.org as a public package; `npm install @jsudc/server`.
- Tags `v*` publish themselves from GitHub Actions with npm provenance
  (`.github/workflows/publish.yml`, OIDC trusted publishing, no token).
- `CHANGELOG.md`; a committed `package-lock.json`, so CI and the publish
  workflow run `npm ci`.

### Changed

- `@jsudc/core` is a **peer dependency**, `^0.1.1` from npm, instead of a
  dependency on `github:digital-cube/jsudc-core#v0.1.0`: install it next to
  this package, so the application has one copy of the protocol.
- `package.json`: `publishConfig.access: "public"`, `repository` / `bugs` in
  object form, keywords `universal-data-collections` and `data-grid`.
- README: install from npm; the GitHub tag stays as an alternative.

## [0.1.0] - 2026-10-29

First tagged version, installed from the GitHub tag.

### Added

- A UDC server in TypeScript: the dispatcher, the collection registry, five
  sources (Postgres jsonb, memory, filesystem, HTTP API, YAML menu), schema
  revisions and edits, seeding, and `udcPlugin`, a Fastify plugin with the
  OpenAPI document of every action.
- `migrations/`: the UDC-owned SQL (`udc_schema_revisions`, the `udc_date` /
  `udc_timestamptz` casts), also run by `ensureUdcSchema`.

[Unreleased]: https://github.com/digital-cube/jsudc-server/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/digital-cube/jsudc-server/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/digital-cube/jsudc-server/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/digital-cube/jsudc-server/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/digital-cube/jsudc-server/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/digital-cube/jsudc-server/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/digital-cube/jsudc-server/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/digital-cube/jsudc-server/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/digital-cube/jsudc-server/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/digital-cube/jsudc-server/releases/tag/v0.1.0
