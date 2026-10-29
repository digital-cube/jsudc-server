import {
  type FieldDef,
  FieldDefSchema,
  isPhase1Type,
  isValidFieldName,
  PHASE1_FIELD_TYPES,
  type SchemaDoc,
  type SchemaPosition,
  UdcError,
} from "@jsudc/core";
import { z } from "zod";

export interface AddFieldEdit {
  op: "add";
  name: string;
  fielddef: FieldDef;
  position: SchemaPosition;
}

export interface UpdateFieldEdit {
  op: "update";
  name: string;
  fielddef: FieldDef;
}

export interface SoftDeleteFieldEdit {
  op: "soft_delete";
  field: string;
}

export type SchemaEdit = AddFieldEdit | UpdateFieldEdit | SoftDeleteFieldEdit;

const liveDef = (schema: SchemaDoc, name: string): FieldDef | undefined => {
  const def = Object.hasOwn(schema.fields, name) ? schema.fields[name] : undefined;
  return def && !def.deleted ? def : undefined;
};

/** A def as a client sent it: parsed, and without `deleted`, which only soft-delete sets. */
function incomingDef(name: string, raw: unknown): FieldDef {
  const parsed = FieldDefSchema.safeParse(raw);
  if (!parsed.success) {
    throw new UdcError("validation_error", `invalid fielddef for ${name}`, {
      field: name,
      issues: z.treeifyError(parsed.error),
    });
  }
  const { deleted: _, ...def } = parsed.data;
  return def as FieldDef;
}

function assertName(name: string): void {
  if (!isValidFieldName(name)) {
    throw new UdcError(
      "validation_error",
      `invalid field name ${JSON.stringify(name)}: lowercase snake_case, 1-63 chars`,
      { field: name },
    );
  }
}

function notFound(name: string): UdcError {
  return new UdcError("not_found", `no field ${name} in the active schema`, { field: name });
}

function insertAt(order: string[], name: string, position: SchemaPosition, schema: SchemaDoc) {
  if (position.where === "end") return [...order, name];
  const anchor = position.anchor;
  if (anchor === undefined || !liveDef(schema, anchor) || !order.includes(anchor)) {
    throw new UdcError(
      "validation_error",
      `position ${position.where} needs an existing field as anchor, got ${JSON.stringify(anchor)}`,
      { anchor: anchor ?? null },
    );
  }
  const at = order.indexOf(anchor) + (position.where === "after" ? 1 : 0);
  return [...order.slice(0, at), name, ...order.slice(at)];
}

/**
 * The schema document after one `schema.*` edit, `version` unchanged (the
 * revision writer numbers it). Refuses with the protocol's error codes: a bad
 * or taken name, a missing anchor or an invalid def → `validation_error`; an
 * unknown or deleted field → `not_found`; a type change or a type jsudc
 * cannot store yet → `unsupported_op`. The input is not modified.
 */
export function applySchemaEdit(schema: SchemaDoc, edit: SchemaEdit): SchemaDoc {
  const fields = { ...schema.fields };
  let order = [...schema.field_order];

  switch (edit.op) {
    case "add": {
      assertName(edit.name);
      if (Object.hasOwn(fields, edit.name)) {
        const how = fields[edit.name]?.deleted ? " (soft-deleted; pick another name)" : "";
        throw new UdcError("validation_error", `field ${edit.name} already exists${how}`, {
          field: edit.name,
        });
      }
      const def = incomingDef(edit.name, edit.fielddef);
      if (!isPhase1Type(def.type)) {
        throw new UdcError(
          "unsupported_op",
          `field type ${def.type} is not storable yet (phase 1: ${PHASE1_FIELD_TYPES.join(" ")})`,
          { field: edit.name, type: def.type },
        );
      }
      order = insertAt(order, edit.name, edit.position, schema);
      fields[edit.name] = def;
      break;
    }
    case "update": {
      const current = liveDef(schema, edit.name);
      if (!current) throw notFound(edit.name);
      const def = incomingDef(edit.name, edit.fielddef);
      if (def.type !== current.type) {
        throw new UdcError(
          "unsupported_op",
          `cannot change the type of ${edit.name} from ${current.type} to ${def.type}; ` +
            "soft-delete it and add a new field instead",
          { field: edit.name, from: current.type, to: def.type },
        );
      }
      fields[edit.name] = def;
      break;
    }
    case "soft_delete": {
      const current = liveDef(schema, edit.field);
      if (!current) throw notFound(edit.field);
      fields[edit.field] = { ...current, deleted: true };
      break;
    }
  }

  return { ...schema, fields, field_order: order };
}

/** The schema as `describe` serves it: soft-deleted fields are absent. */
export function presentedSchema(schema: SchemaDoc): SchemaDoc {
  const fields = Object.fromEntries(Object.entries(schema.fields).filter(([, d]) => !d.deleted));
  return {
    ...schema,
    fields,
    field_order: schema.field_order.filter((f) => Object.hasOwn(fields, f)),
  };
}
