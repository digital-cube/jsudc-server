// What the SQLite suites share with the Postgres ones, without `pg` (test/helpers.ts imports it).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Row, type SchemaDocInput, SchemaDocSchema, UdcError } from "@jsudc/core";
import { expect } from "vitest";

const companiesDir = join(import.meta.dirname, "..", "fixtures", "collections", "companies");

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
