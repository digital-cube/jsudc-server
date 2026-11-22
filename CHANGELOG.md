# Changelog

All notable changes to `@jsudc/server` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). `@jsudc/core`,
`@jsudc/server` and `@jsudc/react` share one version line and release together.

## [Unreleased]

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

[Unreleased]: https://github.com/digital-cube/jsudc-server/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/digital-cube/jsudc-server/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/digital-cube/jsudc-server/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/digital-cube/jsudc-server/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/digital-cube/jsudc-server/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/digital-cube/jsudc-server/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/digital-cube/jsudc-server/releases/tag/v0.1.0
