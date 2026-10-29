import {
  type FieldDef,
  type FilterNode,
  isCondition,
  isValidFieldName,
  type RowProblem,
  type SchemaDoc,
  type SortKey,
  type TreeReparentFields,
  UdcError,
  type ValidateMode,
  validateRow,
} from "@jsudc/core";

/**
 * The allowlist: a field may appear in a filter or a sort only when it is a
 * non-deleted field of the active schema and passes `FIELD_NAME_RE`. Only a
 * name that got through here is ever written into SQL.
 */
export function allowedField(schema: SchemaDoc, field: string, where: string): FieldDef {
  const def = Object.hasOwn(schema.fields, field) ? schema.fields[field] : undefined;
  if (!isValidFieldName(field) || !def || def.deleted) {
    throw new UdcError("validation_error", `unknown field in ${where}: ${JSON.stringify(field)}`, {
      field,
      where,
    });
  }
  return def;
}

/**
 * The allowlisted parts of a `reindex`: every scope field and the order
 * field must be live schema fields, the order field numeric. The scope comes
 * back as the filter both sources select the rows with.
 */
export function reindexPlan(
  schema: SchemaDoc,
  scope: Record<string, string | number | boolean>,
  orderField: string,
): { filter: FilterNode; orderField: string; orderDef: FieldDef } {
  const def = allowedField(schema, orderField, "reindex order_field");
  if (def.type !== "integer" && def.type !== "decimal") {
    throw new UdcError("validation_error", `reindex order_field ${orderField} must be numeric`, {
      field: orderField,
      type: def.type,
    });
  }
  const conds = Object.entries(scope).map(([field, value]) => {
    allowedField(schema, field, "reindex scope");
    return { field, op: "eq" as const, value };
  });
  // Typed like a patch, so both sources refuse the same values (the SQL casts would, memory not).
  const problems = validateRow(schema, scope, { mode: "patch" });
  if (problems.length > 0) {
    const summary = problems.map((p) => `${p.field} ${p.message}`).join("; ");
    throw new UdcError("validation_error", `invalid reindex scope: ${summary}`, { problems });
  }
  return { filter: { and: conds }, orderField, orderDef: def };
}

const NUMERIC = new Set(["integer", "decimal"]);

/** The allowlisted structure fields of a `tree.reparent`, absent ones left out. */
export interface ReparentPlan {
  parentField: string;
  orderField: string;
  depthField: string | undefined;
  ancestorIdsField: string | undefined;
  childrenCountField: string | undefined;
}

/**
 * Check a `tree.reparent` before anything runs: every name in `fields` a
 * live schema field (order, depth and children count numeric, ancestor ids
 * json or string_array), and the new parent and order values the schema
 * accepts for those fields. Only names that got through here reach the SQL.
 */
export function reparentPlan(
  schema: SchemaDoc,
  fields: TreeReparentFields,
  values: { parent: string | null; order: number },
): ReparentPlan {
  const where = "tree.reparent fields";
  const field = (name: string | undefined, kinds?: ReadonlySet<string>) => {
    if (name === undefined) return undefined;
    const def = allowedField(schema, name, where);
    if (kinds && !kinds.has(def.type)) {
      throw new UdcError("validation_error", `${where}: ${name} is ${def.type}`, {
        field: name,
        type: def.type,
      });
    }
    return name;
  };
  const plan: ReparentPlan = {
    parentField: field(fields.parent_field) as string,
    orderField: field(fields.order_field, NUMERIC) as string,
    depthField: field(fields.depth_field, NUMERIC),
    ancestorIdsField: field(fields.ancestor_ids_field, new Set(["json", "string_array"])),
    childrenCountField: field(fields.children_count_field, NUMERIC),
  };
  assertValidRow(
    schema,
    { [plan.parentField]: values.parent, [plan.orderField]: values.order },
    "patch",
  );
  return plan;
}

export function cycleError(id: string, parent: string): UdcError {
  return new UdcError(
    "validation_error",
    parent === id
      ? `cycle: row ${id} cannot be its own parent`
      : `cycle: ${parent} is inside the subtree of ${id}`,
    { id, parent },
  );
}

export function filterFields(node: FilterNode | null | undefined): string[] {
  if (!node) return [];
  if (isCondition(node)) return [node.field];
  if ("and" in node) return node.and.flatMap(filterFields);
  if ("or" in node) return node.or.flatMap(filterFields);
  return filterFields(node.not);
}

/** Check every field a list request names before anything runs. */
export function assertQueryFields(
  schema: SchemaDoc,
  filter: FilterNode | undefined,
  sort: SortKey[] | undefined,
): void {
  for (const field of filterFields(filter)) allowedField(schema, field, "filter");
  for (const key of sort ?? []) allowedField(schema, key.field, "sort");
}

export function assertValidRow(
  schema: SchemaDoc,
  row: Record<string, unknown>,
  mode: ValidateMode,
): void {
  const problems: RowProblem[] = validateRow(schema, row, { mode });
  if (problems.length > 0) {
    const summary = problems.map((p) => `${p.field} ${p.message}`).join("; ");
    throw new UdcError("validation_error", `invalid row: ${summary}`, { problems });
  }
}

/** The stored fields of an incoming row: `__meta` is the server's, never data. */
export function withoutMeta(row: Record<string, unknown>): Record<string, unknown> {
  const { __meta: _, ...data } = row;
  return data;
}

export function notFound(id: string): UdcError {
  return new UdcError("not_found", `no row with id ${id}`, { id });
}

export function versionConflict(id: string, expected: number, current: number): UdcError {
  return new UdcError("version_conflict", `row ${id} is at version ${current}, not ${expected}`, {
    id,
    expected_version: expected,
    current_version: current,
  });
}
