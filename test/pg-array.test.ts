import { evaluateFilter, type FilterNode, SchemaDocSchema } from "@jsudc/core";
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { PostgresJsonbSource } from "../src/sources/postgres-jsonb.js";
import { rejectsWith, useTestDb } from "./helpers.js";

const schema = SchemaDocSchema.parse({
  version: "v1",
  fields: { title: { type: "string" }, tags: { type: "string_array" } },
});

const rows = [
  { title: "a", tags: ["ui", "Bug"] },
  { title: "b", tags: ["backend"] },
  { title: "c", tags: [] },
  { title: "d" },
  { title: "e", tags: null },
  { title: "f", tags: ["50%", "ui_kit"] },
];

const { db } = useTestDb();
const source = new PostgresJsonbSource({ db, table: "tasks", initialSchema: schema });

beforeAll(async () => {
  await db.execute(sql`truncate table tasks, udc_schema_revisions restart identity`);
  await db.execute(sql`
    insert into tasks (data) select value from jsonb_array_elements(${JSON.stringify(rows)}::jsonb)`);
});

const titles = async (filter: FilterNode) =>
  (await source.list({ filter, sort: [{ field: "title" }] })).rows.map((r) => r.title);

describe("array fields in SQL match evaluateFilter", () => {
  it.each<[string, FilterNode]>([
    ["in", { field: "tags", op: "in", value: ["ui", "backend"] }],
    ["in, case-insensitive", { field: "tags", op: "in", value: ["bug"], case_insensitive: true }],
    ["in, case-sensitive", { field: "tags", op: "in", value: ["bug"] }],
    ["not_in", { field: "tags", op: "not_in", value: ["ui"] }],
    ["not not_in", { not: { field: "tags", op: "not_in", value: ["ui"] } }],
    ["contains", { field: "tags", op: "contains", value: "ack" }],
    ["contains is literal", { field: "tags", op: "contains", value: "%" }],
    ["contains _ is literal", { field: "tags", op: "contains", value: "i_k" }],
    ["starts_with", { field: "tags", op: "starts_with", value: "u" }],
    ["ends_with, ci", { field: "tags", op: "ends_with", value: "UG", case_insensitive: true }],
    ["is_null", { field: "tags", op: "is_null" }],
    ["is_not_null", { field: "tags", op: "is_not_null" }],
  ])("%s", async (_, filter) => {
    const expected = rows.filter((r) => evaluateFilter(filter, r)).map((r) => r.title);
    expect(await titles(filter)).toEqual(expected);
  });

  it("refuses an ordered op", async () => {
    await rejectsWith(
      source.list({ filter: { field: "tags", op: "gt", value: "a" } }),
      "unsupported_op",
    );
  });
});
