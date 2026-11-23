// The SQLite suites: no database server. Each opens `:memory:` or a file in a temp
// directory with `openNodeSqlite`, and builds its tables with plain SQL.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FieldDef, SchemaDoc } from "@jsudc/core";
import { afterAll } from "vitest";
import {
  type OpenNodeSqliteOptions,
  openNodeSqlite,
  type SqliteDatabase,
} from "../../src/sqlite.js";

export { companiesSchema, companiesSeed, ids, rejectsWith } from "./shared.js";

/** Where a suite's database lives: `:memory:`, or a file of its own. */
export type Where = "memory" | "file";
export const WHERES: Where[] = ["memory", "file"];

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A new temp directory, removed when the file is done. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "jsudc-sqlite-"));
  dirs.push(dir);
  return dir;
}

/** A new database file path in a temp directory. */
export function tempFile(name = "test.db"): string {
  return join(tempDir(), name);
}

const open: SqliteDatabase[] = [];
afterAll(() => {
  for (const db of open.splice(0)) db.close();
});

/** A database, closed when the file is done. */
export function openDb(where: Where, opts: OpenNodeSqliteOptions = {}): SqliteDatabase {
  const db = openNodeSqlite(where === "memory" ? ":memory:" : tempFile(), opts);
  open.push(db);
  return db;
}

/** The column type of a field, in `sqliteColumnResolver`'s storage. */
export function columnType(def: FieldDef): string {
  switch (def.type) {
    case "integer":
    case "year":
    case "bool":
      return "INTEGER";
    case "decimal":
      return "NUMERIC";
    default:
      return "TEXT";
  }
}

/** `CREATE TABLE` for a schema: a uuid TEXT id, an INTEGER version, a typed column per live field. */
export function createTableSql(table: string, schema: SchemaDoc): string {
  const cols = schema.field_order
    .filter((f) => schema.fields[f] && !schema.fields[f]?.deleted)
    .map((f) => `, "${f}" ${columnType(schema.fields[f] as FieldDef)}`)
    .join("");
  return `CREATE TABLE "${table}" ("id" TEXT PRIMARY KEY, "version" INTEGER NOT NULL DEFAULT 1${cols})`;
}
