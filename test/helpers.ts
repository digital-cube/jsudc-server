import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Row, type SchemaDocInput, SchemaDocSchema, UdcError } from "@jsudc/core";
import { sql } from "drizzle-orm";
import { afterAll, expect } from "vitest";
import { connect, type Db } from "../src/db/client.js";
import { PostgresJsonbSource } from "../src/sources/postgres-jsonb.js";

/** The database the tests own: created and migrated by `global-setup.ts`, truncated per file. */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || "postgresql://jsudc:123@localhost/jsudc_test";

/** The fixture collections: one per source kind (see its README). */
export const COLLECTIONS_DIR = join(import.meta.dirname, "fixtures", "collections");
/** Recorded upstream answers of the http_api fixtures (`UDC_HTTP_FIXTURES`). */
export const HTTP_FIXTURES = join(import.meta.dirname, "fixtures", "http");

const companiesDir = join(COLLECTIONS_DIR, "companies");

export const companiesSchemaJson = JSON.parse(
  readFileSync(join(companiesDir, "schema.json"), "utf8"),
) as SchemaDocInput;
export const companiesSchema = SchemaDocSchema.parse(companiesSchemaJson);
export const companiesSeed = JSON.parse(
  readFileSync(join(companiesDir, "seed.json"), "utf8"),
) as Record<string, unknown>[];

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

export async function rejectsWith(p: Promise<unknown>, code: string): Promise<UdcError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, `expected a ${code} UdcError`).toBeInstanceOf(UdcError);
  expect((err as UdcError).code).toBe(code);
  return err as UdcError;
}

export const ids = (rows: Row[]) => rows.map((r) => r.__meta.id);
