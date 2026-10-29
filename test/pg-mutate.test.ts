import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { seedCollection } from "../src/seed.js";
import { PostgresJsonbSource } from "../src/sources/postgres-jsonb.js";
import {
  activateSchema,
  companiesSchema,
  companiesSchemaJson,
  companiesSeed,
  companiesSource,
  rejectsWith,
  resetTables,
  useTestDb,
} from "./helpers.js";

const { db } = useTestDb();
const source = companiesSource(db);
const MISSING = "00000000-0000-4000-8000-000000000000";

beforeEach(async () => {
  await resetTables(db);
  await seedCollection(db, {
    table: "companies",
    schema: companiesSchemaJson,
    rows: companiesSeed,
    limit: 20,
  });
});

async function firstRow() {
  const [row] = (await source.list({ sort: [{ field: "pib" }], page: { limit: 1 } })).rows;
  if (!row) throw new Error("no rows");
  return row;
}

describe("mutate insert", () => {
  it("writes data at version 1 and returns the row", async () => {
    const row = await source.mutate({
      op: "insert",
      row: {
        name: "Nova Firma DOO",
        city: "Pirot",
        employees: 3,
        __meta: { id: "forged", version: 9 },
      },
    });
    expect(row).toEqual({
      __meta: { id: expect.stringMatching(/^[0-9a-f-]{36}$/), version: 1 },
      name: "Nova Firma DOO",
      city: "Pirot",
      employees: 3,
    });
    expect(await source.read(row.__meta.id)).toEqual(row);
    expect((await source.list({})).total).toBe(21);
  });

  it("refuses an invalid row with every problem listed", async () => {
    const err = await rejectsWith(
      source.mutate({ op: "insert", row: { employees: -1, founded: "1.1.2000", extra: 1 } }),
      "validation_error",
    );
    expect(err.details?.problems).toEqual(
      expect.arrayContaining([
        { field: "employees", message: "must be >= 0" },
        { field: "founded", message: "must be a date (YYYY-MM-DD)" },
        { field: "extra", message: "unknown field" },
        { field: "name", message: "is required" },
      ]),
    );
    expect((await source.list({})).total).toBe(20);
  });
});

