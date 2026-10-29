import { SchemaDocSchema, UdcError } from "@jsudc/core";
import { describe, expect, it } from "vitest";
import { applySchemaEdit, presentedSchema } from "../src/schema-edit.js";

const schema = SchemaDocSchema.parse({
  version: "v3",
  fields: {
    name: { type: "string", required: true },
    city: { type: "string", index: true },
    old: { type: "string", deleted: true },
    tags: { type: "string_array" },
  },
  field_order: ["name", "old", "city", "tags"],
});

function refused(fn: () => unknown, code: string): UdcError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(UdcError);
    expect((err as UdcError).code).toBe(code);
    return err as UdcError;
  }
  throw new Error(`expected a ${code} UdcError`);
}

const add = (name: string, fielddef: object, position: object) =>
  applySchemaEdit(schema, { op: "add", name, fielddef, position } as never);

describe("applySchemaEdit add", () => {
  it.each([
    [{ where: "end" }, ["name", "old", "city", "tags", "web"]],
    [{ where: "after", anchor: "name" }, ["name", "web", "old", "city", "tags"]],
    [{ where: "before", anchor: "name" }, ["web", "name", "old", "city", "tags"]],
    [{ where: "before", anchor: "city" }, ["name", "old", "web", "city", "tags"]],
    [{ where: "after", anchor: "tags" }, ["name", "old", "city", "tags", "web"]],
  ])("position %j → field_order %j", (position, order) => {
    const next = add("web", { type: "string", length: 120 }, position);
    expect(next.field_order).toEqual(order);
    expect(next.fields.web).toEqual({ type: "string", length: 120 });
    expect(next.version).toBe("v3");
  });

  it("does not touch the input document", () => {
    add("web", { type: "string" }, { where: "end" });
    expect(Object.keys(schema.fields)).toEqual(["name", "city", "old", "tags"]);
    expect(schema.field_order).toHaveLength(4);
  });

  it("keeps extras and drops a client-sent deleted flag", () => {
    const next = add(
      "web",
      { type: "string", label: { en: "Web" }, deleted: true, index: true },
      { where: "end" },
    );
    expect(next.fields.web).toEqual({ type: "string", label: { en: "Web" }, index: true });
  });

  it("refuses an existing name, live or soft-deleted", () => {
    expect(
      refused(() => add("city", { type: "string" }, { where: "end" }), "validation_error").message,
    ).toMatch(/already exists/);
    expect(
      refused(() => add("old", { type: "string" }, { where: "end" }), "validation_error").message,
    ).toMatch(/soft-deleted/);
  });

  it("refuses a bad field name", () => {
    refused(() => add("Bad-Name", { type: "string" }, { where: "end" }), "validation_error");
    refused(() => add("__proto__", { type: "string" }, { where: "end" }), "validation_error");
  });

  it("refuses a missing or deleted anchor", () => {
    refused(
      () => add("web", { type: "string" }, { where: "after", anchor: "nope" }),
      "validation_error",
    );
    refused(
      () => add("web", { type: "string" }, { where: "before", anchor: "old" }),
      "validation_error",
    );
    refused(() => add("web", { type: "string" }, { where: "before" }), "validation_error");
  });

  it("refuses a type that is not storable in phase 1", () => {
    const err = refused(() => add("img", { type: "image" }, { where: "end" }), "unsupported_op");
    expect(err.message).toMatch(/not storable yet/);
  });

  it("refuses an invalid fielddef", () => {
    refused(() => add("web", { type: "nope" }, { where: "end" }), "validation_error");
    refused(
      () => add("web", { type: "integer", min: 5, max: 1 }, { where: "end" }),
      "validation_error",
    );
  });
});

describe("applySchemaEdit update", () => {
  const update = (name: string, fielddef: object) =>
    applySchemaEdit(schema, { op: "update", name, fielddef } as never);

  it("replaces the def and never moves the field", () => {
    const next = update("city", { type: "string", length: 80, required: true, label: "Grad" });
    expect(next.fields.city).toEqual({ type: "string", length: 80, required: true, label: "Grad" });
    expect(next.field_order).toEqual(schema.field_order);
  });

  it("keeps a non-phase-1 type it already has", () => {
    expect(update("tags", { type: "string_array", description: "x" }).fields.tags).toEqual({
      type: "string_array",
      description: "x",
    });
  });

  it("refuses a type change", () => {
    expect(refused(() => update("city", { type: "text" }), "unsupported_op").message).toMatch(
      /type/,
    );
  });

  it("refuses unknown and deleted fields with not_found", () => {
    refused(() => update("nope", { type: "string" }), "not_found");
    refused(() => update("old", { type: "string" }), "not_found");
  });

  it("does not let update soft-delete a field", () => {
    expect(update("city", { type: "string", deleted: true }).fields.city?.deleted).toBeUndefined();
  });
});

describe("applySchemaEdit soft_delete", () => {
  const del = (field: string) => applySchemaEdit(schema, { op: "soft_delete", field });

  it("flags the def and keeps its place in field_order", () => {
    const next = del("city");
    expect(next.fields.city).toEqual({ type: "string", index: true, deleted: true });
    expect(next.field_order).toEqual(schema.field_order);
  });

  it("refuses unknown and already-deleted fields with not_found", () => {
    refused(() => del("nope"), "not_found");
    refused(() => del("old"), "not_found");
  });
});

describe("presentedSchema", () => {
  it("drops soft-deleted fields from fields and field_order", () => {
    expect(presentedSchema(schema)).toEqual({
      version: "v3",
      core_fields: [],
      fields: {
        name: { type: "string", required: true },
        city: { type: "string", index: true },
        tags: { type: "string_array" },
      },
      field_order: ["name", "city", "tags"],
    });
  });
});
