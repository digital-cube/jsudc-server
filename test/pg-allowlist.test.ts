import type { FilterNode, SortKey } from "@jsudc/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activateSchema,
  companiesSchemaJson,
  companiesSource,
  insertRows,
  rejectsWith,
  resetTables,
  useTestDb,
} from "./helpers.js";

const handle = useTestDb();
const source = companiesSource(handle.db);

beforeAll(async () => {
  await resetTables(handle.db);
  await activateSchema(handle.db, {
    ...companiesSchemaJson,
    fields: { ...companiesSchemaJson.fields, legacy: { type: "string", deleted: true } },
  });
  await insertRows(handle.db, [{ name: "Alfa DOO", legacy: "x" }]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const INJECTION = "x'); drop table companies; --";

const BAD: [string, { filter?: FilterNode; sort?: SortKey[] }, string][] = [
  ["unknown field in filter", { filter: { field: "nope", op: "eq", value: 1 } }, "nope"],
  ["deleted field in filter", { filter: { field: "legacy", op: "is_null" } }, "legacy"],
  ["injection in filter", { filter: { field: INJECTION, op: "eq", value: 1 } }, INJECTION],
  [
    "injection nested in a group",
    {
      filter: {
        and: [{ field: "name", op: "is_not_null" }, { not: { field: INJECTION, op: "is_null" } }],
      },
    },
    INJECTION,
  ],
  ["unknown field in sort", { sort: [{ field: "nope" }] }, "nope"],
  ["deleted field in sort", { sort: [{ field: "legacy", dir: "desc" }] }, "legacy"],
  ["injection in sort", { sort: [{ field: INJECTION }] }, INJECTION],
  ["uppercase name (fails FIELD_NAME_RE)", { sort: [{ field: "Name" }] }, "Name"],
  ["__meta is not a field", { filter: { field: "__meta", op: "is_null" } }, "__meta"],
];

describe("field allowlist", () => {
  it.each(BAD)("%s → validation_error, no row query runs", async (_, req, field) => {
    const query = vi.spyOn(handle.pool, "query");
    const err = await rejectsWith(source.list(req), "validation_error");
    expect(err.details?.field).toBe(field);
    expect(err.message).toContain(JSON.stringify(field));
    // Only the active-schema lookup may have run; nothing touched the rows.
    const texts = query.mock.calls.map(([q]) =>
      typeof q === "string" ? q : (q as { text: string }).text,
    );
    expect(texts.every((t) => !/from "companies"/i.test(t))).toBe(true);
    expect(texts.join("\n")).not.toContain("drop table");
  });

  it("the table is intact afterwards", async () => {
    const res = await source.list({ filter: { field: "name", op: "eq", value: "Alfa DOO" } });
    expect(res.total).toBe(1);
  });
});
