import {
  FIELD_NAME_RE,
  type SchemaDoc,
  type SchemaDocInput,
  SchemaDocSchema,
  validateRow,
} from "@jsudc/core";
import { sql } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { dropFieldIndexes, syncFieldIndexes } from "./sources/indexes.js";

export interface SeedOptions {
  table: string;
  /** `schema.json` as read from disk, stored as revision 1 with its `field_order` made explicit. */
  schema: SchemaDocInput;
  rows: Record<string, unknown>[];
  /**
   * Truncate the table and drop the collection's schema revisions (so every
   * revision after 1 goes) and field indexes first: back to `schema.json`.
   */
  reset?: boolean;
  limit?: number;
}

export interface SeedResult {
  table: string;
  inserted: number;
  revision: "created" | "kept";
  /** The table already had rows and `reset` was not asked for. */
  skipped: boolean;
}

/**
 * jsonb does not keep object key order, so a schema stored without
 * `field_order` would come back in jsonb's key order: always store it.
 */
export function storedSchema(schema: SchemaDoc): SchemaDoc {
  return { ...schema, version: "v1" };
}

/** Write `schema.json` as revision 1 (active) and the seed rows into the collection's table. */
export async function seedCollection(db: Db, opts: SeedOptions): Promise<SeedResult> {
  const { table } = opts;
  if (!FIELD_NAME_RE.test(table)) throw new Error(`invalid table name ${JSON.stringify(table)}`);
  const schema = SchemaDocSchema.parse(opts.schema);
  const rows = opts.rows.slice(0, opts.limit ?? opts.rows.length);
  rows.forEach((row, i) => {
    const problems = validateRow(schema, row, { mode: "insert" });
    if (problems.length > 0) {
      throw new Error(`seed row ${i} of ${table} is invalid: ${JSON.stringify(problems)}`);
    }
  });

  return db.transaction(async (tx) => {
    const t = sql.identifier(table);
    if (opts.reset) {
      await tx.execute(sql`TRUNCATE TABLE ${t}`);
      await tx.execute(sql`DELETE FROM udc_schema_revisions WHERE collection = ${table}`);
      await dropFieldIndexes(tx, table);
    }
    const rev = await tx.execute(sql`
      INSERT INTO udc_schema_revisions (collection, version, schema, active)
      VALUES (${table}, 1, ${JSON.stringify(storedSchema(schema))}::jsonb, true)
      ON CONFLICT DO NOTHING
      RETURNING id`);
    const revision = rev.rows.length > 0 ? "created" : "kept";
    // Activating revision 1 indexes its fields, as every later activation does.
    if (revision === "created") await syncFieldIndexes(tx, table, schema);

    const existing = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${t}`);
    if ((existing.rows[0]?.n ?? 0) > 0) return { table, inserted: 0, revision, skipped: true };

    // A seed row may fix its id in `__meta.id` (rows that others refer to); the rest get a random one.
    const res = await tx.execute(sql`
      INSERT INTO ${t} (id, data)
      SELECT COALESCE((value->'__meta'->>'id')::uuid, gen_random_uuid()), value - '__meta'
      FROM jsonb_array_elements(${JSON.stringify(rows)}::jsonb)`);
    return { table, inserted: res.rowCount ?? rows.length, revision, skipped: false };
  });
}
