import { SchemaDocSchema, ViewConfigSchema } from "@jsudc/core";
import { describe, expect, it } from "vitest";
import { buildDescribe, filterableFields, sortableFields } from "../src/describe.js";

const schema = SchemaDocSchema.parse({
  version: "v1",
  fields: {
    name: { type: "string" },
    born: { type: "date" },
    kind: { type: "enum", values: ["a", "b"] },
    old: { type: "integer", deleted: true },
  },
});

describe("filterableFields", () => {
  it("lists every non-deleted schema field when the view declares none", () => {
    const out = filterableFields(ViewConfigSchema.parse({}), schema);
    expect(out.map((f) => f.field)).toEqual(["name", "born", "kind"]);
    expect(out[0]).toEqual({
      field: "name",
      type: "string",
      ops: [
        "eq",
        "neq",
        "contains",
        "starts_with",
        "ends_with",
        "in",
        "not_in",
        "is_null",
        "is_not_null",
      ],
      default_op: "contains",
      widget: "text",
    });
    expect(out[2]).toMatchObject({ widget: "select", values: ["a", "b"] });
  });

  it("follows view.filterable: names, overrides, per-type default ops; skips deleted and unknown; adds unlisted fields by field_order", () => {
    const view = ViewConfigSchema.parse({
      filterable: {
        fields: [
          "born",
          { field: "name", ops: ["eq", "contains"], label: "Naziv", widget: "lookup" },
          "old",
          "missing",
        ],
        default_op: { date: "between" },
      },
    });
    expect(filterableFields(view, schema)).toEqual([
      {
        field: "born",
        type: "date",
        ops: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "is_null", "is_not_null"],
        default_op: "between",
        widget: "date",
      },
      // Not in the view: placed after its field_order neighbour `born`.
      {
        field: "kind",
        type: "enum",
        ops: expect.any(Array),
        default_op: expect.any(String),
        widget: "select",
        values: ["a", "b"],
      },
      {
        field: "name",
        type: "string",
        ops: ["eq", "contains"],
        default_op: "contains",
        widget: "lookup",
        label: "Naziv",
      },
    ]);
  });
});

describe("sortableFields", () => {
  it("lists the live fields in field_order, without the deleted and the refused", () => {
    expect(sortableFields(schema)).toEqual({ fields: ["name", "born", "kind"] });
    expect(sortableFields(schema, ["born"])).toEqual({ fields: ["name", "kind"] });
  });

  it("is what buildDescribe answers as describe.sortable", () => {
    const caps = {
      mutate: true,
      subscribe: false,
      total_count: true,
      schema_edit: false,
      config_edit: false,
      reindex: false,
      tree_reparent: false,
      source_yaml: false,
      supported_filter_ops: [],
    };
    const view = ViewConfigSchema.parse({});
    expect(buildDescribe("c", caps, schema, view).sortable).toEqual({
      fields: ["name", "born", "kind"],
    });
    expect(
      buildDescribe("c", caps, schema, view, { source_kind: "memory", notSortable: ["kind"] })
        .sortable,
    ).toEqual({ fields: ["name", "born"] });
  });
});
