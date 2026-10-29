import { type ColumnConfig, SchemaDocSchema } from "@jsudc/core";
import { describe, expect, it } from "vitest";
import { deriveColumns } from "../src/columns.js";

const schema = (fields: Record<string, object>, field_order?: string[]) =>
  SchemaDocSchema.parse({ version: "v1", fields, field_order });

const S = { type: "string" };

describe("deriveColumns", () => {
  it("keeps the view's columns, styled and in file order, when every field is listed", () => {
    const cols: ColumnConfig[] = [
      { field: "b", width: 90, pin: "left" },
      { field: "a", editable: false },
    ];
    expect(deriveColumns(cols, schema({ a: S, b: S }), 160)).toEqual(cols);
  });

  it("appends a field missing from the view right after its field_order neighbour", () => {
    const cols: ColumnConfig[] = [{ field: "a" }, { field: "c" }];
    const out = deriveColumns(cols, schema({ a: S, b: S, c: S }), 160);
    expect(out.map((c) => c.field)).toEqual(["a", "b", "c"]);
    expect(out[1]).toEqual({ field: "b", width: 160, editable: true });
  });

  it("follows the nearest preceding field that has a column, skipping unlisted ones", () => {
    // field_order a, x, y, c; view lists c, a (reversed): x and y follow a.
    const cols: ColumnConfig[] = [{ field: "c" }, { field: "a" }];
    const out = deriveColumns(cols, schema({ a: S, x: S, y: S, c: S }), 100);
    expect(out.map((c) => c.field)).toEqual(["c", "a", "x", "y"]);
  });

  it("puts a field first when no earlier field in field_order has a column", () => {
    const cols: ColumnConfig[] = [{ field: "b" }, { field: "c" }];
    const out = deriveColumns(cols, schema({ a: S, z: S, b: S, c: S }), 100);
    expect(out.map((c) => c.field)).toEqual(["a", "z", "b", "c"]);
  });

  it("respects field_order, not the key order of fields", () => {
    const cols: ColumnConfig[] = [{ field: "a" }];
    const out = deriveColumns(cols, schema({ a: S, b: S, n: S }, ["n", "a", "b"]), 100);
    expect(out.map((c) => c.field)).toEqual(["n", "a", "b"]);
  });

  it("inserts after the last column of a field that backs two columns", () => {
    const cols: ColumnConfig[] = [
      { field: "a", id: "a1" },
      { field: "a", id: "a2" },
      { field: "c" },
    ];
    const out = deriveColumns(cols, schema({ a: S, b: S, c: S }), 100);
    expect(out.map((c) => c.id ?? c.field)).toEqual(["a1", "a2", "b", "c"]);
  });

  it("drops deleted fields, listed or not", () => {
    const cols: ColumnConfig[] = [{ field: "a" }, { field: "gone" }];
    const out = deriveColumns(
      cols,
      schema({
        a: S,
        gone: { type: "string", deleted: true },
        hidden: { type: "string", deleted: true },
      }),
      100,
    );
    expect(out.map((c) => c.field)).toEqual(["a"]);
  });

  it("derives every column when the view lists none", () => {
    const out = deriveColumns([], schema({ a: S, b: S }), 120);
    expect(out).toEqual([
      { field: "a", width: 120, editable: true },
      { field: "b", width: 120, editable: true },
    ]);
  });

  it("keeps a column whose field is not in the schema at all", () => {
    const cols: ColumnConfig[] = [{ field: "computed" }, { field: "a" }];
    expect(deriveColumns(cols, schema({ a: S }), 100).map((c) => c.field)).toEqual([
      "computed",
      "a",
    ]);
  });
});
