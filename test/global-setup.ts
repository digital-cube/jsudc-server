import pg from "pg";
import { connect } from "../src/db/client.js";
import { ensureUdcSchema } from "../src/db/ensure.js";
import { createCollectionTableSql } from "../src/db/schema.js";
import { TEST_DATABASE_URL } from "./helpers.js";

/** The postgres_jsonb fixture tables: `companies` (a fixture collection), `tasks` and `tree_nodes` (built in the tests). */
const TABLES = ["companies", "tasks", "tree_nodes"];

/** `CREATE DATABASE` when it is missing, through a connection to `postgres`. */
async function createDatabase(url: string): Promise<void> {
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

/** The test database exists and has the library's SQL and the fixture tables before any file runs. */
export default async function setup() {
  await createDatabase(TEST_DATABASE_URL);
  const handle = connect(TEST_DATABASE_URL);
  try {
    await ensureUdcSchema(handle.db);
    for (const t of TABLES) await handle.pool.query(createCollectionTableSql(t));
  } finally {
    await handle.close();
  }
}
