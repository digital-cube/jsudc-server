import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// Inside the jsudc monorepo, test against @jsudc/core's source so a change there needs no
// rebuild; standalone, the installed package is used.
const coreSrc = fileURLToPath(new URL("../udc-core/src/index.ts", import.meta.url));

/**
 * The suites that need no database server and never import `pg`: the dispatcher, the
 * scope, the change feed, the memory, filesystem, http_api and yaml_menu sources, the
 * registry, the HTTP plugin and the test kit. With `test/sqlite-table` they are what
 * `npm run test:no-db` runs, and CI runs them with no Postgres service and `pg`
 * uninstalled. A file here imports `test/common.ts`, never `test/helpers.ts`.
 * (`row-scope` runs its memory backend there; its Postgres one in `udc-server`.)
 */
const NO_DB_SUITES = [
  "test/changes-feed.test.ts",
  "test/changes-route.test.ts",
  "test/columns.test.ts",
  "test/describe-columns.test.ts",
  "test/dispatcher.test.ts",
  "test/filesystem.test.ts",
  "test/filterable.test.ts",
  "test/host-action.test.ts",
  "test/http-api-history.test.ts",
  "test/http-api.test.ts",
  "test/memory.test.ts",
  "test/registry.test.ts",
  "test/request-context.test.ts",
  "test/schema-edit.test.ts",
  "test/testing.test.ts",
  "test/transport.test.ts",
  "test/yaml-menu.test.ts",
];

/** The jsonb filter and paging suites, run a second time against `postgres_table`. */
const TABLE_SUITES = [
  "test/pg-filter.test.ts",
  "test/pg-paging.test.ts",
  "test/pg-parity.test.ts",
  "test/pg-array.test.ts",
  "test/pg-allowlist.test.ts",
];

/** The swap of `PostgresJsonbSource` for the double that serves a `postgres_table`. */
const tableDouble = [
  {
    find: /^\.\.\/src\/sources\/postgres-jsonb\.js$/,
    replacement: fileURLToPath(new URL("./test/table-double/postgres-jsonb.ts", import.meta.url)),
  },
];

/**
 * The jsonb read suites, run a third time against the SQL compiler's SQLite dialect in
 * `node:sqlite` `:memory:` (see test/sqlite-double).
 */
const SQLITE_SUITES = [
  "test/pg-filter.test.ts",
  "test/pg-paging.test.ts",
  "test/pg-parity.test.ts",
  "test/pg-array.test.ts",
  "test/pg-allowlist.test.ts",
];

const sqliteDouble = [
  {
    find: /^\.\.\/src\/sources\/postgres-jsonb\.js$/,
    replacement: fileURLToPath(new URL("./test/sqlite-double/postgres-jsonb.ts", import.meta.url)),
  },
];

/**
 * The jsonb mutate and reindex suites, against `postgres_table` too. Its `schema revisions` block is
 * about the jsonb source's revision store (a `postgres_table` serves its schema.json, no
 * revisions) and the jsonb constructor's checks: it does not run here.
 */
const TABLE_MUTATE_SUITES = ["test/pg-mutate.test.ts", "test/reindex.test.ts"];

/**
 * Vitest 5 types `testNamePattern` as a root option, but its runner applies the one of
 * each project (`interpretTaskModes(…, config.testNamePattern)`). Should that stop, the
 * skipped cases run against the double and fail: nothing passes unnoticed.
 */
const skipJsonbOnly = { testNamePattern: /^(?!schema revisions)/ } as object;

export default defineConfig({
  resolve: {
    alias: existsSync(coreSrc) ? { "@jsudc/core": coreSrc } : {},
  },
  test: {
    root: fileURLToPath(new URL(".", import.meta.url)),
    // Creates the Postgres test database, unless every project of the run is a no-database
    // one (it reads the run's projects; `no-db` and `sqlite-table` are listed there).
    globalSetup: ["test/global-setup.ts"],
    // Every DB test file truncates the same tables: run files one at a time.
    fileParallelism: false,
    coverage: {
      include: ["src/**/*.ts"],
      // Re-exports only.
      exclude: ["src/index.ts", "src/postgres.ts", "src/sqlite.ts"],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
    },
    projects: [
      {
        extends: true,
        test: {
          name: "udc-server",
          include: ["test/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "test/sqlite-table/**", ...NO_DB_SUITES],
          sequence: { groupOrder: 0 },
        },
      },
      {
        // The same files, unchanged, with `PostgresJsonbSource` swapped for a double that
        // serves a typed relational copy of the rows through `PostgresTableSource`.
        extends: true,
        resolve: { alias: tableDouble },
        test: {
          name: "postgres-table",
          include: TABLE_SUITES,
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        resolve: { alias: tableDouble },
        test: {
          name: "postgres-table-mutate",
          include: TABLE_MUTATE_SUITES,
          sequence: { groupOrder: 2 },
          ...skipJsonbOnly,
        },
      },
      {
        extends: true,
        resolve: { alias: sqliteDouble },
        test: {
          name: "sqlite",
          include: SQLITE_SUITES,
          sequence: { groupOrder: 3 },
        },
      },
      {
        // No database server: not `extends: true`, and test/global-setup.ts skips the
        // database when only no-database projects run. `npm run test:no-db` runs this project
        // and `sqlite-table`.
        resolve: { alias: existsSync(coreSrc) ? { "@jsudc/core": coreSrc } : {} },
        test: {
          name: "no-db",
          root: fileURLToPath(new URL(".", import.meta.url)),
          include: [...NO_DB_SUITES, "test/row-scope.test.ts"],
          env: { UDC_TEST_NO_DB: "1" },
          sequence: { groupOrder: 5 },
        },
      },
      {
        // The `sqlite_table` source and the SQLite wrapper, on `:memory:` and temp files: no
        // database server (see `no-db`). `npm run test:sqlite` runs this project alone.
        resolve: { alias: existsSync(coreSrc) ? { "@jsudc/core": coreSrc } : {} },
        test: {
          name: "sqlite-table",
          root: fileURLToPath(new URL(".", import.meta.url)),
          include: ["test/sqlite-table/**/*.test.ts"],
          sequence: { groupOrder: 4 },
        },
      },
    ],
  },
});
