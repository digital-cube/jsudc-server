import {
  ACTIONS,
  type DescribeResponse,
  type ListResponse,
  type Row,
  type SchemaDoc,
  UdcError,
} from "@jsudc/core";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDispatcher } from "../src/dispatcher.js";
import { CollectionRegistry, readCollectionAssets } from "../src/registry.js";
import { writeSchemaRevision } from "../src/schema-store.js";
import { seedCollection } from "../src/seed.js";
import { dropFieldIndexes, indexName } from "../src/sources/indexes.js";
import { compileSort, orderBy } from "../src/sources/sql.js";
import {
  COLLECTIONS_DIR,
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
const asset = readCollectionAssets(COLLECTIONS_DIR).find((a) => a.name === "companies");
if (!asset) throw new Error("companies collection missing");
const registry = new CollectionRegistry();
registry.register({ name: "companies", source, view: asset.view });
const log = { error: vi.fn() };
const dispatcher = createDispatcher(registry, { log });

async function call(action: string, payload: unknown) {
  return dispatcher.dispatch({ kind: `udc.${action}`, id: "t", payload });
}

async function ok<T = { schema: SchemaDoc }>(action: string, payload: object): Promise<T> {
  const res = await call(action, { collection: "companies", ...payload });
  expect(res.kind, JSON.stringify(res.payload)).toBe(`udc.${action}.ok`);
  return res.payload as T;
}

async function err(action: string, payload: object, code: string) {
  const res = await call(action, { collection: "companies", ...payload });
  expect(res.kind).toBe(`udc.${action}.err`);
  expect(res.payload, JSON.stringify(res.payload)).toMatchObject({ code });
  return res.payload as { code: string; message: string; details?: unknown };
}

const addField = (name: string, fielddef: object, position: object = { where: "end" }) =>
  ok("schema.add_field", { name, fielddef, position });
const updateField = (name: string, fielddef: object) =>
  ok("schema.update_field", { name, fielddef });
const softDelete = (field: string) => ok("schema.soft_delete_field", { field });
const describeIt = () => ok<DescribeResponse>("describe", {});
const list = (payload: object) => ok<ListResponse>("list", payload);

const revisions = async () =>
  (
    await db.execute<{ version: number; active: boolean }>(
      sql`select version, active from udc_schema_revisions
          where collection = 'companies' order by version`,
    )
  ).rows;

const indexDef = async (name: string) =>
  (
    await db.execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes where tablename = 'companies' and indexname = ${name}`,
    )
  ).rows[0]?.indexdef ?? null;

beforeEach(async () => {
  await resetTables(db);
  await dropFieldIndexes(db, "companies");
  await seedCollection(db, {
    table: "companies",
    schema: companiesSchemaJson,
    rows: companiesSeed,
    limit: 20,
  });
  log.error.mockClear();
});

describe("schema.add_field", () => {
  it("writes v2 with the field where asked and returns the SchemaDoc", async () => {
    const res = await addField(
      "website",
      { type: "string", length: 120 },
      { where: "after", anchor: "name" },
    );
    expect(ACTIONS["schema.add_field"].response.safeParse(res).success).toBe(true);
    expect(res.schema.version).toBe("v2");
    expect(res.schema.fields.website).toEqual({ type: "string", length: 120 });
    expect(res.schema.field_order).toEqual([
      "pib",
      "name",
      "website",
      ...companiesSchema.field_order.slice(2),
    ]);
  });

  it("shows up in describe: fields, field_order, filterable and a derived column", async () => {
    await addField("website", { type: "string", length: 120 }, { where: "after", anchor: "name" });
    const d = await describeIt();
    expect(d.schema.version).toBe("v2");
    expect(d.schema.fields.website).toEqual({ type: "string", length: 120 });
    expect(d.schema.field_order.indexOf("website")).toBe(d.schema.field_order.indexOf("name") + 1);
    expect(d.filterable.fields.map((f) => f.field)).toContain("website");
    const cols = d.view.columns.map((c) => c.field);
    expect(cols.indexOf("website")).toBe(cols.indexOf("name") + 1);
    expect(d.view.columns[cols.indexOf("website")]).toEqual({
      field: "website",
      width: 160,
      editable: true,
    });
  });

  it("places the derived column for before and end too", async () => {
    await addField("first", { type: "string" }, { where: "before", anchor: "pib" });
    await addField("last", { type: "integer" });
    const d = await describeIt();
    expect(d.schema.field_order[0]).toBe("first");
    expect(d.schema.field_order.at(-1)).toBe("last");
    const cols = d.view.columns.map((c) => c.field);
    expect(cols[0]).toBe("first");
    expect(cols.at(-1)).toBe("last");
  });

  it("is filterable and sortable at once; old rows count as null and sort last", async () => {
    await addField("website", { type: "string" }, { where: "after", anchor: "name" });
    const nulls = await list({ filter: { field: "website", op: "is_null" } });
    expect(nulls.total).toBe(20);

    const [first] = (await list({ sort: [{ field: "pib" }], page: { limit: 1 } })).rows as [Row];
    await ok("mutate", { op: "update", id: first.__meta.id, row: { website: "b.rs" } });
    const inserted = await ok<{ row: Row }>("mutate", {
      op: "insert",
      row: { name: "Web Firma", website: "a.rs" },
    });

    const asc = await list({ sort: [{ field: "website", dir: "asc" }], page: { limit: 3 } });
    expect(asc.rows.map((r) => r.website)).toEqual(["a.rs", "b.rs", undefined]);
    const desc = await list({ sort: [{ field: "website", dir: "desc" }], page: { limit: 3 } });
    expect(desc.rows.map((r) => r.website)).toEqual(["b.rs", "a.rs", undefined]);

    const eq = await list({ filter: { field: "website", op: "eq", value: "a.rs" } });
    expect(eq.rows.map((r) => r.__meta.id)).toEqual([inserted.row.__meta.id]);
  });

  it("numbers revisions v1 → v2 → v3, one active, old ones kept", async () => {
    expect(await revisions()).toEqual([{ version: 1, active: true }]);
    expect((await addField("a", { type: "string" })).schema.version).toBe("v2");
    expect(await revisions()).toEqual([
      { version: 1, active: false },
      { version: 2, active: true },
    ]);
    expect((await addField("b", { type: "integer" })).schema.version).toBe("v3");
    expect(await revisions()).toEqual([
      { version: 1, active: false },
      { version: 2, active: false },
      { version: 3, active: true },
    ]);
    const v2 = await db.execute<{ schema: { fields: Record<string, unknown> } }>(
      sql`select schema from udc_schema_revisions where collection = 'companies' and version = 2`,
    );
    expect(Object.keys(v2.rows[0]?.schema.fields ?? {})).toContain("a");
    expect(Object.keys(v2.rows[0]?.schema.fields ?? {})).not.toContain("b");
  });

  it("starts from schema.json when the collection has no revision yet", async () => {
    await db.execute(sql`delete from udc_schema_revisions`);
    expect((await addField("a", { type: "string" })).schema.version).toBe("v2");
    expect(await revisions()).toEqual([
      { version: 1, active: false },
      { version: 2, active: true },
    ]);
  });

  it.each([
    [
      "an existing name",
      { name: "city", fielddef: { type: "string" }, position: { where: "end" } },
    ],
    ["a bad name", { name: "Web-Site", fielddef: { type: "string" }, position: { where: "end" } }],
    [
      "an unknown anchor",
      { name: "web", fielddef: { type: "string" }, position: { where: "after", anchor: "nope" } },
    ],
    [
      "before without an anchor",
      { name: "web", fielddef: { type: "string" }, position: { where: "before" } },
    ],
  ])("refuses %s with validation_error", async (_, payload) => {
    await err("schema.add_field", payload, "validation_error");
    expect(await revisions()).toHaveLength(1);
  });

  it("refuses a type that is not storable yet with unsupported_op", async () => {
    const e = await err(
      "schema.add_field",
      { name: "logo", fielddef: { type: "image" }, position: { where: "end" } },
      "unsupported_op",
    );
    expect(e.message).toMatch(/not storable yet/);
  });

  it("refuses an unknown collection with not_found", async () => {
    await err(
      "schema.add_field",
      { collection: "nope", name: "a", fielddef: { type: "string" }, position: { where: "end" } },
      "not_found",
    );
  });
});

describe("schema.update_field", () => {
  it("replaces the def in a new revision without moving the field", async () => {
    const res = await updateField("city", {
      type: "string",
      length: 100,
      required: true,
      label: { en: "City", sr: "Grad" },
    });
    expect(res.schema.version).toBe("v2");
    expect(res.schema.fields.city).toEqual({
      type: "string",
      length: 100,
      required: true,
      label: { en: "City", sr: "Grad" },
    });
    expect(res.schema.field_order).toEqual(companiesSchema.field_order);
    expect((await describeIt()).schema.fields.city?.length).toBe(100);
  });

  it("refuses a type change with unsupported_op", async () => {
    await err(
      "schema.update_field",
      { name: "city", fielddef: { type: "text" } },
      "unsupported_op",
    );
    expect(await revisions()).toHaveLength(1);
  });

  it("refuses an unknown or soft-deleted field with not_found", async () => {
    await err("schema.update_field", { name: "nope", fielddef: { type: "string" } }, "not_found");
    await softDelete("city");
    await err("schema.update_field", { name: "city", fielddef: { type: "string" } }, "not_found");
  });
});

describe("schema.soft_delete_field", () => {
  it("hides the field everywhere but keeps its place and its data", async () => {
    const res = await softDelete("city");
    expect(res.schema.version).toBe("v2");
    expect(res.schema.fields.city).toMatchObject({ type: "string", deleted: true });
    expect(res.schema.field_order).toEqual(companiesSchema.field_order);

    const d = await describeIt();
    expect(d.schema.fields.city).toBeUndefined();
    expect(d.schema.field_order).not.toContain("city");
    expect(d.view.columns.map((c) => c.field)).not.toContain("city");
    expect(d.filterable.fields.map((f) => f.field)).not.toContain("city");

    await err("list", { filter: { field: "city", op: "is_not_null" } }, "validation_error");
    await err("list", { sort: [{ field: "city" }] }, "validation_error");
    await err("mutate", { op: "insert", row: { name: "X", city: "Niš" } }, "validation_error");
    await err(
      "schema.add_field",
      { name: "city", fielddef: { type: "string" }, position: { where: "end" } },
      "validation_error",
    );

    const stored = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from companies where data ? 'city'`,
    );
    expect(stored.rows[0]?.n).toBe(20);
    // Rows still read back whole: the data was never touched.
    const [row] = (await list({ page: { limit: 1 } })).rows as [Row];
    expect(typeof row.city).toBe("string");
  });

  it("refuses an unknown or already-deleted field with not_found", async () => {
    await err("schema.soft_delete_field", { field: "nope" }, "not_found");
    await softDelete("city");
    await err("schema.soft_delete_field", { field: "city" }, "not_found");
    expect(await revisions()).toHaveLength(2);
  });
});

