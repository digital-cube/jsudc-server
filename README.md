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

```sh
npm install @jsudc/server @jsudc/core fastify drizzle-orm pg zod
# the OpenAPI docs at /docs (on by default):
npm install @fastify/swagger @fastify/swagger-ui fastify-type-provider-zod
# or straight from a GitHub tag:
npm install github:digital-cube/jsudc-core#v0.4.0 github:digital-cube/jsudc-server#v0.4.0
```

## Quick start

```ts
import Fastify from "fastify";
import {
  connect,
  createDispatcher,
  ensureUdcSchema,
  loadRegistry,
  makeSource,
  udcPlugin,
} from "@jsudc/server";

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

### The plugin's options

| Option       | What                                                                                                                                                                                                                                |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dispatcher` | `createDispatcher(registry, {log})`; `log.error` receives what fails inside an action                                                                                                                                               |
| `registry`   | enables `GET /udc/files/blob?collection=&path=`, the file previews of filesystem collections whose view sets `folder_options.preview`                                                                                               |
| `checkLinks` | with `registry`: check every lookup and `row_link` against the active schemas before serving (`checkRegistryLinks`). Default `true`                                                                                                 |
| `swagger`    | `true` (default), `false`, or `{routePrefix, title, version, description}`. Needs the optional peers `@fastify/swagger`, `@fastify/swagger-ui`, `fastify-type-provider-zod`                                                         |
| `context`    | `(request) => ctx`, sync or async: who is asking. Handed to every action, the dispatcher's `rowScope` / `access` and every source method; throw a `UdcError` to refuse. See [Request context and scope](#request-context-and-scope) |

`createDispatcher(registry, options)` takes, beside `log`:

