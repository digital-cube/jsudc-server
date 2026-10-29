import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { seedCollection } from "../src/seed.js";
import {
  companiesSchema,
  companiesSchemaJson,
  companiesSeed,
  companiesSource,
  resetTables,
  useTestDb,
} from "./helpers.js";

const { db } = useTestDb();
const source = companiesSource(db);
const seed = (opts: { reset?: boolean; limit?: number } = {}) =>
  seedCollection(db, {
    table: "companies",
    schema: companiesSchemaJson,
    rows: companiesSeed,
    ...opts,
  });

const revisions = async () =>
  (
    await db.execute<{ version: number; active: boolean }>(
      sql`select version, active from udc_schema_revisions where collection = 'companies'`,
    )
  ).rows;

const indexNames = async () =>
  (
    await db.execute<{ indexname: string }>(
      sql`select indexname from pg_indexes where tablename = 'companies' order by indexname`,
    )
  ).rows.map((r) => r.indexname);

beforeEach(() => resetTables(db));

describe("seedCollection", () => {
  it("writes schema.json as active revision 1 and every seed row", async () => {
    expect(await seed()).toEqual({
      table: "companies",
      inserted: 30,
      revision: "created",
      skipped: false,
    });
    expect(await revisions()).toEqual([{ version: 1, active: true }]);
    expect((await source.list({})).total).toBe(30);
    // field_order survives jsonb, which does not keep key order.
    const schema = await source.describe();
    expect(schema.field_order).toEqual(companiesSchema.field_order);
    expect(schema.field_order[0]).toBe("pib");
  });

  it("leaves a seeded collection alone without --reset", async () => {
    await seed({ limit: 5 });
    expect(await seed()).toMatchObject({ inserted: 0, revision: "kept", skipped: true });
    expect((await source.list({})).total).toBe(5);
  });

  it("--reset truncates first, --limit caps the rows", async () => {
    await seed();
    expect(await seed({ reset: true, limit: 20 })).toMatchObject({
      inserted: 20,
      revision: "created",
    });
    expect((await source.list({})).total).toBe(20);
    expect(await revisions()).toHaveLength(1);
  });

  it("--reset drops later revisions and their indexes, back to schema.json as v1", async () => {
    await seed({ limit: 5 });
    await source.addField({
      name: "website",
      fielddef: { type: "string", index: true },
      position: { where: "end" },
    });
    await source.softDeleteField("city");
    expect(await revisions()).toHaveLength(3);
    expect(await indexNames()).toContain("companies_data_website_idx");

    await seed({ reset: true, limit: 5 });
    expect(await revisions()).toEqual([{ version: 1, active: true }]);
    const schema = await source.describe();
    expect(schema.version).toBe("v1");
    expect(schema.fields.website).toBeUndefined();
    expect(schema.fields.city?.deleted).toBeUndefined();
    const names = await indexNames();
    expect(names).not.toContain("companies_data_website_idx");
    expect(names).toContain("companies_data_city_idx");
  });

  it("refuses an invalid seed row and writes nothing", async () => {
    await expect(
      seedCollection(db, {
        table: "companies",
        schema: companiesSchemaJson,
        rows: [{ employees: 1 }],
      }),
    ).rejects.toThrow(/seed row 0/);
    expect(await revisions()).toEqual([]);
  });

  it("has a fixture seed of the companies' shape", () => {
    expect(companiesSeed).toHaveLength(30);
    const inactive = companiesSeed.filter((r) => r.active === false).length;
    expect(inactive).toBeGreaterThanOrEqual(1);
    expect(inactive).toBeLessThanOrEqual(10);
    for (const r of companiesSeed) {
      expect(r.pib).toMatch(/^\d{9}$/);
      expect(r.mb).toMatch(/^\d{8}$/);
      expect((r.founded as string) >= "1990-01-01" && (r.founded as string) <= "2024-12-31").toBe(
        true,
      );
    }
    expect(new Set(companiesSeed.map((r) => r.pib)).size).toBe(30);
  });

  it("keeps a fixed __meta.id and stores the row without it", async () => {
    const fixed = "0b8c3c4e-1f6a-4d2b-9a57-3e1f2b9c7d10";
    const res = await seedCollection(db, {
      table: "companies",
      schema: companiesSchemaJson,
      rows: [{ __meta: { id: fixed }, ...companiesSeed[0] }, ...companiesSeed.slice(1, 3)],
    });
    expect(res.inserted).toBe(3);
    const row = await source.read(fixed);
    expect(row).toMatchObject({ __meta: { id: fixed, version: 1 }, name: companiesSeed[0]?.name });
    const stored = await db.execute<{ data: Record<string, unknown> }>(
      sql`select data from companies where id = ${fixed}::uuid`,
    );
    expect(stored.rows[0]?.data).not.toHaveProperty("__meta");
    // Activating revision 1 indexes its `index: true` fields.
    expect(await indexNames()).toEqual(
      expect.arrayContaining(["companies_data_city_idx", "companies_data_employees_idx"]),
    );
  });
});
