// What every suite may share without `pg`: the fixture paths, the companies fixture and
// two assertions. `helpers.ts` re-exports it beside the Postgres helpers; a file of the
// no-database projects (vitest.config.ts, `npm run test:no-db`) imports this one only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Row, type SchemaDocInput, SchemaDocSchema, UdcError } from "@jsudc/core";
import { expect } from "vitest";

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
