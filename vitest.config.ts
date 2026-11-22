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
      exclude: ["src/index.ts"],
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
        resolve: {
          alias: [
            {
              find: /^\.\.\/src\/sources\/postgres-jsonb\.js$/,
              replacement: fileURLToPath(
                new URL("./test/table-double/postgres-jsonb.ts", import.meta.url),
              ),
            },
          ],
        },
        test: {
          name: "postgres-table",
          include: TABLE_SUITES,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