describe("mutate update", () => {
  it("merges the patch into data, bumps the version and updated_at", async () => {
    const before = await firstRow();
    const [{ updated_at: t0 } = { updated_at: "" }] = (
      await db.execute<{ updated_at: string }>(
        sql`select updated_at::text from companies where id = ${before.__meta.id}::uuid`,
      )
    ).rows;
    const after = await source.mutate({
      op: "update",
      id: before.__meta.id,
      row: { employees: 4321, city: "Vranje" },
      expected_version: 1,
    });
    expect(after).toEqual({
      ...before,
      employees: 4321,
      city: "Vranje",
      __meta: { id: before.__meta.id, version: 2 },
    });
    const [{ updated_at: t1 } = { updated_at: "" }] = (
      await db.execute<{ updated_at: string }>(
        sql`select updated_at::text from companies where id = ${before.__meta.id}::uuid`,
      )
    ).rows;
    expect(t1 > t0).toBe(true);
    // Without expected_version the update is unconditional.
    const again = await source.mutate({
      op: "update",
      id: before.__meta.id,
      row: { active: false },
    });
    expect(again.__meta.version).toBe(3);
  });

  it("answers version_conflict with the current version and changes nothing", async () => {
    const row = await firstRow();
    await source.mutate({ op: "update", id: row.__meta.id, row: { city: "Niš" } });
    const err = await rejectsWith(
      source.mutate({
        op: "update",
        id: row.__meta.id,
        row: { city: "Sombor" },
        expected_version: 1,
      }),
      "version_conflict",
    );
    expect(err.details).toMatchObject({ current_version: 2, expected_version: 1 });
    expect(await source.read(row.__meta.id)).toMatchObject({ city: "Niš", __meta: { version: 2 } });
  });

  it("lets exactly one of two concurrent edits of the same version win", async () => {
    const row = await firstRow();
    const results = await Promise.allSettled(
      ["Šabac", "Užice"].map((city) =>
        source.mutate({ op: "update", id: row.__meta.id, row: { city }, expected_version: 1 }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason.code).toBe("version_conflict");
    expect((await source.read(row.__meta.id)).__meta.version).toBe(2);
  });

  it("validates the patch: types, unknown fields, required only when touched", async () => {
    const row = await firstRow();
    const err = await rejectsWith(
      source.mutate({ op: "update", id: row.__meta.id, row: { employees: "many", nope: 1 } }),
      "validation_error",
    );
    expect(err.details?.problems).toHaveLength(2);
    await rejectsWith(
      source.mutate({ op: "update", id: row.__meta.id, row: { name: "" } }),
      "validation_error",
    );
    // A patch that does not touch the required `name` is fine.
    await source.mutate({ op: "update", id: row.__meta.id, row: { city: "Pirot" } });
  });

  it("needs an id and answers not_found for an unknown or malformed one", async () => {
    await rejectsWith(source.mutate({ op: "update", row: { city: "x" } }), "validation_error");
    await rejectsWith(
      source.mutate({ op: "update", id: MISSING, row: { city: "x" } }),
      "not_found",
    );
    await rejectsWith(source.mutate({ op: "update", id: "nope", row: { city: "x" } }), "not_found");
  });
});

describe("mutate delete", () => {
  it("returns the deleted row, then the id is gone", async () => {
    const row = await firstRow();
    expect(await source.mutate({ op: "delete", id: row.__meta.id })).toEqual(row);
    await rejectsWith(source.read(row.__meta.id), "not_found");
    await rejectsWith(source.mutate({ op: "delete", id: row.__meta.id }), "not_found");
    expect((await source.list({})).total).toBe(19);
  });

  it("honours expected_version and needs an id", async () => {
    const row = await firstRow();
    await rejectsWith(
      source.mutate({ op: "delete", id: row.__meta.id, expected_version: 5 }),
      "version_conflict",
    );
    await rejectsWith(source.mutate({ op: "delete" }), "validation_error");
  });
});

describe("read", () => {
  it("answers not_found for an unknown or malformed id", async () => {
    await rejectsWith(source.read(MISSING), "not_found");
    await rejectsWith(source.read("1; select 1"), "not_found");
  });
});

describe("schema revisions (read side)", () => {
  it("describe serves the active revision with the wire version v<n>", async () => {
    expect((await source.describe()).version).toBe("v1");
    await activateSchema(
      db,
      {
        ...companiesSchemaJson,
        fields: { ...companiesSchemaJson.fields, web: { type: "string" } },
      },
      3,
    );
    const schema = await source.describe();
    expect(schema.version).toBe("v3");
    expect(schema.field_order.at(-1)).toBe("web");
    // list and mutate use it too: the new field is allowed.
    const row = await source.mutate({
      op: "insert",
      row: { name: "Web DOO", web: "https://x.rs" },
    });
    const found = await source.list({ filter: { field: "web", op: "is_not_null" } });
    expect(found.rows.map((r) => r.__meta.id)).toEqual([row.__meta.id]);
  });

  it("falls back to the initial schema.json when no revision is active", async () => {
    await resetTables(db);
    const schema = await source.describe();
    expect(schema.version).toBe("v1");
    expect(schema.fields).toEqual(companiesSchema.fields);
  });

  it("refuses an active revision with core fields", async () => {
    await activateSchema(db, { ...companiesSchemaJson, core_fields: ["name"] }, 2);
    const err = await rejectsWith(source.describe(), "unsupported_op");
    expect(err.message).toContain("core_fields");
  });

  it("refuses core fields and bad table names at construction", () => {
    expect(
      () =>
        new PostgresJsonbSource({
          db,
          table: "companies",
          initialSchema: { ...companiesSchema, core_fields: ["pib"] },
        }),
    ).toThrow(/core_fields/);
    expect(
      () => new PostgresJsonbSource({ db, table: 'x"; drop', initialSchema: companiesSchema }),
    ).toThrow(/table name/);
  });
});
