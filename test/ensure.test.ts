import { getTableColumns, getTableName, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ensureUdcSchema, udcMigrations } from "../src/db/ensure.js";
import { collectionTable, createCollectionTableSql } from "../src/db/schema.js";
import { useTestDb } from "./helpers.js";

const { db } = useTestDb();

describe("the UDC-owned SQL", () => {
  it("ships the numbered migrations in order", () => {
    expect(udcMigrations().map((m) => m.name)).toEqual([
      "0000_udc_schema_revisions.sql",
      "0001_udc_cast_functions.sql",
      "0002_udc_text_index_collation.sql",
    ]);
  });

  it("ensureUdcSchema runs them again without harm", async () => {
    expect(await ensureUdcSchema(db)).toEqual([
      "0000_udc_schema_revisions.sql",
      "0001_udc_cast_functions.sql",
      "0002_udc_text_index_collation.sql",
    ]);
    await ensureUdcSchema(db);
    const fns = await db.execute<{ d: string; t: string }>(
      sql`select udc_date('2026-10-29')::text as d, udc_timestamptz('2026-10-29T10:00:00')::text as t`,
    );
    expect(fns.rows[0]?.d).toBe("2026-10-29");
    expect(new Date(String(fns.rows[0]?.t)).toISOString()).toBe("2026-10-29T10:00:00.000Z");
    const idx = await db.execute<{ indexname: string }>(
      sql`select indexname from pg_indexes where tablename = 'udc_schema_revisions' order by 1`,
    );
    expect(idx.rows.map((r) => r.indexname)).toContain("udc_schema_revisions_one_active_idx");
  });
});

describe("collection tables", () => {
  it("collectionTable has the shape the jsonb source reads", () => {
    const t = collectionTable("things");
    expect(getTableName(t)).toBe("things");
    expect(Object.keys(getTableColumns(t))).toEqual([
      "id",
      "data",
      "version",
      "createdAt",
      "updatedAt",
    ]);
  });

  it("createCollectionTableSql makes the same table, idempotently, and refuses a bad name", async () => {
    await db.execute(sql`drop table if exists udc_ensure_probe`);
    await db.execute(sql.raw(createCollectionTableSql("udc_ensure_probe")));
    await db.execute(sql.raw(createCollectionTableSql("udc_ensure_probe")));
    const cols = await db.execute<{ column_name: string }>(sql`
      select column_name from information_schema.columns
      where table_name = 'udc_ensure_probe' order by ordinal_position`);
    expect(cols.rows.map((r) => r.column_name)).toEqual([
      "id",
      "data",
      "version",
      "created_at",
      "updated_at",
    ]);
    await db.execute(sql`drop table udc_ensure_probe`);
    expect(() => createCollectionTableSql('x"; drop table y; --')).toThrow(/invalid table name/);
  });
});