describe("mutate after a schema edit", () => {
  it("enforces a new required field on insert and on patches that touch it only", async () => {
    await addField("vat_id", { type: "string", required: true });
    const [row] = (await list({ sort: [{ field: "pib" }], page: { limit: 1 } })).rows as [Row];

    const patched = await ok<{ row: Row }>("mutate", {
      op: "update",
      id: row.__meta.id,
      row: { city: "Pirot" },
    });
    expect(patched.row.city).toBe("Pirot");

    await err("mutate", { op: "insert", row: { name: "Bez PIB-a" } }, "validation_error");
    await err(
      "mutate",
      { op: "update", id: row.__meta.id, row: { vat_id: null } },
      "validation_error",
    );
    await ok("mutate", { op: "insert", row: { name: "Sa PIB-om", vat_id: "RS1" } });
  });

  it("validates values against the new revision's def", async () => {
    await addField("staff", { type: "integer", min: 0 });
    await err("mutate", { op: "insert", row: { name: "X", staff: -1 } }, "validation_error");
    await updateField("staff", { type: "integer", min: -5 });
    await ok("mutate", { op: "insert", row: { name: "X", staff: -1 } });
  });
});

describe("jsonb indexes", () => {
  it("are named <table>_data_<field>_idx, hashed instead of truncated past 63 chars", () => {
    expect(indexName("companies", "employees")).toBe("companies_data_employees_idx");
    const long = indexName("companies", `f${"x".repeat(60)}`);
    const other = indexName("companies", `f${"x".repeat(59)}y`);
    expect(long).toHaveLength(63);
    expect(long).toMatch(/^companies_data_fx+_[0-9a-f]{8}_idx$/);
    expect(long).not.toBe(other);
  });

  it("drops long-named indexes on reseed too", async () => {
    const field = `f${"x".repeat(60)}`;
    await addField(field, { type: "integer", index: true });
    expect(await indexDef(indexName("companies", field))).not.toBeNull();
    expect(await dropFieldIndexes(db, "companies")).toContain(indexName("companies", field));
    expect(await indexDef(indexName("companies", field))).toBeNull();
  });

  it("are created for the indexed fields of schema.json on seeding", async () => {
    expect(await indexDef("companies_data_employees_idx")).toContain("::numeric");
    expect(await indexDef("companies_data_name_idx")).not.toBeNull();
    // founded has no index: true
    expect(await indexDef("companies_data_founded_idx")).toBeNull();
  });

  it("uses the numeric cast for an integer field and none for a string field", async () => {
    await addField("staff", { type: "integer", index: true });
    await addField("website", { type: "string", index: true });
    expect(await indexDef("companies_data_staff_idx")).toMatch(
      /\(\(\(data ->> 'staff'::text\)\)::numeric\)/,
    );
    const web = await indexDef("companies_data_website_idx");
    expect(web).toContain("(data ->> 'website'::text)");
    expect(web).not.toContain("::numeric");
  });

  it("indexes date, datetime and bool through immutable expressions", async () => {
    await addField("since", { type: "date", index: true });
    await addField("seen_at", { type: "datetime", index: true });
    await addField("vip", { type: "bool", index: true });
    expect(await indexDef("companies_data_since_idx")).toContain("udc_date(");
    expect(await indexDef("companies_data_seen_at_idx")).toContain("udc_timestamptz(");
    expect(await indexDef("companies_data_vip_idx")).toContain("::boolean");
  });

  it("gives a json field no index, and drops the index when index flips to false", async () => {
    await addField("meta", { type: "json", index: true });
    expect(await indexDef("companies_data_meta_idx")).toBeNull();

    await addField("staff", { type: "integer", index: true });
    expect(await indexDef("companies_data_staff_idx")).not.toBeNull();
    await updateField("staff", { type: "integer", index: false });
    expect(await indexDef("companies_data_staff_idx")).toBeNull();
    await updateField("staff", { type: "integer", index: true });
    expect(await indexDef("companies_data_staff_idx")).not.toBeNull();
  });

  it("drops the index of a soft-deleted field", async () => {
    await softDelete("employees");
    expect(await indexDef("companies_data_employees_idx")).toBeNull();
  });

  it.each([
    ["employees", "companies_data_employees_idx"],
    ["founded", "companies_data_founded_idx"],
  ])("match the expression the query compiler sorts %s by", async (field, index) => {
    if (field === "founded") await updateField("founded", { type: "date", index: true });
    const [term] = compileSort([{ field, dir: "asc" }], await source.describe());
    const plan = await db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      await tx.execute(sql`set local enable_sort = off`);
      return tx.execute<{ "QUERY PLAN": string }>(
        sql`explain select id from companies order by ${orderBy(term ? [term] : [])} limit 5`,
      );
    });
    expect(plan.rows.map((r) => r["QUERY PLAN"]).join("\n")).toContain(index);
  });
});

