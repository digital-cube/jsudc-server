// `npm run test:no-pg`: the package as a host gets it — `npm pack`, then
// `npm install <tarball>` in an empty temp directory, which installs the
// required peers and leaves the optional ones (`pg`, the swagger trio) out.
// With no `pg` anywhere in that tree, the root entry must import, a registry
// with a `memory` collection must load, and `buildApp({ swagger: false })`
// must answer `describe` and `list`. A `sqlite_table` collection over a
// file opened with `@jsudc/server/sqlite` (node:sqlite) must answer
// `describe`, `list` and `mutate` under a row scope. `@jsudc/server/postgres`
// must fail on the missing `pg` and nothing else. `@jsudc/server/better-sqlite3`
// must import without `better-sqlite3`, and `openBetterSqlite` say it is
// missing. `@jsudc/server/testing`'s `openTestApp` must serve the host's
// collections over its own `:memory:` database. No database server is needed.
//
// Needs the npm registry (or a warm npm cache) for the peers. TMPDIR moves
// the temp directory. NO_PG_CORE_DIR=<a @jsudc/core checkout> installs that
// core (packed) instead of the published one: for a server change that needs
// a core not released yet.

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
  const coreDir = process.env.NO_PG_CORE_DIR;
  const tarballs = [tarball];
  if (coreDir) {
    const core = JSON.parse(
      run(npm, ["pack", "--json", "--pack-destination", work], resolve(coreDir)),
    );
    tarballs.unshift(join(work, core[0].filename));
    console.log(`packed ${core[0].filename} (NO_PG_CORE_DIR)`);
  }

  // 2. A host with nothing but the tarball as its dependency.
  const host = join(work, "host");
  mkdirSync(host);
  writeFileSync(
    join(host, "package.json"),
    JSON.stringify({ name: "no-pg-host", private: true, type: "module" }, null, 2),
  );
  run(
    npm,
    [
      "install",
      ...tarballs,
      "--no-audit",
      "--no-fund",
      "--prefer-offline",
      "--legacy-peer-deps=false",
    ],
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

  // 3b. One sqlite_table collection, its rows in a file the host opens.
  const vaultNotes = join(host, "collections", "vault_notes");
  mkdirSync(vaultNotes, { recursive: true });
  writeFileSync(
    join(vaultNotes, "schema.json"),
    JSON.stringify({
      version: "v1",
      core_fields: [],
      fields: {
        owner: { type: "string" },
        title: { type: "string", required: true },
        done: { type: "bool" },
      },
    }),
  );
  writeFileSync(
    join(vaultNotes, "view.yaml"),
    "default_renderer: table\ncolumns:\n  - {field: title}\n",
  );
  writeFileSync(
    join(vaultNotes, "source.yaml"),
    "kind: sqlite_table\noptions:\n  database: vault\n  table: note\n  version_column: version\n",
  );

  // 4. The host's server, run by plain node from the host directory.
  writeFileSync(
    join(host, "main.mjs"),
    `import { buildApp, createDispatcher, loadRegistry, makeSource } from "@jsudc/server";
import { openNodeSqlite } from "@jsudc/server/sqlite";

const vault = openNodeSqlite("./vault.db", { name: "vault" });
await vault.exec(\`
  CREATE TABLE IF NOT EXISTS note (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1);
  DELETE FROM note;
  INSERT INTO note (id, owner, title) VALUES
    ('7d1e0c2a-0000-4000-8000-000000000001', 'ana', 'Ana''s'),
    ('7d1e0c2a-0000-4000-8000-000000000002', 'bob', 'Bob''s');\`);
const registry = loadRegistry("./collections", (asset, reg) =>
  makeSource(asset, { registry: reg, sqlite: { vault } }),
);
const dispatcher = createDispatcher(registry, {
  log: { error: (...a) => console.error(...a) },
  rowScope: (ctx, collection) =>
    collection === "vault_notes" ? { field: "owner", op: "eq", value: ctx.user } : undefined,
});
const app = await buildApp({
  dispatcher,
  registry,
  swagger: false,
  context: (req) => ({ user: req.headers["x-user"] ?? "ana" }),
});
const post = async (action, payload) =>
  (await app.inject({ method: "POST", url: "/udc/" + action, payload })).json();
const describe = await post("describe", { collection: "notes" });
const list = await post("list", { collection: "notes" });
const sqlite = {
  describe: await post("describe", { collection: "vault_notes" }),
  list: await post("list", { collection: "vault_notes" }),
  mutate: await post("mutate", {
    collection: "vault_notes",
    op: "insert",
    row: { title: "From HTTP", done: true },
  }),
};
sqlite.after = await post("list", { collection: "vault_notes", sort: [{ field: "title" }] });
sqlite.owner = (await vault.get("SELECT owner FROM note WHERE title = 'From HTTP'"))?.owner;
vault.close();
let postgres;
try {
  await import("@jsudc/server/postgres");
  postgres = "imported";
} catch (err) {
  postgres = { code: err.code, message: err.message };
}
// The better-sqlite3 entry imports without its optional peer; opening a file names it.
const better = {};
try {
  const entry = await import("@jsudc/server/better-sqlite3");
  better.imported = typeof entry.openBetterSqlite === "function";
  try {
    entry.openBetterSqlite(":memory:");
    better.opened = true;
  } catch (err) {
    better.message = err.message;
  }
} catch (err) {
  better.importError = err.message;
}
await app.close();
// The test kit: its own :memory: database, the host's collection directory over it.
const { openTestApp } = await import("@jsudc/server/testing");
const kit = await openTestApp({
  collections: "./collections",
  database: "vault",
  ddl: "CREATE TABLE note (id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL," +
    " done INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1);" +
    " INSERT INTO note (id, owner, title) VALUES ('7d1e0c2a-0000-4000-8000-000000000009', 'kit', 'In the kit');",
});
const testing = {
  path: kit.path,
  list: await kit.call("list", { collection: "vault_notes" }),
};
await kit.close();
console.log(JSON.stringify({ describe, list, sqlite, postgres, better, testing }));
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
  const sq = out.sqlite;
  assert.equal(sq.describe.kind, "udc.describe.ok", JSON.stringify(sq.describe));
  assert.deepEqual(Object.keys(sq.describe.payload.schema.fields).sort(), ["done", "title"]);
  assert.equal(sq.describe.payload.capabilities.mutate, true);
  assert.equal(sq.list.kind, "udc.list.ok", JSON.stringify(sq.list));
  assert.deepEqual(
    sq.list.payload.rows.map((r) => [r.title, r.done]),
    [["Ana's", false]],
  );
  assert.equal(sq.mutate.kind, "udc.mutate.ok", JSON.stringify(sq.mutate));
  assert.equal(sq.mutate.payload.row.done, true);
  assert.deepEqual(
    sq.after.payload.rows.map((r) => r.title),
    ["Ana's", "From HTTP"],
  );
  assert.equal(sq.owner, "ana");
  assert.equal(out.postgres.code, "ERR_MODULE_NOT_FOUND", JSON.stringify(out.postgres));
  assert.match(out.postgres.message, /'pg'/);
  assert.equal(out.better.imported, true, JSON.stringify(out.better));
  assert.match(out.better.message ?? "", /npm install better-sqlite3/, JSON.stringify(out.better));

  assert.equal(out.testing.path, ":memory:");
  assert.equal(out.testing.list.kind, "udc.list.ok", JSON.stringify(out.testing.list));
  assert.deepEqual(
    out.testing.list.payload.rows.map((r) => r.title),
    ["In the kit"],
  );

  console.log("ok: @jsudc/server without pg — root entry, memory registry, describe and list");
  console.log("ok: sqlite_table over node:sqlite — describe, list, mutate under a row scope");
  console.log("ok: @jsudc/server/postgres without pg fails on the missing 'pg' only");
  console.log("ok: @jsudc/server/better-sqlite3 imports without it; openBetterSqlite names it");
  console.log("ok: @jsudc/server/testing — openTestApp over the host's collections, :memory:");
} finally {
  if (keep) console.log(`kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
