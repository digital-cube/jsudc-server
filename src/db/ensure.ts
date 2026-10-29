import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import type { Db } from "./client.js";

/** `migrations/` of the package: the SQL every host database needs, numbered, plain. */
export const UDC_MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

/** The library's SQL files in the order they apply: `[{name, sql}]`. */
export function udcMigrations(): { name: string; sql: string }[] {
  return readdirSync(UDC_MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(UDC_MIGRATIONS_DIR, name), "utf8") }));
}

// Any constant: two processes starting at once take turns instead of racing the DDL.
const LOCK_KEY = 0x75_64_63;

/**
 * Create the objects the library owns (`udc_schema_revisions`, the
 * `udc_date` / `udc_timestamptz` functions) unless they exist: for a host
 * without migrations of its own. Safe to run at every start.
 */
export async function ensureUdcSchema(db: Db): Promise<string[]> {
  const applied: string[] = [];
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_KEY})`);
    for (const m of udcMigrations()) {
      await tx.execute(sql.raw(m.sql));
      applied.push(m.name);
    }
  });
  return applied;
}