describe("concurrent edits", () => {
  it("two parallel add_field calls make two revisions, one active, both fields kept", async () => {
    const [a, b] = await Promise.all([
      call("schema.add_field", {
        collection: "companies",
        name: "alpha",
        fielddef: { type: "string", index: true },
        position: { where: "end" },
      }),
      call("schema.add_field", {
        collection: "companies",
        name: "beta",
        fielddef: { type: "integer", index: true },
        position: { where: "after", anchor: "name" },
      }),
    ]);
    expect(a?.kind).toBe("udc.schema.add_field.ok");
    expect(b?.kind).toBe("udc.schema.add_field.ok");
    expect(log.error).not.toHaveBeenCalled();
    expect(await revisions()).toEqual([
      { version: 1, active: false },
      { version: 2, active: false },
      { version: 3, active: true },
    ]);
    const d = await describeIt();
    expect(d.schema.fields.alpha).toBeDefined();
    expect(d.schema.fields.beta).toBeDefined();
  });

  it("five parallel edits all land", async () => {
    const names = ["f1", "f2", "f3", "f4", "f5"];
    const res = await Promise.all(
      names.map((n) =>
        call("schema.add_field", {
          collection: "companies",
          name: n,
          fielddef: { type: "string" },
          position: { where: "end" },
        }),
      ),
    );
    expect(res.map((r) => r.kind)).toEqual(names.map(() => "udc.schema.add_field.ok"));
    const d = await describeIt();
    expect(d.schema.version).toBe("v6");
    expect(d.schema.field_order.slice(-5).sort()).toEqual(names);
  });
});

