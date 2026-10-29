import { createHash } from "node:crypto";
import type { FieldDef, FieldType, SchemaDoc } from "@jsudc/core";
import { sql } from "drizzle-orm";
import type { Executor } from "../db/client.js";
import { fieldExpr } from "./sql.js";

/** Types with an ordering the query compiler sorts by; `json` and the array types get no index. */
const INDEXABLE: ReadonlySet<FieldType> = new Set([
  "string",
  "enum",
  "relation",
  "text",
  "integer",
  "decimal",
  "year",
  "bool",
  "date",
  "datetime",
]);

const MAX_IDENTIFIER = 63;
const HASH_LEN = 8;
/** What a hashed name keeps of `<table>_data_<field>`: room for `_<hash>_idx`. */
const KEPT = MAX_IDENTIFIER - HASH_LEN - "__idx".length;

/**
 * `<table>_data_<field>_idx`; a name Postgres would truncate is shortened
 * with a hash instead, so two long field names cannot collide.
 */
export function indexName(table: string, field: string): string {
  const name = `${table}_data_${field}_idx`;
  if (name.length <= MAX_IDENTIFIER) return name;
  const hash = createHash("sha256").update(name).digest("hex").slice(0, HASH_LEN);
  return `${name.slice(0, KEPT)}_${hash}_idx`;
}

export function wantsIndex(def: FieldDef | undefined): boolean {
  return def !== undefined && def.index === true && !def.deleted && INDEXABLE.has(def.type);
}

/**
 * Bring a collection's expression indexes in line with a schema revision:
 * `CREATE INDEX IF NOT EXISTS` for every live `index: true` field of a
 * sortable type, and `DROP INDEX IF EXISTS` for each `touched` field that no
 * longer wants one (index switched off, soft-deleted). The plain forms, not
 * CONCURRENTLY, so this runs inside the revision's transaction. `table` and
 * the field names passed FIELD_NAME_RE before they got here.
 */
export async function syncFieldIndexes(
  db: Executor,
  table: string,
  schema: Pick<SchemaDoc, "fields">,
  touched: readonly string[] = [],
): Promise<void> {
  const t = sql.identifier(table);
  for (const [field, def] of Object.entries(schema.fields)) {
    if (!wantsIndex(def)) continue;
    await db.execute(
      sql`CREATE INDEX IF NOT EXISTS ${sql.identifier(indexName(table, field))} ON ${t} ((${fieldExpr(field, def)}))`,
    );
  }
  for (const field of touched) {
    if (wantsIndex(schema.fields[field])) continue;
    await db.execute(sql`DROP INDEX IF EXISTS ${sql.identifier(indexName(table, field))}`);
  }
}

/** Drop every field index of a collection's table (a reseed starts again from `schema.json`). */
export async function dropFieldIndexes(db: Executor, table: string): Promise<string[]> {
  // Both name forms of `indexName` start with this.
  const prefix = `${table}_data_`.slice(0, KEPT);
  const res = await db.execute<{ indexname: string }>(
    sql`SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = ${table}`,
  );
  const names = res.rows
    .map((r) => r.indexname)
    .filter((n) => n.startsWith(prefix) && n.endsWith("_idx"));
  for (const name of names) await db.execute(sql`DROP INDEX IF EXISTS ${sql.identifier(name)}`);
  return names;
}
