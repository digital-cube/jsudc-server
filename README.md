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
- five **sources**: Postgres `jsonb`, memory, filesystem, HTTP API, YAML menu;
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
npm install github:digital-cube/jsudc-core#v0.2.0 github:digital-cube/jsudc-server#v0.2.0
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

| Option       | What                                                                                                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dispatcher` | `createDispatcher(registry, {log})`; `log.error` receives what fails inside an action                                                                                       |
| `registry`   | enables `GET /udc/files/blob?collection=&path=`, the file previews of filesystem collections whose view sets `folder_options.preview`                                       |
| `swagger`    | `true` (default), `false`, or `{routePrefix, title, version, description}`. Needs the optional peers `@fastify/swagger`, `@fastify/swagger-ui`, `fastify-type-provider-zod` |

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

## The five sources

`source.yaml` picks one with `kind`:

| `kind`                     | Rows                                                                                                | Writes                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `postgres_jsonb` (default) | a table, every field in `data jsonb`; `options.table` overrides the name                            | mutate, schema edits, reindex, reparent     |
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

## API

| Export                                                                                                   | What                                                                                     |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `udcPlugin`, `buildApp`, `UdcPluginOptions`                                                              | the Fastify plugin, and a Fastify instance with it registered                            |
| `createDispatcher`, `Dispatcher`, `DispatchLogger`                                                       | every action wired to a registry; `Dispatcher` to register actions of your own           |
| `loadRegistry`, `readCollectionAssets`, `CollectionRegistry`, `Collection`, `CollectionAsset`            | read a collection directory; the served collections                                      |
| `makeSource`, `SourceDeps`                                                                               | the source `source.yaml` asks for                                                        |
| `PostgresJsonbSource`, `MemorySource`, `FilesystemSource`, `HttpApiSource`, `YamlMenuSource`             | the five sources, usable directly                                                        |
| `ArraySource`, `Source` and its request types                                                            | to write a source of your own: implement `Source`, or extend `ArraySource` over an array |
| `connect`, `Db`, `DbHandle`, `Executor`                                                                  | a drizzle database over a `pg` pool                                                      |
| `ensureUdcSchema`, `udcMigrations`, `UDC_MIGRATIONS_DIR`                                                 | the library's SQL                                                                        |
| `collectionTable`, `createCollectionTableSql`, `udcSchemaRevisions`                                      | the tables, for drizzle and for plain SQL                                                |
| `seedCollection`                                                                                         | schema revision 1 and the rows of a Postgres collection                                  |
| `activeSchema`, `writeSchemaRevision`                                                                    | the schema store under the schema edits                                                  |
| `buildDescribe`, `filterableFields`, `deriveColumns`                                                     | what `describe` answers, for a custom action                                             |
| `registerBlobRoute`, `BLOB_ROUTE`                                                                        | the file preview route on its own                                                        |
| `mapItems`, `interpolateHeaders`, `httpSourcesEnabled`, `filesystemRoot`, `cacheTtlEnvVar`, `rootEnvVar` | the pieces the http_api and filesystem sources are made of                               |

## Develop

Requires Node 24 (`.nvmrc`) and a Postgres the tests may write to: they create
the database named in `TEST_DATABASE_URL` (default
`postgresql://jsudc:123@localhost/jsudc_test`) when it is missing, run the
library's SQL in it and create the fixture tables (`test/global-setup.ts`).
The fixture collections, one per source kind, are in
`test/fixtures/collections/`.

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
