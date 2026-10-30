import {
  type Condition,
  type FieldDef,
  type FilterNode,
  isCondition,
  isIsoDate,
  isIsoDateTime,
  type SchemaDoc,
  type SortDir,
  type SortKey,
  UdcError,
} from "@jsudc/core";
import { type SQL, sql } from "drizzle-orm";
import type { CursorValue } from "./cursor.js";
import { allowedField } from "./fields.js";

// Every function here takes field names only after `allowedField` let them
// through (schema allowlist + FIELD_NAME_RE), so writing them into the SQL
// text as `data->>'<field>'` is safe. Values always travel as parameters.

type Cast = "numeric" | "date" | "timestamptz" | "boolean" | "text";

function castFor(def: FieldDef): Cast {
  switch (def.type) {
    case "integer":
    case "decimal":
    case "year":
      return "numeric";
    case "date":
      return "date";
    case "datetime":
      return "timestamptz";
    case "bool":
      return "boolean";
    default:
      return "text";
  }
}

/** `data->>'f'`: the text form, used by the text ops and `is_null`. */
function textExpr(field: string): SQL {
  return sql.raw(`(data->>'${field}')`);
}

/**
 * Text compared and sorted by code point, whatever the database's collation:
 * evaluateFilter compares strings with `<`, and under a linguistic collation
 * (`en_US.utf8`, the postgres image's default) `'beta' > 'Gama'` would hold
 * in SQL and not in memory.
 */
function codePoint(expr: SQL): SQL {
  return sql`(${expr} COLLATE "C")`;
}

/**
 * The typed expression comparisons and ORDER BY use, and the expression
 * index of an indexed field is built on (so the planner can match the two).
 * date and timestamptz go through the IMMUTABLE wrappers of migration 0001:
 * the bare casts are STABLE and Postgres refuses them in an index.
 */
function typedExpr(field: string, cast: Cast): SQL {
  switch (cast) {
    case "text":
      return codePoint(textExpr(field));
    case "date":
      return sql.raw(`udc_date(data->>'${field}')`);
    case "timestamptz":
      return sql.raw(`udc_timestamptz(data->>'${field}')`);
    default:
      return sql.raw(`((data->>'${field}')::${cast})`);
  }
}

/** The typed expression of an allowlisted field (see `typedExpr`). */
export function fieldExpr(field: string, def: FieldDef): SQL {
  return typedExpr(field, castFor(def));
}

function param(value: unknown, cast: Cast): SQL {
  return sql`${value}::${sql.raw(cast)}`;
}

const isMissing = (v: unknown) => v === null || v === undefined;

function badValue(field: string, op: string, expected: string): UdcError {
  return new UdcError("validation_error", `${op} on ${field} expects ${expected}`, { field, op });
}

/** A filter value in the form its cast parses, or a `validation_error`. */
function coerce(value: unknown, cast: Cast, field: string, op: string): unknown {
  switch (cast) {
    case "numeric":
      if (typeof value === "number" && Number.isFinite(value)) return value;
      throw badValue(field, op, "a number");
    case "date":
      if (isIsoDate(value)) return value;
      throw badValue(field, op, "a date (YYYY-MM-DD)");
    case "timestamptz":
      if (isIsoDateTime(value)) return value;
      throw badValue(field, op, "an ISO 8601 datetime");
    case "boolean":
      if (typeof value === "boolean") return value;
      throw badValue(field, op, "true or false");
    case "text":
      return scalarText(value, field, op);
  }
}

function scalarText(value: unknown, field: string, op: string): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  throw badValue(field, op, "a scalar value");
}

/** Escape the LIKE metacharacters so the value matches literally. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

const COMPARE: Partial<Record<Condition["op"], string>> = {
  eq: "=",
  neq: "<>",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

const NULL = sql`NULL::boolean`;

const ARRAY_TYPES: ReadonlySet<FieldDef["type"]> = new Set(["string_array", "lookup_array"]);

/**
 * A condition on an array field holds when one element passes it (`not_in`:
 * when none is in the list), as in evaluateFilter. A row without the field
 * stays UNKNOWN.
 */
