import { SchemaDocSchema, UdcError } from "@jsudc/core";
import { beforeEach, describe, expect, it } from "vitest";
import { MemorySource } from "../src/sources/memory.js";

const schema = SchemaDocSchema.parse({
  version: "v1",
  fields: {
    name: { type: "string", required: true },
    employees: { type: "integer", min: 0 },
    city: { type: "string" },
    old: { type: "string", deleted: true },
  },
});

const rows = [
  { name: "Alfa", employees: 9, city: "Niš" },
  { name: "Beta", employees: 10, city: "Beograd" },
  { name: "Gama", employees: 100 },
  { name: "Delta", employees: 9, city: "Beograd" },
];

async function rejects(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(UdcError);
  expect((err as UdcError).code).toBe(code);
  return err as UdcError;
}

describe("MemorySource", () => {
  let src: MemorySource;
  beforeEach(() => {
    src = new MemorySource({ schema, rows, pageSizeDefault: 2 });
  });

  it("serves the schema and the memory capabilities", async () => {
    expect((await src.describe()).fields.name?.type).toBe("string");
    expect(src.capabilities).toMatchObject({ mutate: true, total_count: true, schema_edit: false });
    expect(src.capabilities.supported_filter_ops).toHaveLength(14);
  });

  it("assigns ids and version 1 to the initial rows", async () => {
    const { rows: out } = await src.list({ page: { limit: 10 } });
    expect(out).toHaveLength(4);
    for (const r of out) expect(r.__meta).toEqual({ id: expect.any(String), version: 1 });
  });

  it("filters with evaluateFilter and counts the filtered total", async () => {
    const out = await src.list({ filter: { field: "city", op: "eq", value: "Beograd" } });
    // Unsorted lists come in id order (random uuids), so compare as a set.
    expect(out.rows.map((r) => r.name).sort()).toEqual(["Beta", "Delta"]);
    expect(out.total).toBe(2);
    expect(out.next_cursor).toBeNull();
  });

  it("sorts numerically, nulls last, ties by id", async () => {
    const out = await src.list({
      sort: [{ field: "employees", dir: "desc" }],
      page: { limit: 10 },
    });
    expect(out.rows.map((r) => r.employees)).toEqual([100, 10, 9, 9]);
    const byCity = await src.list({ sort: [{ field: "city" }], page: { limit: 10 } });
    expect(byCity.rows.map((r) => r.city ?? null)).toEqual(["Beograd", "Beograd", "Niš", null]);
    const desc = await src.list({ sort: [{ field: "city", dir: "desc" }], page: { limit: 10 } });
    expect(desc.rows.map((r) => r.city ?? null)).toEqual(["Niš", "Beograd", "Beograd", null]);
  });

  it("pages by offset with the default page size", async () => {
    const p1 = await src.list({ sort: [{ field: "name" }] });
    const p2 = await src.list({ sort: [{ field: "name" }], page: { offset: 2 } });
    expect(p1.rows.map((r) => r.name)).toEqual(["Alfa", "Beta"]);
    expect(p2.rows.map((r) => r.name)).toEqual(["Delta", "Gama"]);
    expect(p1.total).toBe(4);
  });

  it("refuses a cursor: offset paging only", async () => {
    await rejects(src.list({ page: { cursor: "abc" } }), "unsupported_op");
  });

  it("refuses unknown and deleted fields in filter and sort", async () => {
    await rejects(src.list({ filter: { field: "nope", op: "is_null" } }), "validation_error");
    await rejects(src.list({ sort: [{ field: "old" }] }), "validation_error");
  });

  it("reads one row and answers not_found for an unknown id", async () => {
    const [first] = (await src.list({})).rows;
    expect((await src.read(first?.__meta.id as string)).name).toBe(first?.name);
    await rejects(src.read("missing"), "not_found");
  });

  it("inserts, updates with a version check and deletes", async () => {
    const created = await src.mutate({ op: "insert", row: { name: "Novi", employees: 1 } });
    expect(created.__meta.version).toBe(1);
    const id = created.__meta.id;

    const updated = await src.mutate({
      op: "update",
      id,
      row: { city: "Sombor" },
      expected_version: 1,
    });
    expect(updated).toMatchObject({ name: "Novi", city: "Sombor", __meta: { id, version: 2 } });

    const conflict = await rejects(
      src.mutate({ op: "update", id, row: { city: "Pirot" }, expected_version: 1 }),
      "version_conflict",
    );
    expect(conflict.details?.current_version).toBe(2);

    const deleted = await src.mutate({ op: "delete", id });
    expect(deleted.city).toBe("Sombor");
    await rejects(src.read(id), "not_found");
    await rejects(src.mutate({ op: "delete", id }), "not_found");
  });

  it("validates inserts and patches against the schema", async () => {
    const bad = await rejects(
      src.mutate({ op: "insert", row: { employees: -1 } }),
      "validation_error",
    );
    expect(bad.details?.problems).toEqual(
      expect.arrayContaining([
        { field: "employees", message: "must be >= 0" },
        { field: "name", message: "is required" },
      ]),
    );
    const [first] = (await src.list({})).rows;
    await rejects(
      src.mutate({ op: "update", id: first?.__meta.id, row: { unknown: 1 } }),
      "validation_error",
    );
    await rejects(src.mutate({ op: "update", row: { city: "x" } }), "validation_error");
    await rejects(src.mutate({ op: "update", id: "missing", row: { city: "x" } }), "not_found");
  });
});
