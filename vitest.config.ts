import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Inside the jsudc monorepo, test against @jsudc/core's source so a change there needs no
// rebuild; standalone, the installed package is used.
const coreSrc = fileURLToPath(new URL("../udc-core/src/index.ts", import.meta.url));

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
 * The jsonb mutate suite, against `postgres_table` too. Its `schema revisions` block is
 * about the jsonb source's revision store (a `postgres_table` serves its schema.json, no
 * revisions) and the jsonb constructor's checks: it does not run here.
 */
const TABLE_MUTATE_SUITES = ["test/pg-mutate.test.ts"];

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
    globalSetup: ["test/global-setup.ts"],
    // Every DB test file truncates the same tables: run files one at a time.
    fileParallelism: false,
    coverage: {
      include: ["src/**/*.ts"],
      // Re-exports only.
      exclude: ["src/index.ts", "src/postgres.ts"],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
    },
    projects: [
      {
        extends: true,
        test: {
          name: "udc-server",
          include: ["test/**/*.test.ts"],
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
    ],
  },
});