function compileArrayCondition(cond: Condition): SQL {
  const { field, op, value } = cond;
  const arr = sql.raw(`(data->'${field}')`);
  const ci = cond.case_insensitive === true;
  const el = sql.raw(ci ? "lower(e.el)" : "e.el");
  let test: SQL;
  if (op === "contains" || op === "starts_with" || op === "ends_with") {
    if (isMissing(value)) return NULL;
    const text = escapeLike(scalarText(value, field, op));
    const pattern =
      op === "contains" ? `%${text}%` : op === "starts_with" ? `${text}%` : `%${text}`;
    test = sql`e.el ${sql.raw(ci ? "ILIKE" : "LIKE")} ${pattern}::text`;
  } else if (op === "in" || op === "not_in") {
    if (!Array.isArray(value)) throw badValue(field, op, "an array");
    const items = value
      .filter((v) => !isMissing(v))
      .map((v) => scalarText(v, field, op))
      .map((v) => (ci ? v.toLowerCase() : v));
    test = sql`${el} = ANY(${sql.param(items)}::text[])`;
  } else {
    throw new UdcError("unsupported_op", `${op} is not supported on the array field ${field}`, {
      field,
      op,
    });
  }
  const exists = sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${arr}) AS e(el) WHERE ${test})`;
  return sql`(CASE WHEN jsonb_typeof(${arr}) = 'array' THEN ${op === "not_in" ? sql`NOT ${exists}` : exists} ELSE NULL END)`;
}

function compileCondition(cond: Condition, def: FieldDef): SQL {
  const { field, op, value } = cond;

  if (op === "is_null") return sql`(${textExpr(field)} IS NULL)`;
  if (op === "is_not_null") return sql`(${textExpr(field)} IS NOT NULL)`;
  if (ARRAY_TYPES.has(def.type)) return compileArrayCondition(cond);

  if (op === "contains" || op === "starts_with" || op === "ends_with") {
    if (isMissing(value)) return NULL;
    const text = escapeLike(scalarText(value, field, op));
    const pattern =
      op === "contains" ? `%${text}%` : op === "starts_with" ? `${text}%` : `%${text}`;
    const like = sql.raw(cond.case_insensitive ? "ILIKE" : "LIKE");
    return sql`(${textExpr(field)} ${like} ${pattern}::text)`;
  }

  const cast = castFor(def);
  // case_insensitive only means something for text comparisons, as in evaluateFilter.
  const ci = cond.case_insensitive === true && cast === "text";
  // lower() under the database's collation (a "C" lower() folds ASCII only), then code point order.
  const lhs = ci ? codePoint(sql`lower(${textExpr(field)})`) : typedExpr(field, cast);
  const rhs = (v: unknown) => {
    const p = param(coerce(v, cast, field, op), cast);
    return ci ? sql`lower(${p})` : p;
  };

  const cmp = COMPARE[op];
  if (cmp) return isMissing(value) ? NULL : sql`(${lhs} ${sql.raw(cmp)} ${rhs(value)})`;

  if (op === "between") {
    if (!Array.isArray(value) || value.length !== 2) throw badValue(field, op, "[lo, hi]");
    const [lo, hi] = value;
    if (isMissing(lo) || isMissing(hi)) return NULL;
    return sql`(${lhs} BETWEEN ${rhs(lo)} AND ${rhs(hi)})`;
  }

  if (op === "in" || op === "not_in") {
    if (!Array.isArray(value)) throw badValue(field, op, "an array");
    // Null members never match (as in evaluateFilter); keeping them would turn a miss into NULL.
    const items = value
      .filter((v) => !isMissing(v))
      .map((v) => coerce(v, cast, field, op))
      .map((v) => (ci ? String(v).toLowerCase() : v));
    // One array parameter: a bare JS array would expand into a value list.
    const arr = sql`${sql.param(items)}::${sql.raw(cast)}[]`;
    if (op === "in") return sql`(${lhs} = ANY(${arr}))`;
    // `x <> ALL('{}')` is true even for a NULL x: keep a missing value UNKNOWN.
    return sql`(CASE WHEN ${lhs} IS NULL THEN NULL ELSE ${lhs} <> ALL(${arr}) END)`;
  }

  throw new UdcError("unsupported_op", `unsupported filter op: ${String(op)}`, { field, op });
}

/** A filter tree as a WHERE expression, with SQL's three-valued logic (which evaluateFilter mirrors). */
export function compileFilter(node: FilterNode | null | undefined, schema: SchemaDoc): SQL {
  if (!node) return sql`TRUE`;
  if (isCondition(node)) return compileCondition(node, allowedField(schema, node.field, "filter"));
  if ("and" in node) {
    if (node.and.length === 0) return sql`TRUE`;
    return sql`(${sql.join(
      node.and.map((n) => compileFilter(n, schema)),
      sql` AND `,
    )})`;
  }
  if ("or" in node) {
    if (node.or.length === 0) return sql`FALSE`;
    return sql`(${sql.join(
      node.or.map((n) => compileFilter(n, schema)),
      sql` OR `,
    )})`;
  }
  return sql`(NOT ${compileFilter(node.not, schema)})`;
}

export interface SortTerm {
  field: string;
  dir: SortDir;
  cast: Cast;
  expr: SQL;
}

export function compileSort(sort: SortKey[] | undefined, schema: SchemaDoc): SortTerm[] {
  return (sort ?? []).map(({ field, dir }) => {
    const cast = castFor(allowedField(schema, field, "sort"));
    return { field, dir: dir ?? "asc", cast, expr: typedExpr(field, cast) };
  });
}

/** `ORDER BY` the requested keys, NULLS LAST both ways, then `id ASC` as the tiebreaker. */
export function orderBy(terms: SortTerm[]): SQL {
  const keys = terms.map(
    (t) => sql`${t.expr} ${sql.raw(t.dir === "desc" ? "DESC" : "ASC")} NULLS LAST`,
  );
  return sql.join([...keys, sql`id ASC`], sql`, `);
}

/** The sort values as text, selected next to each row so the next cursor can be built. */
export function sortKeyColumns(terms: SortTerm[]): SQL {
  return sql.join(
    terms.map((t, i) => sql`(${t.expr})::text AS ${sql.identifier(`__k${i}`)}`),
    sql`, `,
  );
}

function and(parts: SQL[]): SQL {
  return parts.length === 0 ? sql`TRUE` : sql`(${sql.join(parts, sql` AND `)})`;
}

function or(parts: SQL[]): SQL {
  return parts.length === 0 ? sql`FALSE` : sql`(${sql.join(parts, sql` OR `)})`;
}

/**
 * Rows strictly after the cursor position in `ORDER BY terms…, id ASC` with
 * NULLS LAST. When every key runs the same direction and the cursor has no
 * missing value this is the row comparison `(e1, …, id) > ($1, …, $id)`
 * (for all-desc `(e1, …, $id) < ($1, …, id)`, which keeps the id ascending),
 * widened by the NULL tails a row comparison cannot see. Otherwise (mixed
 * directions, or a cursor sitting in a NULL tail) it is the lexicographic
 * expansion `k1 after v1 OR (k1 = v1 AND k2 after v2) OR …`.
 */
export function cursorPredicate(terms: SortTerm[], values: CursorValue[], id: string): SQL {
  const value = (i: number) => param(values[i], (terms[i] as SortTerm).cast);
  const idParam = sql`${id}::uuid`;
  const equal = (i: number) =>
    values[i] === null ? sql`(${terms[i]?.expr} IS NULL)` : sql`(${terms[i]?.expr} = ${value(i)})`;
  const prefixEqual = (i: number) => terms.slice(0, i).map((_, j) => equal(j));

  const dir = terms[0]?.dir;
  const uniform = terms.every((t) => t.dir === dir);
  if (terms.length > 0 && uniform && values.every((v) => v !== null)) {
    const exprs = sql.join([...terms.map((t) => t.expr)], sql`, `);
    const params = sql.join(
      terms.map((_, i) => value(i)),
      sql`, `,
    );
    const rowCompare =
      dir === "desc"
        ? sql`((${exprs}, ${idParam}) < (${params}, id))`
        : sql`((${exprs}, id) > (${params}, ${idParam}))`;
    // A NULL key sorts after every value of that key once the keys before it tie.
    const tails = terms.map((t, i) => and([...prefixEqual(i), sql`(${t.expr} IS NULL)`]));
    return or([rowCompare, ...tails]);
  }

  const terms_: SQL[] = [];
  terms.forEach((t, i) => {
    // Nothing of this key comes after a NULL: NULLs are last.
    if (values[i] === null) return;
    const cmp = sql.raw(t.dir === "desc" ? "<" : ">");
    const after = sql`(${t.expr} ${cmp} ${value(i)} OR ${t.expr} IS NULL)`;
    terms_.push(and([...prefixEqual(i), after]));
  });
  terms_.push(and([...prefixEqual(terms.length), sql`(id > ${idParam})`]));
  return or(terms_);
}
