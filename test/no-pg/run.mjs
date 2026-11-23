// `npm run test:no-pg`: the package as a host gets it — `npm pack`, then
// `npm install <tarball>` in an empty temp directory, which installs the
// required peers and leaves the optional ones (`pg`, the swagger trio) out.
// With no `pg` anywhere in that tree, the root entry must import, a registry
// with a `memory` collection must load, and `buildApp({ swagger: false })`
// must answer `describe` and `list`. `@jsudc/server/postgres` must fail on
// the missing `pg` and nothing else. No database is needed.
//
// Needs the npm registry (or a warm npm cache) for the peers. TMPDIR moves
// the temp directory.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const pkgDir = resolve(import.meta.dirname, "../..");
const work = mkdtempSync(join(tmpdir(), "jsudc-server-no-pg-"));
const keep = process.env.KEEP_NO_PG_DIR === "1";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

try {
  // 1. The tarball, exactly as it would be published (`prepare` builds dist).
  const packed = JSON.parse(run(npm, ["pack", "--json", "--pack-destination", work], pkgDir));
  const tarball = join(work, packed[0].filename);
  console.log(`packed ${packed[0].filename}`);

  // 2. A host with nothing but the tarball as its dependency.
  const host = join(work, "host");
  mkdirSync(host);
  writeFileSync(
    join(host, "package.json"),
    JSON.stringify({ name: "no-pg-host", private: true, type: "module" }, null, 2),
  );
  run(
    npm,
    ["install", tarball, "--no-audit", "--no-fund", "--prefer-offline", "--legacy-peer-deps=false"],
    host,
  );
  const nm = join(host, "node_modules");
  assert.ok(existsSync(join(nm, "@jsudc/server")), "@jsudc/server is installed");
  for (const peer of ["@jsudc/core", "fastify", "zod", "drizzle-orm"]) {
    assert.ok(existsSync(join(nm, peer)), `required peer ${peer} is installed`);
  }
  assert.ok(!existsSync(join(nm, "pg")), "pg is not installed");
  assert.ok(!existsSync(join(nm, "@types/pg")), "@types/pg is not installed");

  // 3. One memory collection.
  const notes = join(host, "collections", "notes");
  mkdirSync(notes, { recursive: true });
  writeFileSync(
    join(notes, "schema.json"),
    JSON.stringify({
      version: "v1",
      core_fields: [],
      fields: {
        title: { type: "string", required: true },
        pages: { type: "integer", min: 0 },
      },
    }),
  );
  writeFileSync(
    join(notes, "view.yaml"),
    "default_renderer: table\ncolumns:\n  - {field: title}\n",
  );
  writeFileSync(join(notes, "source.yaml"), "kind: memory\n");
  writeFileSync(
    join(notes, "seed.json"),
    JSON.stringify([
      { title: "Read the protocol", pages: 12 },
      { title: "Mount the plugin", pages: 3 },
    ]),
  );

  // 4. The host's server, run by plain node from the host directory.
  writeFileSync(
    join(host, "main.mjs"),
    `import { buildApp, createDispatcher, loadRegistry, makeSource } from "@jsudc/server";

const registry = loadRegistry("./collections", (asset, reg) => makeSource(asset, { registry: reg }));
const dispatcher = createDispatcher(registry, { log: { error: (...a) => console.error(...a) } });
const app = await buildApp({ dispatcher, registry, swagger: false });
const post = async (action, payload) =>
  (await app.inject({ method: "POST", url: "/udc/" + action, payload })).json();
const describe = await post("describe", { collection: "notes" });
const list = await post("list", { collection: "notes" });
let postgres;
try {
  await import("@jsudc/server/postgres");
  postgres = "imported";
} catch (err) {
  postgres = { code: err.code, message: err.message };
}
await app.close();
console.log(JSON.stringify({ describe, list, postgres }));
`,
  );
  const out = JSON.parse(run(process.execPath, ["main.mjs"], host).trim().split("\n").pop());

  assert.equal(out.describe.kind, "udc.describe.ok", JSON.stringify(out.describe));
  assert.deepEqual(Object.keys(out.describe.payload.schema.fields).sort(), ["pages", "title"]);
  assert.equal(out.list.kind, "udc.list.ok", JSON.stringify(out.list));
  assert.deepEqual(out.list.payload.rows.map((r) => r.title).sort(), [
    "Mount the plugin",
    "Read the protocol",
  ]);
  assert.equal(out.postgres.code, "ERR_MODULE_NOT_FOUND", JSON.stringify(out.postgres));
  assert.match(out.postgres.message, /'pg'/);

  console.log("ok: @jsudc/server without pg — root entry, memory registry, describe and list");
  console.log("ok: @jsudc/server/postgres without pg fails on the missing 'pg' only");
} finally {
  if (keep) console.log(`kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
