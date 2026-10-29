import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Inside the jsudc monorepo, test against @jsudc/core's source so a change there needs no
// rebuild; standalone, the installed package is used.
const coreSrc = fileURLToPath(new URL("../udc-core/src/index.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: existsSync(coreSrc) ? { "@jsudc/core": coreSrc } : {},
  },
  test: {
    name: "udc-server",
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    // Every DB test file truncates the same tables: run files one at a time.
    fileParallelism: false,
    coverage: {
      include: ["src/**/*.ts"],
      // Re-exports only.
      exclude: ["src/index.ts"],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
    },
  },
});
