import type { TestProject } from "vitest/node";

/** The postgres_jsonb fixture tables: `companies` (a fixture collection), `tasks` and `tree_nodes` (built in the tests). */
const TABLES = ["companies", "tasks", "tree_nodes"];

/** `CREATE DATABASE` when it is missing, through a connection to `postgres`. */
async function createDatabase(url: string): Promise<void> {
  const { default: pg } = await import("pg");
  const name = decodeURIComponent(new URL(url).pathname.slice(1));
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name)) throw new Error(`bad database name ${name}`);
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const found = await client.query("select 1 from pg_database where datname = $1", [name]);
    if (found.rowCount === 0) await client.query(`create database "${name}"`);
  } finally {
    await client.end();
  }
}

/** The test database, the library's SQL and the fixture tables. */
async function prepare(): Promise<void> {
  // Loaded here, so a run without Postgres never imports `pg`.
  const { connect } = await import("../src/db/client.js");
  const { ensureUdcSchema } = await import("../src/db/ensure.js");
  const { createCollectionTableSql } = await import("../src/db/schema.js");
  const { TEST_DATABASE_URL } = await import("./helpers.js");
  await createDatabase(TEST_DATABASE_URL);
  const handle = connect(TEST_DATABASE_URL);
  try {
    await ensureUdcSchema(handle.db);
    for (const t of TABLES) await handle.pool.query(createCollectionTableSql(t));
  } finally {
    await handle.close();
  }
}

/** The projects that need no database server (vitest.config.ts). */
const NO_DB_PROJECTS = new Set(["no-db", "sqlite-table"]);

/**
 * The test database exists and has the library's SQL and the fixture tables before any file
 * runs — unless every project of this run needs no database (`npm run test:no-db`): then
 * nothing connects, and `pg` is not even loaded. (A root `globalSetup` runs for every
 * project, and naming this file in several projects trips Vitest 5 at startup.)
 */
export default async function setup(project: TestProject) {
  const names = project.vitest.projects.map((p) => p.name);
  if (names.every((n) => NO_DB_PROJECTS.has(n))) return;
  await prepare();
}
