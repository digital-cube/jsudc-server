import { SchemaDocSchema, ViewConfigSchema } from "@jsudc/core";
import { describe, expect, it } from "vitest";
import { buildDescribe } from "../src/describe.js";

// The mail list of TCKJ5ETN97: fields a list needs that are not columns.
const schema = SchemaDocSchema.parse({
  version: "v1",
  fields: {
    folder_id: { type: "string" },
    thread_id: { type: "string" },
    server_uid: { type: "integer" },
    from: { type: "json" },
    to: { type: "json" },
    subject: { type: "string" },
    snippet: { type: "string" },
    date: { type: "datetime" },
    is_read: { type: "bool" },
    is_starred: { type: "bool" },
    has_attachments: { type: "bool" },
  },
});

const columns = [
  { field: "is_starred", render: "star", width: 40 },
  { field: "from", render: "mail_from", width: 190 },
  { field: "subject", render: "mail_subject", width: 520 },
  { field: "has_attachments", render: "clip", width: 40 },
  { field: "date", width: 110 },
];
const listed = ["is_starred", "from", "subject", "has_attachments", "date"];
const caps = { list: true, get: true } as never;

const describeOf = (view: object) =>
  buildDescribe("mail", caps, schema, ViewConfigSchema.parse(view));

describe("describe: schema fields that are not table columns", () => {
  it("serves every field as a column by default", () => {
    expect(describeOf({ columns }).view.columns).toHaveLength(11);
  });

  it("columns_mode: listed serves the view's columns only", () => {
    const d = describeOf({ columns, columns_mode: "listed" });
    expect(d.view.columns.map((c) => c.field)).toEqual(listed);
    // The rest stay in the schema and the filter builder.
    expect(Object.keys(d.schema.fields)).toContain("folder_id");
    expect(d.filterable.fields.map((f) => f.field)).toContain("folder_id");
  });

  it("hidden: true leaves that column out and keeps the field filterable", () => {
    const hidden = ["folder_id", "thread_id", "server_uid", "to", "snippet", "is_read"].map(
      (field) => ({ field, hidden: true }),
    );
    const d = describeOf({ columns: [...columns, ...hidden] });
    expect(d.view.columns.map((c) => c.field)).toEqual(listed);
    expect(d.filterable.fields).toHaveLength(11);
  });
});