describe("writeSchemaRevision", () => {
  const conflictingRevision = (version: number) =>
    db.execute(sql`
      insert into udc_schema_revisions (collection, version, schema, active)
      values ('companies', ${version}, ${JSON.stringify(companiesSchema)}::jsonb, false)`);

  it("retries once when another writer took the version number", async () => {
    let attempts = 0;
    const res = await writeSchemaRevision(db, {
      collection: "companies",
      initial: companiesSchema,
      edit: async (current) => {
        attempts += 1;
        // A writer that does not take the lock (another tool) commits v2 under our feet.
        if (attempts === 1) await conflictingRevision(2);
        return { schema: { ...current, field_order: [...current.field_order] }, touched: [] };
      },
    });
    expect(attempts).toBe(2);
    expect(res.version).toBe("v3");
    expect(await revisions()).toEqual([
      { version: 1, active: false },
      { version: 2, active: false },
      { version: 3, active: true },
    ]);
  });

  it("gives up with version_conflict when the retry conflicts too", async () => {
    let attempts = 0;
    const p = writeSchemaRevision(db, {
      collection: "companies",
      initial: companiesSchema,
      edit: async (current) => {
        attempts += 1;
        await conflictingRevision(attempts + 1);
        return { schema: current, touched: [] };
      },
    });
    const e = await rejectsWith(p, "version_conflict");
    expect(e).toBeInstanceOf(UdcError);
    expect(attempts).toBe(2);
    expect((await revisions()).filter((r) => r.active)).toEqual([{ version: 1, active: true }]);
  });

  it("lets any other database error through", async () => {
    await expect(
      writeSchemaRevision(db, {
        collection: "companies",
        initial: companiesSchema,
        edit: async () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");
  });
});

describe("PostgresJsonbSource schema methods", () => {
  it("are callable directly, as the dispatcher does", async () => {
    const added = await source.addField({
      name: "web",
      fielddef: { type: "string" },
      position: { where: "end" },
    });
    expect(added.version).toBe("v2");
    expect(
      (await source.updateField({ name: "web", fielddef: { type: "string", length: 9 } })).version,
    ).toBe("v3");
    expect((await source.softDeleteField("web")).fields.web?.deleted).toBe(true);
    await rejectsWith(source.softDeleteField("web"), "not_found");
  });
});
