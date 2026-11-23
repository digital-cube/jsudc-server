import { type SchemaDocInput, SchemaDocSchema } from "@jsudc/core";
import { sql } from "drizzle-orm";
import { afterAll } from "vitest";
import { connect, type Db } from "../src/db/client.js";
import { PostgresJsonbSource } from "../src/sources/postgres-jsonb.js";
import { companiesSchema } from "./common.js";

export {
  COLLECTIONS_DIR,
  companiesSchema,
  companiesSchemaJson,
  companiesSeed,
  HTTP_FIXTURES,
  ids,
  rejectsWith,
} from "./common.js";

/** The database the tests own: created and migrated by `global-setup.ts`, truncated per file. */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || "postgresql://jsudc:123@localhost/jsudc_test";

/** One pool per test file, closed when the file is done. */
export function useTestDb() {
  const handle = connect(TEST_DATABASE_URL);
  afterAll(() => handle.close());
  return handle;
}

export async function resetTables(db: Db): Promise<void> {
  await db.execute(sql`truncate table companies, udc_schema_revisions restart identity`);
}

/** Make `schema` the active revision `version` of `collection` (stored parsed, `field_order` explicit). */
export async function activateSchema(
  db: Db,
  schema: SchemaDocInput,
  version = 1,
  collection = "companies",
): Promise<void> {
  await db.execute(
    sql`update udc_schema_revisions set active = false where collection = ${collection} and active`,
  );
  await db.execute(sql`
    insert into udc_schema_revisions (collection, version, schema, active)
    values (${collection}, ${version}, ${JSON.stringify(SchemaDocSchema.parse(schema))}::jsonb, true)`);
}

/** Insert raw `data` objects into `companies`, bypassing validation; returns the ids in order. */
export async function insertRows(db: Db, rows: Record<string, unknown>[]): Promise<string[]> {
  const ids: string[] = [];
  for (const row of rows) {
    const res = await db.execute<{ id: string }>(
      sql`insert into companies (data) values (${JSON.stringify(row)}::jsonb) returning id`,
    );
    ids.push(res.rows[0]?.id as string);
  }
  return ids;
}

export function companiesSource(db: Db, pageSizeDefault = 50) {
  return new PostgresJsonbSource({
    db,
    table: "companies",
    initialSchema: companiesSchema,
    pageSizeDefault,
  });
}
