# @jsudc/server

[![npm](https://img.shields.io/npm/v/@jsudc/server)](https://www.npmjs.com/package/@jsudc/server)

A UDC (Universal Data Collection) server in TypeScript. Point it at a
directory of collections — each one a `view.yaml`, a `schema.json` and,
optionally, a `source.yaml` — and it serves them through the UDC protocol of
[`@jsudc/core`](https://github.com/digital-cube/jsudc-core): `describe`, `list`
with server-side filters, sorts and paging, `read`, `mutate`, and schema edits
that add, change or soft-delete a field at runtime.

What is in the package:

- the **dispatcher**, which validates every request against the protocol and
  answers with the `.ok` / `.err` envelope;
- the **collection registry**, which reads a collection directory and fails fast
  on an invalid document;
- six **sources**: Postgres `jsonb`, a relational Postgres table, memory,
  filesystem, HTTP API, YAML menu;
- the **schema store**: revisions of a Postgres collection's schema, with the
  expression index of every `index: true` field kept in step;
- **seeding** of a collection from its `schema.json` and rows;
- a **Fastify plugin** that mounts it all on your own server, with the OpenAPI
  document of every action.

Two entries. `@jsudc/server` imports no database driver: the dispatcher, the
plugin, the registry, the scope layer, the change feed, the SQL compiler and
the `memory`, `filesystem`, `http_api` and `yaml_menu` sources. Everything that
needs `pg` or a Postgres database — `connect`, the library's SQL, the schema
store, seeding, the `LISTEN` / `NOTIFY` bus and the `postgres_jsonb` /
`postgres_table` sources — is in `@jsudc/server/postgres`, and only that entry
needs `pg` installed.

```sh
npm install @jsudc/server @jsudc/core fastify drizzle-orm zod
# Postgres collections, the schema store and the Postgres bus (@jsudc/server/postgres):
npm install pg
# SQLite collections need nothing more: node:sqlite is built into Node 24 (@jsudc/server/sqlite)
# the OpenAPI docs at /docs (on by default):
npm install @fastify/swagger @fastify/swagger-ui fastify-type-provider-zod
# or straight from a GitHub tag:
npm install github:digital-cube/jsudc-core#v0.7.0 github:digital-cube/jsudc-server#v0.7.0
```

## Quick start

```ts
import Fastify from "fastify";
import { createDispatcher, loadRegistry, udcPlugin } from "@jsudc/server";
import { connect, ensureUdcSchema, makeSource } from "@jsudc/server/postgres";

const { db } = connect(process.env.DATABASE_URL ?? "postgresql://localhost/app");
await ensureUdcSchema(db); // or run migrations/*.sql with your own migration tool
const registry = loadRegistry("./collections", (asset, reg) =>
  makeSource(asset, { db, registry: reg, env: process.env }),
);
const app = Fastify({ logger: true });
await app.register(udcPlugin, {
  dispatcher: createDispatcher(registry, { log: app.log }),
  registry,
});
await app.listen({ port: 5100 });
```

```sh
curl -s localhost:5100/udc/list -H 'content-type: application/json' \
  -d '{"collection":"books","sort":[{"field":"pages","dir":"desc"}],"page":{"limit":5}}'
# {"kind":"udc.list.ok","id":"","payload":{"rows":[…],"next_cursor":null,"total":2}}
```

Every action is `POST /udc/<action>` with the payload as body and is always
answered with HTTP 200: the envelope's `kind` says ok or err. A body Fastify
cannot parse is answered in-protocol too (`validation_error`). `GET /healthz`
answers `{ok: true}`; `/docs` is the OpenAPI UI.

`buildApp({dispatcher, registry, logger})` does the two Fastify lines for you
and returns the instance, for a server that is nothing but UDC.

Without Postgres (no `pg` installed), the root entry's `makeSource` makes every
kind but the two Postgres ones; a `postgres_jsonb` or `postgres_table`
collection makes it throw, naming `@jsudc/server/postgres`:

```ts
import { buildApp, createDispatcher, loadRegistry, makeSource } from "@jsudc/server";

const registry = loadRegistry("./collections", (asset, reg) =>
  makeSource(asset, { registry: reg, env: process.env }),
);
const app = await buildApp({ dispatcher: createDispatcher(registry, { log: console }), registry });
```

### The plugin's options

| Option       | What                                                                                                                                                                                                                                |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dispatcher` | `createDispatcher(registry, {log})`; `log.error` receives what fails inside an action                                                                                                                                               |
| `registry`   | enables `GET /udc/files/blob?collection=&path=`, the file previews of filesystem collections whose view sets `folder_options.preview`                                                                                               |
| `checkLinks` | with `registry`: check every lookup and `row_link` against the active schemas before serving (`checkRegistryLinks`). Default `true`                                                                                                 |
| `swagger`    | `true` (default), `false`, or `{routePrefix, title, version, description}`. Needs the optional peers `@fastify/swagger`, `@fastify/swagger-ui`, `fastify-type-provider-zod`                                                         |
| `context`    | `(request) => ctx`, sync or async: who is asking. Handed to every action, the dispatcher's `rowScope` / `access` and every source method; throw a `UdcError` to refuse. See [Request context and scope](#request-context-and-scope) |

`createDispatcher(registry, options)` takes, beside `log`:

| Option            | What                                                                                                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rowScope`        | `(ctx, collection) => FilterNode \| undefined`: the row filter a request is held to on a collection; `undefined` is no limit                                                 |
| `access`          | `(ctx, {action, collection}) => boolean \| undefined`: `false` hides the collection, `true` lets a scoped request run `schema.*` and `source.read` on it                     |
| `showScopeFields` | collection names whose scope fields stay visible (shown, filterable, sortable); by default a scope's fields are hidden from the client                                       |
| `mutateManyLimit` | the most rows one `mutate_many` request may touch; more is a `validation_error`, nothing written. Default 10 000. See [`mutate_many`](#mutate_many-many-rows-in-one-request) |

The plugin keeps its validator, serializer and error handler inside its own
Fastify context, so the host's other routes are not affected. A `prefix` given
to `app.register` moves every route under it.

## A collection directory

```
collections/
  books/
    view.yaml      how the collection is shown: renderers, columns, search, filters
    schema.json    the fields: the first schema revision of a Postgres collection
    source.yaml    where the rows live; without it, a Postgres table named like the directory
    seed.json      rows for seedCollection (or a memory source)
    README.md      served in describe.docs (README.<locale>.md for other languages)
```

```yaml
# view.yaml
default_renderer: table
available_renderers: [table, cards]
page_size_default: 50
columns:
  - { field: title, editable: true }
  - { field: pages, editable: true, align: right }
search:
  fields: [title]
```

```json
{
  "version": "v1",
  "fields": {
    "title": { "type": "string", "required": true, "index": true },
    "pages": { "type": "integer", "min": 0, "index": true }
  }
}
```

A directory name is the collection name (`[a-z][a-z0-9_]*`). The documents'
full dialect is defined by `@jsudc/core` (`ViewConfigSchema`,
`SchemaDocSchema`, `SourceConfigSchema`).

A view's `default_sort` (`- { field: received_at, dir: desc }`) is the order
`@jsudc/react` asks for while the user has picked none, shown in the headers.
The server checks its field names when it loads the registry
(`viewDefaultSortProblems`) and refuses a view that names a field the schema
lacks. A `postgres_table` source can also order a sortless `list` itself with
its `defaultSort` option; that order reaches any client, but no UI shows it as
a sort.

## The seven sources

`source.yaml` picks one with `kind`. The two Postgres kinds are made by
`makeSource` of `@jsudc/server/postgres` (which makes the other five too) and
need `pg`; the root entry's `makeSource` makes the other five (`sqlite_table`
over a database the host opened and passed in `SourceDeps.sqlite`):

| `kind`                     | Rows                                                                                                | Writes                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `postgres_jsonb` (default) | a table, every field in `data jsonb`; `options.table` overrides the name                            | mutate, schema edits, reindex, reparent     |
| `postgres_table`           | an ordinary relational table with typed columns (see [below](#postgres_table-a-relational-table))   | mutate, reindex (plain columns)             |
| `sqlite_table`             | one table of a SQLite file, typed columns (see [below](#sqlite_table-a-table-of-a-sqlite-file))     | mutate, reindex (plain columns)             |
| `memory`                   | `seed.json`, kept in the process                                                                    | mutate, reindex, reparent (lost on restart) |
| `filesystem`               | the entries of one folder under `options.root` (relative to the collection directory, no `..`)      | read-only                                   |
| `http_api`                 | one upstream call (`base_url`, `list_endpoint`, `field_map`, …) cached for `cache_ttl_ms`           | read-only                                   |
| `yaml_menu`                | a YAML tree (`options.file`) flattened into rows; `udc:collections` branches list the live registry | read-only                                   |

```yaml
# source.yaml of an http_api collection
kind: http_api
options:
  base_url: https://api.github.com
  list_endpoint: /users/digital-cube/repos?per_page=100
  id_field: name
  headers:
    Authorization: Bearer ${GITHUB_TOKEN} # dropped whole when the variable is unset
  field_map:
    owner_avatar: owner.avatar_url
  cache_ttl_ms: 300000
```

The library reads **no environment of its own**. What `makeSource` gets as
`env` is where `${VAR}` headers, OAuth2 credentials and these overrides are
looked up:

| Variable                  | Effect                                                                           |
| ------------------------- | -------------------------------------------------------------------------------- |
| `UDC_HTTP_SOURCES=off`    | no http_api collection is served                                                 |
| `UDC_HTTP_FIXTURES=<dir>` | every http_api collection reads `<dir>/<name>.json` (or `.1.json`, `.2.json`, …) |
| `UDC_<NAME>_CACHE_TTL_MS` | overrides one http_api collection's cache TTLs                                   |
| `UDC_<NAME>_ROOT`         | moves one filesystem collection's root                                           |

Pass `env: process.env` to honour them, a subset to choose, or nothing to turn
them off. Paths (the collections directory, a fixture directory) are always
arguments.

### `postgres_table`: a relational table

A collection can be served from a table you already have, with typed columns,
or from a `FROM` with joins. Filters (all 14 operators), sort, the keyset cursor
and offset paging behave as on `postgres_jsonb`: it is the same compiler (see
[The SQL compiler](#the-sql-compiler)), resolving each field to a column instead
of `data->>'field'`. Number, date, datetime and bool columns are compared as
their own type (an integer column against a `numeric` parameter, so `2.5` never
rounds); text is compared and sorted by code point (`COLLATE "C"`), so the
results agree with `evaluateFilter`. The schema is the collection's
`schema.json` (no revisions, no schema edits, no tree reparent).
It writes its plain columns (see [Writing](#writing-a-postgres_table)). A NULL column is left out of the row, as a field
missing from `data` is (`keepNulls: true` serves `null`).

From `source.yaml`, only identifiers (lowercase snake_case, the table-name
rule): the table, the id and version columns, field → column names and
`total_count`.

```yaml
kind: postgres_table
options:
  table: message # default: the collection name
  id_column: id # default: id
  id_type: uuid # uuid (default) | text | integer — the cursor and read follow it
  version_column: row_version # __meta.version; without it every row is version 1
  columns:
    subject: subject_line # a field without an entry reads the column of its own name
  total_count: false # no count(*) next to the page; total is null
```

In code, register a `PostgresTableSource` yourself; it is the only way to give
SQL: a `from` with joins, a field as an expression, a base `where`. That SQL is
yours, written in code, never taken from a request.

Worked example: a `message` table with typed columns and UUID ids, an
`attachment` link table, and the attachment count as a computed field.

```sql
CREATE TABLE message (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant text NOT NULL,
  subject text NOT NULL,
  received_at timestamptz NOT NULL,
  unread boolean NOT NULL DEFAULT true,
  labels text[],
  row_version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz
);
CREATE TABLE attachment (id serial PRIMARY KEY, message_id uuid REFERENCES message, name text);
```

```ts
import { PostgresTableSource } from "@jsudc/server/postgres";

registry.register({
  name: "messages",
  view: asset.view,
  source: new PostgresTableSource({
    db,
    schema: asset.schema, // schema.json: tenant, subject, received_at, unread, labels, attachment_count
    from: `message m
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS n FROM attachment a WHERE a.message_id = m.id
      ) ac ON true`,
    idColumn: "m.id", // idType: "uuid" is the default
    versionColumn: "m.row_version",
    where: "m.deleted_at IS NULL", // ANDed into every statement
    fields: {
      tenant: "m.tenant",
      subject: "m.subject",
      received_at: "m.received_at",
      unread: "m.unread",
      labels: "m.labels", // string_array over text[] (array: "jsonb" for a jsonb column)
      attachment_count: { sql: "ac.n" }, // computed: read, never written
    },
    totalCount: false, // a large mailbox: no count(*), total is null
  }),
});
```

`attachment_count` lists, sorts and filters (`gte 1`) like a column, because it
has one value per row (a column of a `LATERAL` join, or a correlated subquery
in `sql`). An aggregate over a grouped `FROM` would not be valid in a `WHERE`:
mark such a field `{ sql: …, filterable: false, sortable: false }`. A field
with `filterable: false` is refused in a filter exactly like an unknown field
and left out of `describe.filterable`; `sortable: false` refuses it in a sort
and leaves it out of `describe.sortable` (0.6.0), so `@jsudc/react` draws its
header as plain text instead of a sort button. A host source of its own says
the same with `Source.notSortable`.
The host's row scope may still use it.

| Option                     | What                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| `schema`                   | the collection's `schema.json`, parsed                                                              |
| `table` / `from`           | exactly one: a table (`message`, `inbox.message`) or a `FROM` clause in SQL                         |
| `fields`                   | field → column name, or `{ column \| sql, computed?, readOnly?, filterable?, sortable?, array? }`   |
| `idColumn`, `idType`       | the row id (`id`, `uuid`); `text` and `integer` ids page by cursor too                              |
| `versionColumn`            | an integer column for `__meta.version`, bumped by every update; without it `1`, no locking          |
| `writeTable`, `writeAlias` | where a `from` with joins writes (`inbox.message`, its alias `m`); without it a `from` is read-only |
| `readOnly`                 | `true`: no writes at all (`capabilities.mutate: false`)                                             |
| `onMutate`                 | a host's own write in the same transaction (see [`onMutate`](#onmutate-a-hosts-own-write))          |
| `where`                    | SQL ANDed into every statement (a soft delete, a fixed partition)                                   |
| `totalCount`               | `false`: no `count(*)`, `total: null`, `capabilities.total_count: false` (default `true`)           |
| `keepNulls`                | serve a NULL column as `null` instead of leaving it out                                             |
| `pageSizeDefault`          | the page size without a `limit`                                                                     |
| `defaultSort`              | the order of a `list` without a `sort` (`[{ field, dir }]`); a ranked search still comes by rank    |

Every field of the schema must resolve: a field without an entry in `fields`
reads the column of its own name. The row scope of a request (see
[Request context and scope](#request-context-and-scope)) is compiled into the
`WHERE` of `list` and `read`, next to the base `where` and the client filter
(`enforcesRowScope`). A datetime is served in Postgres' ISO 8601 form
(`2024-01-10T08:00:00+00:00`).

#### Writing a `postgres_table`

`mutate` inserts, updates (a partial patch) and deletes rows of the source's
`table`, so `capabilities.mutate` is `true`. A source over a `from` with joins
writes only when it also names the table its rows live in, `writeTable`
(and `writeAlias`, its alias in the `from`, when it has one); without it
`capabilities.mutate` stays `false` and `mutate` answers `unsupported_op`.
`readOnly: true` turns writing off for a `table` too. A `source.yaml` table is
writable; to serve it read-only, register it in code with `readOnly: true`.

- **Only plain mapped columns are written.** A computed field (`sql`), a
  column marked `readOnly: true` (a creation time, a column a trigger keeps)
  and, under a `from`, a column of any other table than `writeTable` are
  read-only (`source.readOnlyFields`). An insert or a patch that names one is
  refused with `validation_error`, `details.problems` naming it
  (`{field: "created_at", message: "is read-only"}`), next to any other
  problem. The rest is validated against the schema as on `postgres_jsonb`
  (an insert is not asked for a required field that is read-only). The id
  comes from the column's default (`gen_random_uuid()`, a sequence), or from a
  mapped field that is the id column.
- **With a `versionColumn`**: an insert writes `1`, every update increments
  it (an empty patch too), and `expected_version` is checked inside the
  transaction, with the row locked, so of two concurrent edits of one version
  exactly one wins; the other gets `version_conflict` with
  `details.current_version`. **Without one** every row is version `1`, and an
  `expected_version` is accepted and not checked: such a collection has **no
  optimistic locking**, the last write wins. (The React inline editor always
  sends `expected_version`; refusing it would make the table read-only in the
  UI.)
- **The row scope** (see [Request context and scope](#request-context-and-scope))
  is part of the statement's `WHERE` for update and delete: a row outside it
  is `not_found`, exactly like a missing id, also with an `expected_version`.
  An insert gets the scope's `eq` values written over whatever the client
  sent. The written row is read back through the `from`: one that falls
  outside the scope or the base `where` is `forbidden`
  (`reason: "out_of_scope"`) and rolled back.
- Every write is one transaction: lock the row (`SELECT … FOR UPDATE` on
  `writeTable`), read it as it is, check the version, write, read the row back
  through the `from` (so the answer carries the computed and joined fields as
  they are now), run `onMutate`. A constraint the database refuses (a foreign
  key) rolls it back and is answered `internal`.
- **`reindex`** (`capabilities.reindex` when the source writes), so a kanban
  board over a relational table survives running out of order values: the
  rows of the request's `scope`, inside the base `where` and the row scope,
  are renumbered `gap`, `2*gap`, … in their current order (NULLs last, ties by
  id), each version bumped, in one transaction. The rows are locked in
  `writeTable` first (id order, as `mutate_many`), so a concurrent edit of one
  is waited for and numbered as committed. The order field and every scope
  field must be writable columns of the write table: a computed field, a
  `readOnly` column, a column of another table of the `from` or the id is
  `validation_error`. The statement is the one `sqlite_table` runs
  (`reindexUpdate`); like there, `onMutate` is not called for the renumbered
  rows, and the change feed gets their ids.

The `message` example above, writable: the `from` names the table its rows
live in, `attachment_count` is computed and `received_at` is kept by the
mail import, not by a request.

```ts
new PostgresTableSource({
  db,
  schema: asset.schema,
  from: `message m LEFT JOIN LATERAL (
    SELECT count(*)::int AS n FROM attachment a WHERE a.message_id = m.id
  ) ac ON true`,
  writeTable: "message", // insert, update and delete go here
  writeAlias: "m", // the columns `m.*` are written, any other is read-only
  idColumn: "m.id",
  versionColumn: "m.row_version",
  where: "m.deleted_at IS NULL",
  fields: {
    tenant: "m.tenant",
    subject: "m.subject",
    received_at: { column: "m.received_at", readOnly: true },
    unread: "m.unread",
    labels: "m.labels",
    attachment_count: { sql: "ac.n" },
  },
});
// mutate {op: "update", id, row: {unread: false}, expected_version: 4}
//   → the row at version 5, attachment_count as it is now
// mutate {op: "update", id, row: {attachment_count: 0}}
//   → validation_error, problems: [{field: "attachment_count", message: "is read-only"}]
```

### `sqlite_table`: a table of a SQLite file

The SQLite counterpart of `postgres_table`: one table, typed columns, the same
filter operators, sort, keyset and offset paging (the compiler's SQLite
dialect), `read`, `mutate` (insert, partial update, delete) and
`mutate_many`, with the row scope inside every statement. `SqliteTableSource`
takes the options of `PostgresTableSourceOptions` that carry over — `schema`,
`table`, `fields` (`column`, `sql`, `computed`, `readOnly`, `filterable`,
`sortable`), `idColumn`, `idType`, `versionColumn`, `readOnly`, `onMutate`,
`where`, `search`, `totalCount`, `keepNulls`, `pageSizeDefault`,
`defaultSort` — and a `db`. There is no `from` with joins (a computed field
can still be a correlated subquery) and no tree reparent: `capabilities` says
so. `search` answers the search box with FTS5 (see
[On `sqlite_table`: FTS5](#on-sqlite_table-fts5)).
`reindex` is there (`capabilities.reindex` when the source writes), so a
kanban board over a SQLite table can always be reordered.

**One `SqliteDatabase` per file.** A SQLite handle is one connection: a
statement the host ran on it while the source awaited inside a transaction
would land inside that transaction. So the host opens each file once, as a
`SqliteDatabase`, registers it under a name, and runs its own SQL through the
same object:

```ts
import { buildApp, createDispatcher, loadRegistry, makeSource } from "@jsudc/server";
import { openNodeSqlite } from "@jsudc/server/sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";

// One write connection behind an in-process queue, one read-only read connection, WAL.
const vault = openNodeSqlite("/var/lib/app/vault.db", { name: "vault", busyTimeoutMs: 5000 });
const orm = drizzle(vault.proxy); // the host's own Drizzle shares it

const registry = loadRegistry("./collections", (asset, reg) =>
  makeSource(asset, { registry: reg, sqlite: { vault } }),
);
const dispatcher = createDispatcher(registry, {
  rowScope: (ctx) => ({ field: "owner", op: "eq", value: ctx.user }),
});
const app = await buildApp({ dispatcher, registry, context: (req) => ({ user: userOf(req) }) });
```

```yaml
# collections/notes/source.yaml
kind: sqlite_table
options:
  database: vault # the name in SourceDeps.sqlite; default main
  table: note # default: the collection name
  id_type: uuid # uuid (default) | text | integer
  version_column: version
  columns: { body: body_text }
```

- `transaction(fn)` waits for the queue, then takes the file's write lock with
  `BEGIN IMMEDIATE`, commits when `fn` resolves and rolls back when it throws.
  Code running inside `fn` — awaited or not, through the object or its
  `proxy` — runs in that transaction (a nested `transaction` is a
  `SAVEPOINT`); code anywhere else waits. So a source's `mutate` called inside
  a host's transaction is part of it, and a host write made while the
  source's transaction is open (from a hook of the host) rolls back with it.
- Other processes open the file too (a customer's tool, `sqlite3`, a backup).
  The lock is waited for without blocking the event loop: `BEGIN IMMEDIATE`
  is retried until `busyTimeoutMs` (default 5000) has passed, the in-process
  queue counting towards it; then the answer is the protocol error **`busy`**
  (`details: { database, waited_ms }`, nothing written, retry later). Reads go
  to the read connection and never wait for a writer (WAL). Nothing about rows
  is cached between requests.
- Their writes reach the change feed only with **`watch`** (off by default):
  `openNodeSqlite(path, { watch: true })` polls the file's `data_version`
  every second (`{ watch: { intervalMs } }` for another interval), and the
  streams of every collection served from the file are told that it changed —
  see [Writes by other processes to a SQLite file](#writes-by-other-processes-to-a-sqlite-file).
- `:memory:` has a single connection; reads then take their turn in the queue.
- **`better-sqlite3`** instead of `node:sqlite`: `openBetterSqlite(path,
  opts)` from `@jsudc/server/better-sqlite3` opens the file the same way (a
  write and a read-only read connection, WAL, the same options, `setup` and
  `unicodeLower` included) and returns the same `SqliteDatabase`.
  `better-sqlite3` is an optional peer (`npm install better-sqlite3`): only
  that entry loads it, on the first `openBetterSqlite`, and says so when it
  is missing. `betterSqliteConnection(db)` adapts a `Database` you opened
  yourself.
- Other drivers: implement `SqliteConnection` (`all`, `values`, `run`,
  `exec`, `close`) and pass it to `new SqliteDatabase({ write, read })`.

**Storage.** Per field type, as `sqliteColumnResolver` expects: `integer` and
`year` INTEGER, `decimal` NUMERIC, `bool` INTEGER 0/1, `date` TEXT
`YYYY-MM-DD`, `datetime` TEXT in `sqliteDateTime`'s UTC form
(`2021-05-31T22:00:00.000Z`), `string_array`, `lookup_array` and `json` TEXT
holding JSON, the rest TEXT. Rows are served in the wire protocol's JSON
types: numbers, booleans from 0/1, arrays and objects parsed, datetimes in the
ISO form. A datetime another program wrote as `2021-06-01 10:00:00` is served
as `2021-06-01T10:00:00.000Z`, but filters and sorts compare the stored text,
so other writers should store the canonical form.

**Copying the file while it is open** (a backup, a vault copied to another
machine). In WAL mode the committed rows are in the main file _and_ in
`-wal`; a copy of the main file alone misses the latter. Fold the WAL in
first with `checkpoint()`, then copy:

```ts
import { cp } from "node:fs/promises";

const { busy } = await vault.checkpoint(); // TRUNCATE: -wal is 0 bytes afterwards
if (busy) throw new Error("a reader is still on the WAL; try again"); // after busyTimeoutMs
await cp("/var/lib/app/vault.db", "/backup/vault.db");
```

`checkpoint(mode = "TRUNCATE")` takes its turn in the write queue like a
write (so no transaction of this process is half-way through) and runs
`PRAGMA wal_checkpoint(<mode>)` on the write connection **outside** a
transaction — `exec("PRAGMA wal_checkpoint(TRUNCATE)")` cannot: `exec` runs
in a write transaction, where SQLite refuses a checkpoint ("database table is
locked"). The answer is `{ busy, log, checkpointed }` as SQLite reports it
(`log` and `checkpointed` are -1 when the file is not in WAL mode). While a
reader of another process is on the WAL, it is retried until `busyTimeoutMs`
and then answered with `busy: true`; waiting for the queue that long is the
protocol error `busy`, as for a write. `PASSIVE` never waits and never
truncates. Refused inside a transaction of the same database. Writes that
arrive after the checkpoint can land in `-wal` again before the copy is done:
stop writing first if the copy has to be exact (or use SQLite's backup API,
`VACUUM INTO`, on a connection of your own). `close()` checkpoints too and
removes `-wal` and `-shm`.

**Ids.** `uuid` (the default) is a TEXT column holding the canonical
lower-case 36-character form: the source assigns `crypto.randomUUID()` on an
insert that carries none, checks the shape of one given through a field mapped
to the id column, and lower-cases every id on the way in (a read, an update,
a cursor), so it behaves like Postgres `uuid`. `integer` is an `INTEGER
PRIMARY KEY` (assigned by SQLite), `text` the column's own value. Keep the
table's `rowid` (no `WITHOUT ROWID`).

**The version column.** Written 1 on insert, `version + 1` by every update
the source makes, and `expected_version` checked inside the `UPDATE` /
`DELETE` statement itself (next to the id, the base `where` and the row
scope). For writers that do not bump it, install the trigger
`sqliteVersionTriggerSql({ table, versionColumn })` returns: it adds 1 after an
`UPDATE` that left the version unchanged, and stays quiet for one that changed
it. That is the one supported arrangement — **the source bumps, the trigger
covers everyone else** — and it never bumps twice:

```sql
CREATE TRIGGER IF NOT EXISTS "note_version_bump" AFTER UPDATE ON "note"
FOR EACH ROW WHEN NEW."version" IS OLD."version"
BEGIN
  UPDATE "note" SET "version" = coalesce(OLD."version", 0) + 1 WHERE rowid = NEW.rowid;
END;
```

**Row scope.** `enforcesRowScope` is `true`: the scope is in the `WHERE` of
every `SELECT`, `UPDATE` and `DELETE`; its `eq` pins are written over an
insert or a patch; the written row is read back, and a row that left the scope
(or the base `where`) rolls the whole transaction back with `forbidden`
(`reason: out_of_scope`).

**Reindex.** One `BEGIN IMMEDIATE` transaction and one `UPDATE … FROM`: the
rows of the request's `scope` (ANDed with the base `where` and the row scope)
are numbered by their current order — NULLs last, ties by id — and get
`gap`, `2*gap`, … with their version bumped. The `order_field` and every
`scope` field must be writable columns of the table (not `readOnly`, not
computed, the order field not the id), else `validation_error`; the order
column should be INTEGER (or NUMERIC for a `decimal` order), so it sorts as
a number. With a change feed, the notice names the renumbered rows (the
source hands them to `changedRows`), so only the streams that see them hear
of it.

**`mutate_many`** (see [`mutate_many`](#mutate_many-many-rows-in-one-request))
runs in one `BEGIN IMMEDIATE` transaction: the file's write lock is held from
the first statement to `COMMIT`, so the rows read are the rows written. The
patch is validated first (read-only and computed fields refused as in
`mutate`, and the id column: `mutate_many` does not change ids); the target
rows (the ids, or the filter minus `except_ids`, inside the base `where` and
the row scope, at most `limit + 1`) are read in id order. Without `onMutate`
one `UPDATE` / `DELETE` writes them all and bumps each version; with it, row
by row, each read back in scope and handed to the hook. A row leaving the
scope, or a hook failure, rolls the whole request back. The rows as they were
and as they are go to `changedRows`, so the change feed names them.

**`onMutate(ctx, change, tx)`** is the hook of the Postgres sources (see
[`onMutate`](#onmutate-a-hosts-own-write)), typed `SqliteOnMutateHook`: the
same `RowChange`, called after the source's statement and before `COMMIT` on
every `mutate` and on every row of a `mutate_many`; a throw rolls everything
back (a `UdcError` as it is, anything else `internal`); a returned row is the
answer. `tx` is a `SqliteExecutor` on the write connection, inside the
transaction (`tx.run`, `tx.get`, `tx.all`, synchronous); SQL the hook awaits
through the same `SqliteDatabase` (`run`, `transaction` — a `SAVEPOINT` —, or
Drizzle on its `proxy`) is in the transaction too. The drivers are
synchronous but the hook may be async: the wrapper issues `BEGIN IMMEDIATE`
and `COMMIT` itself and keeps its write queue held while the hook awaits.

> **A slow hook holds every other writer of that file — in this process and
> in others.** SQLite has one writer per file, and the hook runs while the
> source holds it: every other write to the file (another request's
> `mutate`, a host's own SQL, another process, the `sqlite3` shell) waits
> until `COMMIT`, and is answered `busy` once it has waited
> `busyTimeoutMs`. Reads do not wait on a file (WAL; they see the committed
> rows, never the hook's uncommitted ones); on `:memory:` they take their
> turn in the queue. Bound the hook's external call well under
> `busyTimeoutMs`, and do slow work after the response.

```ts
import { type SqliteOnMutateHook, SqliteTableSource } from "@jsudc/server/sqlite";

const audit: SqliteOnMutateHook<{ user: string }> = (ctx, change, tx) => {
  tx.run({
    sql: "INSERT INTO audit (user, op, row_id) VALUES (?, ?, ?)",
    params: [ctx.user, change.op, change.id],
  });
};
const notes = new SqliteTableSource({ db: vault, schema, table: "note", onMutate: audit });
```

## Several databases, several instances

**One vault, several SQLite files.** Each `sqlite_table` collection names its
file in `source.yaml` (`database: boards`, `database: tickets`), and the host
opens each file once and registers it under that name:

```ts
const boards = openNodeSqlite("/data/vault/boards.db", { name: "boards" });
const tickets = openNodeSqlite("/data/vault/tickets.db", { name: "tickets" });
const registry = loadRegistry("./collections", (asset, reg) =>
  makeSource(asset, { registry: reg, sqlite: { boards, tickets } }),
);
```

A lookup or a `row_link` from a collection in one file to a collection in
another needs nothing more: `checkRegistryLinks` compares schemas, not
files; the client fetches a lookup's labels with an ordinary `list` on the
target (`lookupKeysFilter`), and a `row_link` opens the target with an `eq`
condition, so neither is a join. Filtering and sorting by the lookup key
work as on any column. Every file has its own write queue and lock: a write
to a collection in `tickets.db` opens no transaction in `boards.db`, so a
`transaction` that spans both files does not exist (each file commits on
its own). Joins across files (`ATTACH`) are not supported.

**One process, several vaults.** Register `udcPlugin` once per vault, each
under its own prefix and with its own registry, dispatcher (`context`,
`rowScope`, `access`), change feed and SQLite handles. The plugin keeps no
module-level state: each registration has its own routes, error handler,
`/healthz`, `GET /udc/changes` and Swagger (`/vault-a/docs` documents
`/vault-a/udc/*` only; give each a `title`).

```ts
const app = Fastify();
for (const vault of vaults) {
  await app.register(
    async (scope) => {
      // A closed vault is gone: every route under its prefix answers 404.
      scope.addHook("onRequest", async (_req, reply) => {
        if (vault.closed) {
          return reply.code(404).send({ code: "not_found", message: "no such vault" });
        }
      });
      await scope.register(udcPlugin, {
        dispatcher: vault.dispatcher, // createDispatcher(vault.registry, { rowScope, changes: vault.changes })
        registry: vault.registry,
        context: (req) => vault.contextOf(req),
        swagger: { title: `vault ${vault.name}` },
      });
    },
    { prefix: `/${vault.name}` },
  );
}
```

**Closing one vault** while the others keep serving. Fastify cannot remove
routes from a running server, so the host stops routing to the vault, then
closes what the vault owns:

```ts
vault.closed = true; // the onRequest guard above: new requests answer 404
await vault.changes.close(); // ends this feed's open streams; the clients' reconnect gets 404
for (const db of vault.databases) db.close(); // SqliteDatabase.close(): both connections
```

`ChangeFeed.close()` ends every stream subscribed to that feed and refuses
new ones (`GET /udc/changes` answers 404 for a closed feed, and the client
stops reconnecting), leaving every other vault's feed and streams alone.
Close the SQLite handles last: a statement on a closed `SqliteDatabase`
throws. Routing by host name instead of prefix is the host's own work
(Fastify's `constraints: { host }`, or a proxy).

## The SQL compiler

The compiler behind both Postgres sources is exported, so a host that writes a
source of its own over SQL does not re-implement the filter DSL. A
`FieldResolver` says where each allowlisted field lives; the compiler does the
rest (the allowlist, typed parameters, three-valued logic, NULLS LAST, the
keyset predicate):

```ts
import {
  codePointOrder,
  compileFilter,
  compileSort,
  cursorPredicate,
  decodeCursor,
  encodeCursor,
  type FieldResolver,
  orderBy,
  sortKeyColumns,
} from "@jsudc/server";
import { sql } from "drizzle-orm";

const col = (field: string) => sql`${sql.identifier(`c_${field}`)}`;
const resolve: FieldResolver = {
  text: (field) => sql`(${col(field)}::text)`, // contains / starts_with / is_null
  typed: (
    field,
    _def,
    cast, // comparisons, ORDER BY, the cursor
  ) => (cast === "text" ? codePointOrder(sql`${col(field)}::text`) : sql`(${col(field)})`),
  array: (field) => ({ expr: col(field), form: "text[]" }), // string_array, lookup_array
  id: sql`pk`,
  idType: "integer",
};

const terms = compileSort(req.sort, schema, resolve); // refuses an unknown field
const after = req.page?.cursor ? decodeCursor(req.page.cursor, terms.length, "integer") : null;
let where = compileFilter(req.filter, schema, resolve); // a validation_error before any SQL runs
if (after) where = sql`${where} AND ${cursorPredicate(terms, after.values, after.id, resolve)}`;
const rows = await db.execute(sql`
  SELECT pk${terms.length ? sql`, ${sortKeyColumns(terms)}` : sql``} FROM people
  WHERE ${where} ORDER BY ${orderBy(terms, resolve)} LIMIT ${limit + 1}`);
// next cursor: encodeCursor([...terms.map((_, i) => last[`__k${i}`] ?? null), String(last.pk)])
```

| Export                                                                                             | What                                                                                     |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `compileFilter(node, schema, resolve?)`                                                            | a filter tree as a `WHERE` expression; unknown fields and wrong values refused           |
| `compileSort(sort, schema, resolve?)`                                                              | the sort keys as `SortTerm`s (typed expression and cursor cast)                          |
| `orderBy(terms, resolve?)`                                                                         | `ORDER BY` the keys, NULLS LAST, then the row id ascending                               |
| `sortKeyColumns(terms, resolve?)`                                                                  | the sort values as text (`__k0`, `__k1`, …), selected to build the next cursor           |
| `cursorPredicate(terms, values, id, resolve?)`                                                     | the rows strictly after a cursor position                                                |
| `encodeCursor(parts)`, `decodeCursor(c, keys, idType?)`                                            | the cursor codec (base64url JSON, as udc-py); the id is checked against `idType`         |
| `escapeLike(text)`                                                                                 | a LIKE pattern that matches literally                                                    |
| `FieldResolver`, `SqlCast`, `SqlIdType`, `SqlArrayForm`, `sqlCastFor`, `codePointOrder`, `idParam` | the resolver contract and its helpers                                                    |
| `jsonbResolver` (`/postgres`)                                                                      | `postgres_jsonb`'s resolver (`data->>'f'`, a uuid `id`); the default of every `resolve?` |
| `columnResolver({ fields, id, idType, arrayForms })` (`/postgres`)                                 | the resolver over typed columns that `PostgresTableSource` uses                          |
| `SqlDialect`, `postgresDialect`, `sqliteDialect`, `dialectOf(resolve)`                             | the SQL text that differs between databases (below)                                      |
| `sqliteColumnResolver({ fields, id, idType })`, `sqliteQuery(sql)`, `sqliteDateTime(s)`            | a resolver over a SQLite table, the renderer to `?` + params, the stored datetime form   |

### Postgres or SQLite

The compiler is one implementation; a `SqlDialect` spells the pieces that
differ, and the resolver carries it (`dialect`, `postgresDialect` when
absent, so every resolver above compiles exactly as before). `orderBy`,
`sortKeyColumns` and `cursorPredicate` take the resolver; `idParam` and
`codePointOrder` take a dialect as their last argument.

```ts
import { DatabaseSync } from "node:sqlite";
import { compileFilter, sqliteColumnResolver, sqliteQuery } from "@jsudc/server";
import { sql } from "drizzle-orm";

const db = new DatabaseSync("app.db");
const resolve = sqliteColumnResolver({
  fields: { name: sql`name`, n: sql`n`, ok: sql`ok`, at: sql`at`, tags: sql`tags` },
  id: sql`id`, // INTEGER PRIMARY KEY; idType "integer" is the default
});
const q = sqliteQuery(sql`SELECT * FROM people WHERE ${compileFilter(filter, schema, resolve)}`);
const rows = db.prepare(q.sql).all(...q.params);
```

| Postgres (`postgresDialect`)               | SQLite (`sqliteDialect`)                                              |
| ------------------------------------------ | --------------------------------------------------------------------- |
| `$1::numeric`, `$1::date`, …               | `?`, the value converted in JS: booleans 1/0, datetimes to UTC text   |
| `x COLLATE "C"`                            | `x COLLATE BINARY` (code point order for UTF-8)                       |
| `x LIKE $1` / `x ILIKE $1`                 | `x GLOB ?` / `lower(x) LIKE lower(?) ESCAPE '\'`                      |
| `x = ANY($1::text[])`, `x <> ALL(…)`       | `x IN (SELECT value FROM json_each(?))`, `NOT IN`, one JSON parameter |
| `unnest(col)`, `jsonb_array_elements_text` | `json_each(col)`: an array field is a JSON array in a TEXT column     |
| `(x)::text AS "__k0"`, `(id::text)`        | `CAST(x AS TEXT)`, `CAST(id AS TEXT)`                                 |

What a SQLite table holds, per field type: `integer`/`year` INTEGER, `decimal`
NUMERIC (a REAL column keeps `-3` as `-3.0`, whose text is not `-3`), `bool`
INTEGER 0/1, `date` TEXT `YYYY-MM-DD`, `datetime` TEXT in
`sqliteDateTime`'s form (UTC, milliseconds, fixed width:
`2021-05-31T22:00:00.000Z`, so text order is time order; a filter value in
another offset is normalised the same way before it is bound), arrays and
`json` TEXT holding JSON, a missing value SQL NULL. Needs SQLite 3.38 or
newer (JSON built in); `node:sqlite` in Node 24 ships 3.5x.

Two things to know:

- **Case folding is SQL `lower()`**, and SQLite's built-in one folds ASCII
  only: a case-insensitive `contains "čak"` misses `ČAK`, which
  `evaluateFilter` finds. Load ICU, or register a Unicode `lower` on the
  connection: `db.function("lower", { deterministic: true }, (s) => s == null ? null : String(s).toLowerCase())`.
- **Text order is code point order** in both dialects. JavaScript's `<`
  compares UTF-16 code units, so a character above U+FFFF (an emoji) sorts
  before U+E000–U+FFFF (`！`) in `evaluateFilter` and after it in SQL — in
  Postgres's `COLLATE "C"` and SQLite's `BINARY` alike. Nothing else differs.

## The SQL the host must run

Only a `postgres_jsonb` collection needs the library's SQL. A `postgres_table`
collection uses none of the three migrations: it serves its `schema.json`
(no revisions), its resolver casts the table's own typed columns (no
`udc_date` / `udc_timestamptz`) and it builds no expression index. A host
with only `postgres_table`, `memory`, `filesystem`, `http_api` or `yaml_menu`
collections runs nothing below. Everything in this section is imported from
`@jsudc/server/postgres`.

The library owns two kinds of database objects; your collection tables are
yours.

**Library objects**: the table `udc_schema_revisions` (every schema revision of
every Postgres collection, at most one active) and the functions `udc_date(text)`
and `udc_timestamptz(text)` (the immutable casts that filters, sorts and the
expression indexes use). Two ways to get them, both idempotent:

- `await ensureUdcSchema(db)` at start-up: runs the files below in one
  transaction under an advisory lock (`CREATE TABLE IF NOT EXISTS`,
  `CREATE OR REPLACE FUNCTION`). For a host without migrations.
- copy [`migrations/*.sql`](migrations) (plain SQL, numbered, also in the
  installed package: `UDC_MIGRATIONS_DIR`) into your own drizzle / knex /
  flyway tree and apply them with the rest.

Text fields compare and sort by code point (`COLLATE "C"`), as `evaluateFilter`
does in the browser, whatever collation the database was created with. Migration
`0002` rebuilds a text field index an earlier version made on the bare expression.

**Collection tables**: one per `postgres_jsonb` collection, all of the same
shape. With drizzle, declare them through `collectionTable` and generate your
migrations as usual; keep `udcSchemaRevisions` in the same schema file so
drizzle-kit does not try to drop it:

```ts
import { collectionTable } from "@jsudc/server/postgres";
export { udcSchemaRevisions } from "@jsudc/server/postgres";
export const books = collectionTable("books");
```

Without drizzle, `createCollectionTableSql("books")` is the same table as a
`CREATE TABLE IF NOT EXISTS` statement.

Then seed it (optional): `seedCollection(db, {table: "books", schema:
asset.schemaJson, rows})` writes `schema.json` as active revision 1, creates the
field indexes and inserts the rows; `reset: true` truncates first.

## Lookups and drill-down

A `lookup` field stores the key of a row of another collection, a
`lookup_array` a list of keys (see `@jsudc/core`'s README for the field
definition). Level 1 adds no JOIN: the server keeps the key in `data` as it
came (a string or an integer), and sorts and filters on the key.

- **Filter ops.** `eq neq in not_in is_null is_not_null` on a `lookup`; on a
  `lookup_array`, `in` (any key of the row is in the list), `not_in` (none is)
  and the null tests. Any other op is `unsupported_op`, and `describe`'s
  `filterable.fields[].ops` lists exactly these. Keys compare as text, so `7`
  and `"7"` are the same key.
- **Sort.** By the key, as text by code point (`"b-10"` before `"b-2"`); a
  `lookup` with `index: true` gets an expression index like a string.
- **The row id.** A condition on `id`, in a collection whose schema has no
  live `id` field, means the row id (the `id` column), with the ops above. That
  is how a client resolves a lookup keyed by id in one call:
  `{field: "id", op: "in", value: [...keys]}`. Every source does this, memory
  and Postgres alike.
- **Checks at start.** `loadRegistry` checks every lookup field and every
  view's `row_link` against the served collections' `schema.json`;
  `udcPlugin` (given `registry`) checks them again against the active schemas,
  since a revision may have dropped a field. The target must be served and
  have `label_field`, `key_field` and `extra_fields`; `row_link.filter.field`
  must exist in the linked collection, `value_from` must be `id` or a field of
  this one. Any problem stops the start, one line each:

  ```
  collections: lookups and row links do not fit
  tickets.board_id: lookup target boards has no field title
  boards.row_link: value_from colour is neither id nor a field of boards
  ```

- **Schema edits.** `schema.add_field` accepts `lookup` and `lookup_array`
  (the flat `ref` + `label_field` form too) and checks the target against its
  active schema first; `schema.update_field` checks the same. A target that
  does not fit is a `validation_error`. `relation` is still refused
  (`unsupported_op`): it is level 2.

`row_link` needs nothing on the server beyond that check: the client opens
the linked collection with an ordinary `eq` filter.

## Request context and scope

A host tells jsudc **who is asking** on every request, and holds each request
to a row filter per collection that no client can send, see or lift. jsudc
knows nothing of users, sessions or tenants: the host answers both questions.

- **`context`** (plugin option) turns the Fastify request into a value of your
  own, `ctx`. It runs once per `POST /udc/:action` and once per file preview.
  `Dispatcher.dispatch(msg, ctx?)` carries it to every handler — your own
  actions included: `dispatcher.register("whoami", schema, (payload, ctx) => …)`
  (a one-argument handler still works) — and, as `SourceContext`
  (`{ctx, collection, rowScope?}`), to every `Source` method as a trailing
  optional argument. A dispatcher driven without HTTP passes its own `ctx`.
- **`rowScope`** (dispatcher option) answers the filter (core's filter DSL)
  `ctx` is held to on a collection. It is called `rowScope`, not `scope`, so it
  cannot be confused with the `scope` of a `reindex` request (the kanban column
  to renumber). It is enforced in one generic layer around every source
  (`ScopedCollection`), a source of your own included, and additionally inside
  the SQL of `postgres_jsonb` (`enforcesRowScope: true`), where the check and
  the write are one statement.
- **`access`** (dispatcher option) hides a collection from a `ctx` (`false`),
  or lets a scoped `ctx` edit what every tenant shares (`true`).

### Worked example: a `message` collection per tenant and user

The tenant comes from the host name, the user from a session cookie; an
anonymous request is refused.

```ts
import { unauthenticatedError, UdcError, type FilterNode } from "@jsudc/core";
import { buildApp, createDispatcher } from "@jsudc/server";

interface Ctx {
  tenant: string;
  user: string;
  admin: boolean;
}

const dispatcher = createDispatcher<Ctx>(registry, {
  log: app.log,
  // One rule, stated once: a message belongs to a tenant and a user.
  rowScope: (ctx, collection) =>
    collection === "message"
      ? {
          and: [
            { field: "tenant", op: "eq", value: ctx.tenant },
            { field: "owner", op: "eq", value: ctx.user },
          ],
        }
      : undefined,
  // Only a tenant admin may add a field to `message` (it changes it for every tenant).
  access: (ctx, { action, collection }) =>
    collection === "audit_log" && !ctx.admin
      ? false
      : action.startsWith("schema.") && ctx.admin
        ? true
        : undefined,
});

await app.register(udcPlugin, {
  dispatcher,
  registry,
  context: async (request): Promise<Ctx> => {
    const tenant = request.hostname.split(".")[0]; // acme.example.com → acme
    const session = await sessions.get(request.cookies.sid); // your session store
    if (!session) throw unauthenticatedError(); // forbidden, details.reason "unauthenticated"
    if (session.tenant !== tenant) throw new UdcError("forbidden", "not a member of this tenant");
    return { tenant, user: session.user, admin: session.admin };
  },
});
```

An anonymous `POST /udc/list` is answered in-protocol, HTTP 200:

```json
{
  "kind": "udc.list.err",
  "id": "",
  "payload": {
    "code": "forbidden",
    "message": "not signed in",
    "details": { "reason": "unauthenticated" }
  }
}
```

(`isUnauthenticated(err)` of `@jsudc/core` tells it apart on the client; the
file preview route answers 401 for it and 403 for any other `UdcError`.
Anything else thrown by `context` is `internal`, logged, its message not sent.)

What each action answers for a row of `message` outside the scope:

| Action                                                                   | Answer                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`                                                                   | not there: `{and: [rowScope, clientFilter]}`; `total` counts in-scope rows; cursor and offset paging both. A lookup's labels (a `list` with `in` on ids) resolve to nothing                                                                                                                  |
| `read`                                                                   | `not_found`, the same message and details as an id that does not exist (never `forbidden`: existence does not leak)                                                                                                                                                                          |
| `mutate` update / delete                                                 | `not_found` as above, nothing written (with `expected_version` too: no `version_conflict` for it)                                                                                                                                                                                            |
| `mutate` insert                                                          | every top-level `eq` of the scope (`tenant`, `owner`) is written into the row, over whatever the client sent; a patch naming such a field gets it overwritten the same way. A row that would still fall outside the scope (a non-`eq` part) is `forbidden`, `details.reason: "out_of_scope"` |
| `reindex`                                                                | the scope is ANDed with the request's own `scope`; only in-scope rows are renumbered (a source without `enforcesRowScope` takes only `eq` scopes here, else `forbidden`)                                                                                                                     |
| `tree.reparent`                                                          | node or new parent outside → `not_found`; on `postgres_jsonb` the subtree and children-count statements stay inside the scope                                                                                                                                                                |
| `GET /udc/files/blob`                                                    | 404, as for a missing file (the file's row is checked against the scope)                                                                                                                                                                                                                     |
| `schema.add_field` / `update_field` / `soft_delete_field`, `source.read` | they act for every tenant: on a collection with a scope for this `ctx`, `forbidden` unless `access` answers `true` for that action; `describe` and `collections` then report `schema_edit: false`, `source_yaml: false`                                                                      |
| a collection `access` answers `false` for                                | left out of `collections` (asked with action `collections`), and every action on it is `not_found` like an unknown collection (the file route: 404, asked with action `read`)                                                                                                                |

**The scope's fields are hidden.** By default the fields a scope names
(`tenant`, `owner` above) are left out of `describe` (`schema.fields`,
`field_order`, `view.columns`, `filterable`, `view.search.fields`,
`view.filters`) and out of every row `list`, `read` and `mutate` answer; a
client filter, sort, row value or `reindex` scope naming one is answered
exactly as an unknown field (`validation_error`). To show the owner column,
list the collection in `showScopeFields: ["message"]`: the field is then
visible, filterable and sortable, and a client filter on it is still ANDed
with the scope (`{tenant: "other"}` simply matches nothing).

Without `context`, `rowScope` and `access`, nothing changes.

### Writing a source that knows the scope

A source of your own needs nothing: the generic layer ANDs the scope into the
`list` filter (and drops any row the source answers outside it), reads the row
before `read`, `mutate` and `tree.reparent` to answer `not_found`, and checks
the row an insert or update would write. That read-then-write is two steps;
a source that can do better sets `readonly enforcesRowScope = true` and applies
`sctx.rowScope` inside its own statements, as `PostgresJsonbSource` does (the
scope in the `WHERE`, and on the `RETURNING` row of a write in a transaction).
The `SourceContext` also carries `ctx`, for a source that forwards the user
upstream.

## `onMutate`: a host's own write

Both Postgres sources take an option `onMutate(ctx, change, tx)`: a write of
the host's own that goes with every mutation, such as a flag that must also
reach an external system. `PostgresTableSource` and `PostgresJsonbSource`
call it the same way; so does `sqlite_table`, with a SQLite `tx` (see
[`sqlite_table`](#sqlite_table-a-table-of-a-sqlite-file)).

- **`ctx`** is the request context (the plugin's `context`, see
  [Request context and scope](#request-context-and-scope)); `undefined`
  without one.
- **`change`** (`RowChange`) is `{ op, collection, id, before, after, patch }`:
  `before` is the row as it was (update, delete; `null` on insert), `after`
  the row as written (insert, update; `null` on delete), `patch` what the
  request wrote (the patch of an update, the fields of an insert, `null` on
  delete). Nothing in it is particular to a single-row request: `mutate_many`
  calls the same hook once per row (see [`mutate_many`](#mutate_many-many-rows-in-one-request)).
- **`tx`** is an `Executor` on the source's own transaction, for the host's
  SQL: it commits with the row and rolls back with it.
- It returns nothing, or a row: a returned row is what the caller receives
  (the host re-read or completed it); the source does not write it. A row
  without `__meta` keeps the written row's id and version.

**When it runs.** Inside the database transaction, **after** the source's own
statement and **before** `COMMIT`. A database refusal (a constraint, a
version conflict, a row outside the scope, a validation problem) is therefore
known before the host's external write is attempted, and the row is locked
while the hook runs: no other writer can change it in between, and no other
connection sees the change until `COMMIT`.

**When it fails.** The transaction is rolled back and nothing is written,
the row nor the hook's own SQL. A `UdcError` the hook throws is answered to
the caller as it is (the host chooses code, message and details); anything
else is answered as `internal` with the generic message and logged, like any
handler failure. The caller never gets a row the host's write did not accept.

Two things the host must keep in mind:

- **The hook holds a transaction and a row lock for as long as it runs.**
  Bound the external call (a timeout well under the client's), or a slow
  server holds the row and a pool connection with it.
- **When the hook succeeded but `COMMIT` then fails** (the connection drops),
  the external write stands and the row does not change. Make the hook
  idempotent (setting a flag, not toggling it), so a retry converges.

Without the option nothing changes: `postgres_jsonb` issues exactly the
statements of 0.3.0, with no added transaction. `postgres_table` writes in a
transaction either way.

### Worked example: a `seen` flag mirrored to the mail server

A `message` table whose `seen` column must also be set on the IMAP server
(the `\Seen` flag). The host's client, its timeout and the message's IMAP
address are the host's; the hook is the seam.

```ts
import { UdcError } from "@jsudc/core";
import { type OnMutateHook, PostgresTableSource } from "@jsudc/server/postgres";
import { sql } from "drizzle-orm";

type Ctx = { tenant: string; user: string };

const mirrorSeen: OnMutateHook<Ctx> = async (ctx, change, tx) => {
  // Only a change of `seen` goes to the mail server.
  if (change.op !== "update" || !change.patch || !("seen" in change.patch)) return;
  const seen = change.after?.seen === true;
  const res = await tx.execute<{ mailbox: string; uid: number }>(
    sql`SELECT mailbox, imap_uid AS uid FROM message WHERE id = ${change.id}::uuid`,
  );
  const { mailbox, uid } = res.rows[0] ?? {};
  try {
    // Idempotent: sets or clears the flag, never toggles it. Bounded: 5 s.
    await imap.setFlag(ctx.user, mailbox, uid, "\\Seen", seen, { timeoutMs: 5000 });
  } catch {
    // Answered to the user as it is; the row keeps its old `seen`.
    throw new UdcError("forbidden", "the mail server did not accept the change, try again", {
      reason: "imap",
    });
  }
  // The host's own bookkeeping, in the same transaction as the row.
  await tx.execute(sql`UPDATE message SET imap_synced_at = now() WHERE id = ${change.id}::uuid`);
};

registry.register({
  name: "message",
  view: asset.view,
  source: new PostgresTableSource({
    db,
    schema: asset.schema,
    table: "message",
    versionColumn: "row_version",
    onMutate: mirrorSeen,
  }),
});
```

What the user's grid gets for `mutate {op: "update", id, row: {seen: true}}`:

| The mail server                | The answer                                                                                            | The row                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------- | -------------------------- |
| sets the flag                  | `udc.mutate.ok`, the row with `seen: true` and the next version                                       | committed                  |
| refuses, or times out          | `udc.mutate.err`, `forbidden`, "the mail server did not accept the change, try again", `reason: imap` | unchanged, nothing written |
| the hook throws something else | `udc.mutate.err`, `internal`, "internal error" (and the error in the server's log)                    | unchanged, nothing written |
| (the row moved on meanwhile)   | `version_conflict` before the hook runs: the mail server is not called                                | unchanged                  |

The same option on `PostgresJsonbSource({ db, table, initialSchema, onMutate })`
behaves the same; with it, each of its mutations runs in a transaction.

## `mutate_many`: many rows in one request

`mutate_many` (`@jsudc/core`'s action) changes or deletes many rows of a
collection in one request: `{ collection, op: "update" | "delete", ids? ,
filter?, except_ids?, row? }`, answered with `{ updated, failed }`. Every
collection that serves `mutate` serves it, and says so with
`capabilities.mutate_many: true` (a source may set it `false` to refuse it).

**Context, scope and access** are those of `mutate`. The request runs under
the plugin's `context`, the dispatcher's `rowScope` and `access`:

- **By ids**, the rows of the list that exist inside the caller's scope are
  changed; every other id is reported in `failed` as `not_found` — a missing
  row and another tenant's row are indistinguishable, as in `mutate`. A
  repeated id counts once.
- **By filter**, the client's filter is ANDed with the scope, minus
  `except_ids`. A hidden scope field in the filter is refused like an unknown
  field.
- **The patch** is validated once, up front: an invalid one is a
  `validation_error` for the whole request and nothing is written. Read-only
  fields (`postgres_table`) and hidden scope fields are refused as in
  `mutate`; a field the scope pins keeps the caller's value. A patch that
  would take a row out of the scope is refused (`forbidden`,
  `reason: "out_of_scope"`) and nothing is written.
- Each changed row gets its version bumped. There is no `expected_version`.

**One transaction** in both Postgres sources and in `sqlite_table`. The
target rows are locked in id order (SQLite: the whole file, from the first
statement); without `onMutate` a single `UPDATE` / `DELETE` writes them all.
With `onMutate` they are written row by row inside the same transaction and
the hook is called for each with its `before` / `after` (`patch` is the
request's patch): **a hook failure rolls the whole request back** and is
answered as the error, exactly as for `mutate` — all or nothing; `failed`
only ever lists ids that were not there.

**The cap.** `createDispatcher(registry, { mutateManyLimit })` bounds how
many rows one request may touch (default `DEFAULT_MUTATE_MANY_LIMIT`,
10 000). More ids than that, or a filter matching more (counted after
`except_ids`, inside the scope), is a `validation_error` with
`details: { reason: "too_many_rows", limit, by: "ids" | "filter" }`, before
anything is written. The sources count with a bounded query (`LIMIT
limit + 1`), not with `count(*)`, so it works on a collection with
`total_count: false`.

**Other sources.** A source without a native `mutateMany` (`memory`, a
host's own `Source`) gets the generic one: the dispatcher validates the
patch, reads the rows in scope (by id, or by paging the filter), checks the
cap and the scope, then calls the source's `mutate` for each. Everything
that can be refused is refused before the first write, but there is no
transaction: a source failing midway leaves the rows before it changed. A
source of your own may implement `mutateMany(req, sctx)` (`SourceMutateMany`,
`MutateManyResult`) to do it natively; it is called when the source applies
the row scope itself (`enforcesRowScope`) or the request has none.

```ts
import { UdcClient } from "@jsudc/core";

// Tenant "a" archives its whole inbox but two threads: one request, one
// transaction; tenant "b"'s inbox is not touched, whatever the filter says.
const client = new UdcClient({ httpUrl: "", headers: { "x-tenant": "a" } });
const { updated, failed } = await client.mutateMany({
  collection: "message",
  op: "update",
  filter: { field: "folder", op: "eq", value: "inbox" },
  except_ids: [pinnedA, pinnedB],
  row: { archived: true },
});
// updated: how many of a's inbox rows were archived; failed: [] (by filter, nothing can be missing)

await client.mutateMany({ collection: "message", op: "delete", ids: [id1, idOfTenantB] });
// { updated: 1, failed: [{ id: idOfTenantB, code: "not_found", message: "no row with id …" }] }
```

## Search answered by the source

By default the search box is answered in the browser: `@jsudc/react` turns
its text into `contains` conditions over `view.search.fields`. A collection
whose rows have a real full-text index (a `tsvector` in Postgres, OpenSearch
beside the database) can answer the text itself instead: it reports
`capabilities.search: "source"`, the client sends the text as
`ListRequest.search` and composes nothing, and the source matches it — and,
when the request has no `sort`, may return the rows by relevance.

**Never wider than the scope.** The dispatcher passes `search` to the source
in `SourceListRequest` (trimmed; a blank text is no search). Whatever the
source matches is ANDed with the caller's row scope and the client's filter,
like any other condition: two tenants searching the same word each get only
their own rows.

**Refused, not ignored.** A collection whose source does not report the
capability answers a `search` with `unsupported_op` (`details.field:
"search"`) — it never ignores the text and lists every row. A source of your
own that sets `capabilities.search: "source"` reads `req.search` in `list`.

### On `postgres_table`: a `tsvector`

The `search` option of `PostgresTableSource` says, in SQL written in code,
how a row matches and how relevant it is. `match(q, text)` is a condition and
`rank(q, text)` (optional) a number, higher first; `q` is the text as a bound
parameter — it is never spliced into the statement — and `text` the same
text, for a host that builds a parameter of its own from it. With the option
the source reports `search: "source"`. A search with no `sort` comes by rank,
ties by id, paged by offset (the `next_cursor` it hands out carries the next
offset, so a client that walks by cursor walks a search too). With a `sort`,
or without `rank`, the match is one more condition and the list is ordered
and paged as usual.

```sql
-- The host's migration: a generated tsvector and its index.
ALTER TABLE inbox.message ADD COLUMN tsv tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('simple', coalesce(subject, '')), 'A') ||
  setweight(to_tsvector('simple', coalesce(body_text, '')), 'B')) STORED;
CREATE INDEX message_tsv ON inbox.message USING gin (tsv);
```

```ts
import { loadRegistry } from "@jsudc/server";
import { makeSource, PostgresTableSource } from "@jsudc/server/postgres";
import { sql } from "drizzle-orm";

const registry = loadRegistry("./collections", (asset, reg) =>
  asset.name === "message"
    ? new PostgresTableSource({
        db,
        schema: asset.schema,
        table: "inbox.message",
        versionColumn: "row_version",
        search: {
          // websearch syntax: quoted phrases, `or`, a minus to exclude.
          match: (q) => sql`tsv @@ websearch_to_tsquery('simple', ${q})`,
          rank: (q) => sql`ts_rank(tsv, websearch_to_tsquery('simple', ${q}))`,
        },
      })
    : makeSource(asset, { db, registry: reg, env: process.env }),
);
```

```ts
// A tenant's client: the best matches first, inside its own rows only.
await client.list({ collection: "message", search: "invoice -draft", page: { limit: 50 } });
// Roughly: SELECT … WHERE tenant_id = $1 AND (tsv @@ websearch_to_tsquery('simple', $2))
// ORDER BY (ts_rank(tsv, websearch_to_tsquery('simple', $3))) DESC NULLS LAST, id ASC LIMIT 51 OFFSET 0
```

### On `sqlite_table`: FTS5

`SqliteTableSource` takes the same `search` option (`SqliteTableSearch`:
`match(q, text)`, optional `rank(q, text)`, SQL written in code, `q` the text
as a bound parameter), with the same rules: the match is ANDed with the base
`where`, the row scope and the client's filter in the source's one
statement; a search without a `sort` comes by rank (ties by id), paged by
offset with the search cursor; with a `sort`, or without `rank`, it is one
more condition of an ordinary list. The recommended shape is an
**external-content FTS5 table** over the collection's table, **kept in step
by triggers in the database** — not by the source, because other processes
write the file too (another server, a customer's tool, the `sqlite3` shell),
and a trigger indexes their rows in their own transaction. Two helpers make
it:

- `sqliteFts5Sql({ table, columns, fts?, tokenize?, triggerPrefix? })` — the
  migration text: `CREATE VIRTUAL TABLE <table>_fts USING fts5(<columns>,
  content='<table>', content_rowid='rowid', tokenize='unicode61')`, an
  `AFTER INSERT`, an `AFTER DELETE` and an `AFTER UPDATE OF <columns>`
  trigger, and a `rebuild` that indexes the rows already there. All of it
  `IF NOT EXISTS`, so it can run at every start.
- `sqliteFts5Search({ table, fts?, weights?, prefix?, maxTerms? })` — the
  `search` option over that table: `match` is `<table>.rowid IN (SELECT
  rowid FROM <fts> WHERE <fts> MATCH ?)`, `rank` is `-bm25(<fts>, …weights)`
  of the row (bm25 is lower for a better hit, so negated: higher first).

The parameter bound to `MATCH` is not the raw text: FTS5 raises a syntax
error on an unbalanced `"`, a bare `-`, `:` or `*`, `NEAR(`, a trailing
`OR`. `fts5MatchExpression(text, { prefix, maxTerms })` makes one FTS5
always accepts — every whitespace-separated term quoted (`"` doubled),
the terms ANDed, the last one a prefix (`"invo"*`, for search as you type;
`prefix: false` turns it off), terms with no letter or digit dropped. So
operators and column filters typed into the box are plain words, and a text
that leaves no term (`"`, `*`, `-`) matches nothing instead of failing.
Use it in a `match` of your own as well.

```sql
-- What sqliteFts5Sql({ table: "note", columns: ["title", "body_text"] }) returns:
CREATE VIRTUAL TABLE IF NOT EXISTS "note_fts" USING fts5("title", "body_text", content='note', content_rowid='rowid', tokenize='unicode61');
CREATE TRIGGER IF NOT EXISTS "note_fts_ai" AFTER INSERT ON "note" BEGIN
  INSERT INTO "note_fts"(rowid, "title", "body_text") VALUES (new.rowid, new."title", new."body_text");
END;
CREATE TRIGGER IF NOT EXISTS "note_fts_ad" AFTER DELETE ON "note" BEGIN
  INSERT INTO "note_fts"("note_fts", rowid, "title", "body_text") VALUES ('delete', old.rowid, old."title", old."body_text");
END;
CREATE TRIGGER IF NOT EXISTS "note_fts_au" AFTER UPDATE OF "title", "body_text" ON "note" BEGIN
  INSERT INTO "note_fts"("note_fts", rowid, "title", "body_text") VALUES ('delete', old.rowid, old."title", old."body_text");
  INSERT INTO "note_fts"(rowid, "title", "body_text") VALUES (new.rowid, new."title", new."body_text");
END;
INSERT INTO "note_fts"("note_fts") VALUES ('rebuild');
```

```ts
import { loadRegistry, makeSource } from "@jsudc/server";
import {
  openNodeSqlite,
  SqliteTableSource,
  sqliteFts5Search,
  sqliteFts5Sql,
} from "@jsudc/server/sqlite";

const vault = openNodeSqlite("/var/lib/app/vault.db", { name: "vault" });
await vault.exec(sqliteFts5Sql({ table: "note", columns: ["title", "body_text"] }));

const registry = loadRegistry("./collections", (asset, reg) =>
  asset.name === "notes"
    ? new SqliteTableSource({
        db: vault,
        schema: asset.schema,
        table: "note",
        versionColumn: "version",
        fields: { body: "body_text" },
        // A title hit counts three times a body hit.
        search: sqliteFts5Search({ table: "note", weights: [3, 1] }),
      })
    : makeSource(asset, { registry: reg, sqlite: { vault } }),
);
// list { search: "invoice octo" } → roughly (each MATCH ? bound to '"invoice" AND "octo"*'):
// SELECT … FROM "note" WHERE 1 AND "owner" = ? AND 1
//   AND ("note".rowid IN (SELECT rowid FROM "note_fts" WHERE "note_fts" MATCH ?))
// ORDER BY CAST(((SELECT -bm25("note_fts", 3, 1) FROM "note_fts"
//   WHERE "note_fts" MATCH ? AND rowid = "note".rowid)) AS REAL) DESC NULLS LAST, "id" ASC LIMIT 51 OFFSET 0
```

- **Tokenizer.** `unicode61` is the default: words of Unicode letters and
  digits, case-folded, diacritics removed from Latin letters (`ručak` is
  found by `rucak`; `đ` is a letter of its own, not a `d`). Pass `tokenize`
  for another (`"unicode61 remove_diacritics 2"`, `"porter unicode61"`);
  the source does not care which.
- **Rowids.** The index is keyed by the table's `rowid`. A table whose id is
  an `INTEGER PRIMARY KEY` keeps its rowids; one with a uuid or text id has
  rowids that `VACUUM` may renumber — run `sqliteFts5RebuildSql(opts)` after
  a `VACUUM` of such a file. `WITHOUT ROWID` tables cannot have an
  external-content index.
- **Writers.** Every writer goes through the triggers, the source's own
  `mutate` and `mutate_many` included; the version trigger
  (`sqliteVersionTriggerSql`) does not re-index a row, since it writes no
  indexed column.
- `search` is set in code, not in `source.yaml`: a collection with it is made
  by the host (as above) rather than by `makeSource`.

**FTS5 or `withSearchIndex`?** Use FTS5 when the text lives in the SQLite
file and other processes write it: the index is part of the database, always
in step, and the row scope, the filter and the rank run in one statement, so
a page is never short. Use `withSearchIndex` when the index is a service of
its own that the host keeps up to date (OpenSearch, a vector store) or needs
what FTS5 lacks (semantic search, typo tolerance, one index over many
collections), accepting that a page may come back shorter when the scope or
the filter drops hits.

### An external index: `withSearchIndex`

When the index lives outside the database (OpenSearch, Elasticsearch, a
vector store), the host answers the text and jsudc does the rest.
`withSearchIndex(source, { search })` wraps any source: the wrapper reports
`search: "source"`, and a `list` with a `search` calls the host's
`search(query)` for **one page of row ids in relevance order** (and a `total`
when the index has one). jsudc then loads exactly those rows from the source
— `id in ids` ANDed with the client's filter, under the row scope — and
returns them in the index's order. An id the scope or the filter hides (or
one deleted since it was indexed) is dropped, never fetched around: the page
comes back shorter. `total` is the index's, `null` without one. A list
without `search`, and every other method, is the wrapped source's own.

The `query` the host receives (`SearchIndexQuery`): `text`, `page: { limit,
offset }`, `ctx` (what the plugin's `context` hook answered), `collection`,
`rowScope`, and the client's `filter` and `sort` when present. Pass the
tenant to the index as well, so a page is not mostly rows jsudc will drop;
jsudc applies the scope regardless.

```ts
import { Client } from "@opensearch-project/opensearch";
import { loadRegistry, withSearchIndex } from "@jsudc/server";
import { makeSource } from "@jsudc/server/postgres";

const os = new Client({ node: process.env.OPENSEARCH_URL });

const registry = loadRegistry("./collections", (asset, reg) => {
  const source = makeSource(asset, { db, registry: reg, env: process.env });
  if (asset.name !== "message" || !source) return source;
  return withSearchIndex(source, {
    async search({ text, page, ctx }) {
      const res = await os.search({
        index: "messages",
        from: page.offset,
        size: page.limit,
        _source: false,
        body: {
          query: {
            bool: {
              must: { simple_query_string: { query: text, fields: ["subject^3", "body"] } },
              filter: { term: { tenant_id: (ctx as { tenantId: string }).tenantId } },
            },
          },
        },
      });
      return {
        ids: res.body.hits.hits.map((h) => h._id),
        total: res.body.hits.total.value,
      };
    },
  });
});
```

Loading by `id in ids` needs a filter on `id` to mean the row id, which holds
for every built-in source unless its schema has a field named `id` of its own.
The host's `sort` is advisory: the wrapper keeps the order of `ids`, so a host
that wants a chosen sort to win orders its hits by it.

**Not covered.** `mutate_many` by `filter` takes no search text: "all that
match" a source search cannot be named in a bulk request yet, and
`@jsudc/react` does not offer it while a source search is active. Highlights,
facets and suggestions are not part of the protocol; no OpenSearch client
ships with jsudc.

## Host actions

A host serves actions of its own next to the built-in ones. Define each once
with `@jsudc/core`'s `defineHostAction` — name, request schema, response
schema — in a module the server and the browser both import, and register it
on the dispatcher: `dispatcher.register(action, handler)`. The handler's
payload is the request schema's output, its return value is typed by the
response schema, and it receives the request context (the plugin's
`context`) as its second argument. The dispatcher validates the payload (a
bad one is `validation_error`, the handler is not called), the plugin serves
it at `POST /udc/<name>`, and the OpenAPI document shows it with its request
and its response. A `UdcError` the handler throws is answered as it is;
anything else is `internal` and logged. `register(name, schema, handler)`
stays for an action without a shared definition.

### Worked example: archive a thread

```ts
// shared/actions.ts — imported by the server and the browser
import { defineHostAction } from "@jsudc/core";
import { z } from "zod";

export const archiveThread = defineHostAction({
  name: "mail.archive_thread",
  request: z.object({ thread: z.string().min(1) }),
  response: z.object({ archived: z.number().int() }),
});
```

```ts
// server
import { UdcError } from "@jsudc/core";
import { buildApp, createDispatcher } from "@jsudc/server";
import { archiveThread } from "../shared/actions.js";

type Ctx = { tenant: string; user: string };

const dispatcher = createDispatcher<Ctx>(registry, { log, rowScope });
dispatcher.register(archiveThread, async ({ thread }, ctx: Ctx) => {
  // The protocol itself, under the same context and scope: only the caller's rows.
  const res = await dispatcher.dispatch(
    {
      kind: "udc.mutate_many",
      id: "",
      payload: {
        collection: "message",
        op: "update",
        filter: { field: "thread", op: "eq", value: thread },
        row: { archived: true },
      },
    },
    ctx,
  );
  if (res.kind.endsWith(".err")) throw new UdcError("internal", "archive failed");
  return { archived: (res.payload as { updated: number }).updated };
});
const app = await buildApp({ dispatcher, context: (req) => sessionOf(req) });
```

```ts
// browser
import { UdcClient } from "@jsudc/core";
import { archiveThread } from "../shared/actions.js";

const client = new UdcClient({ httpUrl: "" });
const { archived } = await client.call(archiveThread, { thread: "t42" }); // typed
```

## Change feed

A host tells jsudc when rows changed, and every connected client that may see
those rows is told over one long-lived stream, so the UI refreshes without
polling. A client is told only about rows inside its own scope, and never
receives row data: an event is `{ collection, op, ids? }` (`ChangeEvent` of
`@jsudc/core`), and the client refetches under its own scope, so a hidden
scope field cannot leak through the feed.

Configure it once and give it to the dispatcher:

```ts
import { buildApp, createChangeFeed, createDispatcher } from "@jsudc/server";

const changes = createChangeFeed(); // one process; see "Several processes" below
const dispatcher = createDispatcher<Ctx>(registry, { log, rowScope, changes });
const app = await buildApp({ dispatcher, registry, context: (req) => sessionOf(req) });
```

With it, every collection reports `capabilities.changes: true` (`describe`,
`collections`; `capabilities.subscribe` stays `false`, it promises udc-py's
WebSocket actions), and the plugin serves `GET /udc/changes?collections=a,b`
(under the plugin's `prefix`, next to your own routes) as Server-Sent Events.
Without `changes` nothing differs from before: no route, no capability, no
cost.

The stream runs `context` once when it opens: a refusal is an HTTP 401
(unauthenticated) or 403 with the error payload, not a stream. Every
collection must be one the request may `list` (the `access` rule, asked with
action `list`), else 404; its row scope is fixed for the life of the stream.
Then it sends a `retry:` hint (`retryMs`, default 3 s), a `ready` event, a
`change` event per change the request may see, and a heartbeat comment every
`heartbeatMs` (default 15 s). The listener is removed when the client goes
away, and `app.close()` ends every open stream (`changes.close()` ends the
streams of that feed alone: see [Several databases, several
instances](#several-databases-several-instances)). There is **no replay**: a
change made while a client was disconnected is not sent later; the client
refetches when it reconnects (`UdcClient.changes` reports `reconnected` for
exactly that).

### What jsudc notifies by itself

After its own writes commit (when the source has answered), once per request,
never for a request that failed:

| Action          | Event                                                                                                                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mutate`        | `insert` / `update` / `delete` with the row's id, tested on the row as written (an update also on the row as it was; a delete on the values it had)                                          |
| `mutate_many`   | `update` / `delete` with the ids of the rows it changed, each tested on its own values (as it was and as it is)                                                                              |
| `reindex`       | `update` with the renumbered ids when the source hands the rows over (`postgres_table`, `sqlite_table`), else without ids, tested on the request's `scope` and the row scope's pinned values |
| `tree.reparent` | `update` without ids (the subtree and both parents changed too), tested on the moved node                                                                                                    |

Both Postgres sources and `sqlite_table` hand the rows a `mutate_many` wrote
to the feed (`SourceContext.changedRows`); a source of your own with a native
`mutateMany` may do the same. One that does not still notifies, with the ids
asked for and the row scope's pinned values.

### `notify`: changes jsudc did not make

After a write of your own, call `changes.notify(collection, { op?, ids?, ctx?, rows? })`:

- **`ctx`**: the request context the rows belong to. The `eq` conditions of
  `rowScope(ctx, collection)` are what the scope rule tests, so only streams
  in that scope (and unscoped ones) are told.
- **`rows`**: the changed rows' values (any fields a scope tests; a
  `__meta.id` names the row). Each scope is told only the ids of its own rows;
  when a row names no id, the event carries no ids at all (it could otherwise
  name another scope's rows). Preferred over `ctx` when both are given.
- **`op`** defaults to `update`; no `ids` means "this collection changed".

On a collection that has a row scope, a `notify` with neither `ctx` nor
`rows` **throws**: nothing is ever broadcast across scopes. Whether a
collection has a scope is asked of your `rowScope` with no context: a filter,
or a throw (it reads a context that is not there), means it has one.

Worked example: a background job syncs a user's mailbox and inserts the new
messages; that user's open tabs refresh, nobody else's.

```ts
import { createChangeFeed, createDispatcher } from "@jsudc/server";

const changes = createChangeFeed();
const dispatcher = createDispatcher<Ctx>(registry, {
  log,
  rowScope: (ctx, collection) =>
    collection === "message" ? { field: "owner", op: "eq", value: ctx.user } : undefined,
  changes,
});

async function syncMailbox(user: string): Promise<void> {
  const inserted = await imap.fetchNew(user); // writes rows owned by `user`, outside jsudc
  if (inserted.length === 0) return;
  await changes.notify<Ctx>("message", {
    op: "insert",
    ids: inserted.map((m) => m.id),
    ctx: { user }, // → { owner: user }: only this user's streams hear it
  });
}
```

### Writes by other processes to a SQLite file

A SQLite file is also written by programs that are not this server: a
customer's tool, the `sqlite3` shell, a sync job in another process. Those
writes go through neither jsudc nor your code, so nothing calls `notify`.
Open the file with **`watch`** and the server notices them:

```ts
import { openNodeSqlite } from "@jsudc/server/sqlite";

const vault = openNodeSqlite("vault.db", { watch: true }); // or { watch: { intervalMs: 500 } }
const changes = createChangeFeed();
const dispatcher = createDispatcher<Ctx>(registry, { log, rowScope, changes });
```

The `SqliteDatabase` polls `PRAGMA data_version` on its write connection —
every `DEFAULT_SQLITE_WATCH_MS` (1000 ms) with `watch: true` — while at least
one listener is registered; a dispatcher with a change feed registers one per
`sqlite_table` collection (`Source.onExternalWrite`). That value moves when
**another connection** commits to the file, never for the wrapper's own
commits, so a write through jsudc or through the same `SqliteDatabase` sends
only its normal exact notice, never a second, coarse one. When it moved, every
collection served from that file gets one event, `{ collection, op: "update" }`
**without ids**, on every stream of this process subscribed to it — **scoped
streams too**, since a scope cannot be tested without rows — through the
stream's usual burst control. The client refetches under its own scope, so
nothing leaks but the fact that something changed.

What it is, and what it is not:

- It detects **that the file changed, not which rows**, nor which table: every
  collection of the file is told, whatever the other program wrote (even a
  table no collection serves). Several commits between two polls are one event.
- It is **as late as the interval**: up to `intervalMs` after the commit.
  Without `watch` nothing polls, and such writes reach a screen only through
  its own polling fallback or a reload.
- **A host that needs exact notices for its own writes made in the same
  process calls `changes.notify` itself** (with `rows` or `ctx`, see above).
  A write through the `SqliteDatabase` (`run`, `transaction`, `proxy` for
  Drizzle) is never seen as external, so without `notify` it is not announced
  at all; a write through a connection the host opened itself, outside the
  wrapper, is seen as external and announced coarsely.
- The event is delivered to this process's streams and **not published on the
  bus**: each server process that opens the file with `watch` notices the
  write itself. With several processes on one file, a write one of them makes
  through jsudc looks external to the others: their streams get the exact
  notice over the bus and, within the interval, a coarse one as well.
- `ChangeFeed.externalChange(collection)` sends the same coarse event by hand,
  for a source of your own that learns of outside writes some other way
  (implement `Source.onExternalWrite`, and the dispatcher wires it).

### The scope rule, in plain words

A stream is told about a change in a collection when it asked for that
collection and either it has no row scope there, or its scope holds for at
least one of the changed rows; it then receives only the ids of the rows its
scope holds for. To test that, a change carries, on the server only, the
values of the changed rows a scope can test (strings up to 256 characters,
numbers, booleans, null, short arrays of those; row contents beyond that are
never kept). A change whose rows are unknown reaches unscoped streams only —
except a write another process made to a SQLite file opened with `watch`
(above), which every stream of the collection hears of, without ids.

Burst control: past `coalesce.maxEvents` events (default 20) for one
collection on one stream within `coalesce.windowMs` (default 250 ms), the
rest are sent as one event without ids at the end of the window
(`coalesce: false` turns it off). An event naming more than `maxIds` rows
(default 500) is sent without ids.

### Several processes: the Postgres bus, or your own

The default bus is in-process: right for one server process. With several
behind a load balancer, a change made through one must reach the streams of
the others; give every process the same bus.

```ts
import { createChangeFeed } from "@jsudc/server";
import { createPostgresChangeBus } from "@jsudc/server/postgres";

const changes = createChangeFeed({
  bus: createPostgresChangeBus({
    connectionString: process.env.DATABASE_URL!,
    pool: dbHandle.pool, // optional: NOTIFY through your pool
    channel: "jsudc_changes", // the default; every process must agree
  }),
});
```

`PostgresChangeBus` keeps one dedicated connection per process that
`LISTEN`s, and reopens it with backoff when it drops (`reconnectDelayMs`,
`maxReconnectDelayMs`); notices sent while it is down are lost to that
process (its clients refetch on reconnect). A change is delivered to the
streams of its own process at once and sent to the others with `NOTIFY`; a
payload over NOTIFY's size limit (8000 bytes) goes out without ids, meaning
"this collection changed", split over several notifications when the values
to test are large. `changes.close()` closes the bus.

Anything else (Redis pub/sub, NATS) is a `ChangeBus` of your own:

```ts
import type { ChangeBus, ChangeNotice } from "@jsudc/server";

function redisBus(pub: Redis, sub: Redis, channel = "jsudc_changes"): ChangeBus {
  const listeners = new Set<(n: ChangeNotice) => void>();
  void sub.subscribe(channel);
  sub.on("message", (_ch, text) => {
    for (const l of listeners) l(JSON.parse(text) as ChangeNotice);
  });
  return {
    publish: async (notice) => void (await pub.publish(channel, JSON.stringify(notice))),
    subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    close: async () => void (await sub.quit()),
  };
}
```

`publish` must reach every process, this one included (or deliver locally and
skip its own echo, as the Postgres bus does); a `ChangeNotice` carries the
values the scope rule tests, so keep the channel server-side.

### What a proxy must allow

The stream is one response that never ends. In front of it:

- **No buffering.** nginx: `proxy_buffering off;` (the route also sends
  `X-Accel-Buffering: no`), and no gzip on `text/event-stream`.
- **Long timeouts.** The heartbeat writes every 15 s; a read timeout above
  that keeps the connection open (nginx `proxy_read_timeout 1h;`, an AWS ALB
  idle timeout above 15 s). HTTP/1.1 to the upstream
  (`proxy_http_version 1.1; proxy_set_header Connection "";`).
- Browsers allow about six HTTP/1.1 connections per origin: open one stream
  for all the collections a page shows (`collections=a,b,c`), or serve over
  HTTP/2.

## API

From `@jsudc/server` (no database driver):

| Export                                                                                                                              | What                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `udcPlugin`, `buildApp`, `UdcPluginOptions`                                                                                         | the Fastify plugin, and a Fastify instance with it registered                                                    |
| `createDispatcher`, `Dispatcher`, `DispatchLogger`                                                                                  | every action wired to a registry; `Dispatcher` to register actions of your own                                   |
| `HostActionHandler`, `DEFAULT_MUTATE_MANY_LIMIT`                                                                                    | a host action's handler type (see [Host actions](#host-actions)); the `mutate_many` cap                          |
| `loadRegistry`, `readCollectionAssets`, `CollectionRegistry`, `Collection`, `CollectionAsset`                                       | read a collection directory; the served collections                                                              |
| `makeSource`, `SourceDeps`                                                                                                          | the source `source.yaml` asks for: memory, filesystem, http_api, yaml_menu, sqlite_table                         |
| `MemorySource`, `FilesystemSource`, `HttpApiSource`, `YamlMenuSource`                                                               | four of the seven sources, usable directly                                                                       |
| `compileFilter`, `compileSort`, `orderBy`, `sortKeyColumns`, `cursorPredicate`, `encodeCursor`, `decodeCursor`, `FieldResolver`, …  | the SQL compiler, for a source of your own (see [The SQL compiler](#the-sql-compiler))                           |
| `ArraySource`, `Source` and its request types                                                                                       | to write a source of your own: implement `Source`, or extend `ArraySource` over an array                         |
| `OnMutateResult`, `RowChange`                                                                                                       | what an `onMutate` hook gets and returns                                                                         |
| `buildDescribe`, `filterableFields`, `deriveColumns`                                                                                | what `describe` answers, for a custom action                                                                     |
| `registryLinkProblems`, `assertRegistryLinks`, `checkRegistryLinks`, `assertLookupTarget`                                           | the lookup and `row_link` checks: at load, against active schemas, before a schema edit                          |
| `registerBlobRoute`, `BLOB_ROUTE`                                                                                                   | the file preview route on its own                                                                                |
| `DispatcherOptions`, `RowScopeOptions`, `AccessRequest`, `SourceContext`                                                            | the request context and the row scope (see above)                                                                |
| `ScopedCollection`, `openCollection`, `andFilters`, `rowScopePins`, `withoutFields`, `describeWithout`, `TENANT_WIDE_ACTIONS`       | the generic row-scope layer, for a route of your own that reaches rows                                           |
| `withSearchIndex`, `SearchIndexOptions`, `SearchIndexQuery`, `SearchIndexResult`                                                    | the search box answered by the source (see above)                                                                |
| `searchText`, `assertSearchable`, `searchPage`, `encodeSearchCursor`, `decodeSearchCursor`                                          | the same pieces, for a source of your own that answers `search`                                                  |
| `createChangeFeed`, `ChangeFeed`, `ChangeFeedOptions`, `NotifyOptions`, `ChangeCoalesceOptions`                                     | the change feed and `notify` (see [Change feed](#change-feed))                                                   |
| `ChangeBus`, `ChangeNotice`, `ChangeMatch`, `ChangeListener`, `MemoryChangeBus`                                                     | the bus between server processes, and the in-process one                                                         |
| `registerChangesRoute`, `ChangesRouteOptions`, `ChangeSubscriber`, `eventFor`, `scopeValues`, `MAX_CHANGE_COLLECTIONS`              | the stream route on its own, and the scope rule's pieces                                                         |
| `BlobRouteOptions`                                                                                                                  | `registerBlobRoute(app, registry, {context, scope})`                                                             |
| `mapItems`, `interpolateHeaders`, `httpSourcesEnabled`, `filesystemRoot`, `cacheTtlEnvVar`, `rootEnvVar`                            | the pieces the http_api and filesystem sources are made of                                                       |
| `SqliteTableSource`, `SqliteTableSourceOptions`, `SqliteTableFieldSpec`, `SqliteOnMutateHook`, `sqliteVersionTriggerSql`            | the SQLite table source and its version trigger (see [`sqlite_table`](#sqlite_table-a-table-of-a-sqlite-file))   |
| `SqliteTableSearch`, `sqliteFts5Search`, `sqliteFts5Sql`, `sqliteFts5RebuildSql`, `fts5MatchExpression`, `SqliteFts5…Options`       | the search box on a `sqlite_table` with FTS5 (see [On `sqlite_table`: FTS5](#on-sqlite_table-fts5))              |
| `SqliteDatabase`, `SqliteConnection`, `SqliteExecutor`, `isSqliteBusy`, `DEFAULT_SQLITE_BUSY_TIMEOUT_MS`, `DEFAULT_SQLITE_WATCH_MS` | the one object per SQLite file, over a driver adapter; `watch` and `onExternalWrite` for other processes' writes |

From `@jsudc/server/sqlite` (`node:sqlite`, built into Node 24): `openNodeSqlite`,
`OpenNodeSqliteOptions` and `nodeSqliteConnection` — a file opened as one
`SqliteDatabase` — and the SQLite exports of the root entry again.

From `@jsudc/server/better-sqlite3` (needs the optional peer `better-sqlite3`):
`openBetterSqlite`, `OpenBetterSqliteOptions`, `betterSqliteConnection`,
`BetterSqliteDatabase` and `BetterSqliteStatement` — the same with
`better-sqlite3` — and the SQLite exports of the root entry again.

From `@jsudc/server/postgres` (needs `pg`):

| Export                                                                                                                                       | What                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `makeSource`, `PostgresSourceDeps`                                                                                                           | the same, every kind included (`db` for the two Postgres ones)                        |
| `PostgresJsonbSource`, `PostgresTableSource`, `PostgresTableSourceOptions`, `TableFieldSpec`                                                 | the two Postgres sources                                                              |
| `OnMutateHook`                                                                                                                               | the `onMutate` option of both Postgres sources (its `tx` is an `Executor`)            |
| `connect`, `Db`, `DbHandle`, `Executor`                                                                                                      | a drizzle database over a `pg` pool                                                   |
| `ensureUdcSchema`, `udcMigrations`, `UDC_MIGRATIONS_DIR`                                                                                     | the library's SQL                                                                     |
| `collectionTable`, `createCollectionTableSql`, `udcSchemaRevisions`                                                                          | the tables, for drizzle and for plain SQL                                             |
| `seedCollection`                                                                                                                             | schema revision 1 and the rows of a Postgres collection                               |
| `activeSchema`, `writeSchemaRevision`                                                                                                        | the schema store under the schema edits                                               |
| `PostgresTableSearch`                                                                                                                        | `search` of a `PostgresTableSource`                                                   |
| `createPostgresChangeBus`, `PostgresChangeBus`, `PostgresChangeBusOptions`, `encodeNotice`, `DEFAULT_CHANGE_CHANNEL`, `NOTIFY_PAYLOAD_LIMIT` | the `LISTEN` / `NOTIFY` bus                                                           |
| `jsonbResolver`, `columnResolver`, `ColumnResolverOptions`                                                                                   | the resolvers of the two Postgres sources (see [The SQL compiler](#the-sql-compiler)) |

## Develop

Requires Node 24 (`.nvmrc`) and a Postgres the tests may write to: they create
the database named in `TEST_DATABASE_URL` (default
`postgresql://jsudc:123@localhost/jsudc_test`) when it is missing, run the
library's SQL in it and create the fixture tables (`test/global-setup.ts`).
The fixture collections, one per source kind, are in
`test/fixtures/collections/`.

Vitest runs two projects: `udc-server` (every test file) and `postgres-table`,
which runs the jsonb filter and paging suites (`pg-filter`, `pg-paging`,
`pg-parity`, `pg-array`, `pg-allowlist`) a second time, unchanged, with
`PostgresJsonbSource` aliased to `test/table-double/postgres-jsonb.ts`: a double
that copies the rows into a table with real typed columns and serves it through
`PostgresTableSource`. The `sqlite` project runs the same read suites through
`SqliteTableSource` (`test/sqlite-double/`, the rows copied into `node:sqlite`
`:memory:`), and `sqlite-table` runs `test/sqlite-table/` — the SQLite source
and wrapper on `:memory:` and on temp files — without any database server
(`npm run test:sqlite`). Its write suites (`mutate-many`, `mutate-many-hook`,
`on-mutate`, `changes-writes`) run once per driver: `node:sqlite`, and
`better-sqlite3` when it is installed and its native addon loads (a dev
dependency here; the adapter's own suite is skipped otherwise).

```sh
npm ci              # also builds dist (the prepare script)
npm run typecheck   # tsc --noEmit over src and test
npm run lint        # Biome
npm test            # Vitest, one file at a time (they share the database)
npm run test:cov    # coverage, thresholds 80%
npm run test:sqlite # the SQLite suites alone: no database server needed
npm run test:no-pg  # npm pack, install in an empty dir without pg, serve memory and sqlite_table
npm run build       # tsc -> dist (ESM + .d.ts)
```

## License

MIT, see [LICENSE](LICENSE).