| Option            | What                                                                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rowScope`        | `(ctx, collection) => FilterNode \| undefined`: the row filter a request is held to on a collection; `undefined` is no limit                             |
| `access`          | `(ctx, {action, collection}) => boolean \| undefined`: `false` hides the collection, `true` lets a scoped request run `schema.*` and `source.read` on it |
| `showScopeFields` | collection names whose scope fields stay visible (shown, filterable, sortable); by default a scope's fields are hidden from the client                   |

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

## The six sources

`source.yaml` picks one with `kind`:

| `kind`                     | Rows                                                                                                | Writes                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `postgres_jsonb` (default) | a table, every field in `data jsonb`; `options.table` overrides the name                            | mutate, schema edits, reindex, reparent     |
| `postgres_table`           | an ordinary relational table with typed columns (see [below](#postgres_table-a-relational-table))   | mutate (plain columns)                      |
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
`schema.json` (no revisions, no schema edits, no reindex, no tree reparent).
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
import { PostgresTableSource } from "@jsudc/server";

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
and left out of `describe.filterable`; `sortable: false` refuses it in a sort.
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
| `sortKeyColumns(terms)`                                                                            | the sort values as text (`__k0`, `__k1`, …), selected to build the next cursor           |
| `cursorPredicate(terms, values, id, resolve?)`                                                     | the rows strictly after a cursor position                                                |
| `encodeCursor(parts)`, `decodeCursor(c, keys, idType?)`                                            | the cursor codec (base64url JSON, as udc-py); the id is checked against `idType`         |
| `escapeLike(text)`                                                                                 | a LIKE pattern that matches literally                                                    |
| `FieldResolver`, `SqlCast`, `SqlIdType`, `SqlArrayForm`, `sqlCastFor`, `codePointOrder`, `idParam` | the resolver contract and its helpers                                                    |
| `jsonbResolver`                                                                                    | `postgres_jsonb`'s resolver (`data->>'f'`, a uuid `id`); the default of every `resolve?` |
| `columnResolver({ fields, id, idType, arrayForms })`                                               | the resolver over typed columns that `PostgresTableSource` uses                          |

## The SQL the host must run

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
import { collectionTable } from "@jsudc/server";
export { udcSchemaRevisions } from "@jsudc/server";
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
call it the same way.

- **`ctx`** is the request context (the plugin's `context`, see
  [Request context and scope](#request-context-and-scope)); `undefined`
  without one.
- **`change`** (`RowChange`) is `{ op, collection, id, before, after, patch }`:
  `before` is the row as it was (update, delete; `null` on insert), `after`
  the row as written (insert, update; `null` on delete), `patch` what the
  request wrote (the patch of an update, the fields of an insert, `null` on
  delete). Nothing in it is particular to a single-row request: a bulk action
  (0.5.0) calls the same hook once per row.
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
import { type OnMutateHook, PostgresTableSource } from "@jsudc/server";
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

## API

| Export                                                                                                                             | What                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `udcPlugin`, `buildApp`, `UdcPluginOptions`                                                                                        | the Fastify plugin, and a Fastify instance with it registered                            |
| `createDispatcher`, `Dispatcher`, `DispatchLogger`                                                                                 | every action wired to a registry; `Dispatcher` to register actions of your own           |
| `loadRegistry`, `readCollectionAssets`, `CollectionRegistry`, `Collection`, `CollectionAsset`                                      | read a collection directory; the served collections                                      |
| `makeSource`, `SourceDeps`                                                                                                         | the source `source.yaml` asks for                                                        |
| `PostgresJsonbSource`, `PostgresTableSource`, `MemorySource`, `FilesystemSource`, `HttpApiSource`, `YamlMenuSource`                | the six sources, usable directly                                                         |
| `compileFilter`, `compileSort`, `orderBy`, `sortKeyColumns`, `cursorPredicate`, `encodeCursor`, `decodeCursor`, `FieldResolver`, … | the SQL compiler, for a source of your own (see [The SQL compiler](#the-sql-compiler))   |
| `ArraySource`, `Source` and its request types                                                                                      | to write a source of your own: implement `Source`, or extend `ArraySource` over an array |
| `OnMutateHook`, `OnMutateResult`, `RowChange`                                                                                      | the `onMutate` option of both Postgres sources (see above)                               |
| `connect`, `Db`, `DbHandle`, `Executor`                                                                                            | a drizzle database over a `pg` pool                                                      |
| `ensureUdcSchema`, `udcMigrations`, `UDC_MIGRATIONS_DIR`                                                                           | the library's SQL                                                                        |
| `collectionTable`, `createCollectionTableSql`, `udcSchemaRevisions`                                                                | the tables, for drizzle and for plain SQL                                                |
| `seedCollection`                                                                                                                   | schema revision 1 and the rows of a Postgres collection                                  |
| `activeSchema`, `writeSchemaRevision`                                                                                              | the schema store under the schema edits                                                  |
| `buildDescribe`, `filterableFields`, `deriveColumns`                                                                               | what `describe` answers, for a custom action                                             |
| `registryLinkProblems`, `assertRegistryLinks`, `checkRegistryLinks`, `assertLookupTarget`                                          | the lookup and `row_link` checks: at load, against active schemas, before a schema edit  |
| `registerBlobRoute`, `BLOB_ROUTE`                                                                                                  | the file preview route on its own                                                        |
| `DispatcherOptions`, `RowScopeOptions`, `AccessRequest`, `SourceContext`                                                           | the request context and the row scope (see above)                                        |
| `ScopedCollection`, `openCollection`, `andFilters`, `rowScopePins`, `withoutFields`, `describeWithout`, `TENANT_WIDE_ACTIONS`      | the generic row-scope layer, for a route of your own that reaches rows                   |
| `BlobRouteOptions`                                                                                                                 | `registerBlobRoute(app, registry, {context, scope})`                                     |
| `mapItems`, `interpolateHeaders`, `httpSourcesEnabled`, `filesystemRoot`, `cacheTtlEnvVar`, `rootEnvVar`                           | the pieces the http_api and filesystem sources are made of                               |

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
`PostgresTableSource`.

```sh
npm ci              # also builds dist (the prepare script)
npm run typecheck   # tsc --noEmit over src and test
npm run lint        # Biome
npm test            # Vitest, one file at a time (they share the database)
npm run test:cov    # coverage, thresholds 80%
npm run build       # tsc -> dist (ESM + .d.ts)
```

## License

MIT, see [LICENSE](LICENSE).
