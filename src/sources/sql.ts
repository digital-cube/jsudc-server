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
import { allowedCondition, allowedField } from "./fields.js";

// Every function here takes field names only after `allowedField` let them
// through (schema allowlist + FIELD_NAME_RE), so a resolver may write them
// into the SQL text (the jsonb one as `data->>'<field>'`). Values always
// travel as parameters.

/** The type a filter value and a cursor value are cast to (`$1::numeric`), from the field's type. */
export type SqlCast = "numeric" | "date" | "timestamptz" | "boolean" | "text";
type Cast = SqlCast;

/** The type of a row id: a cursor carries the id, `read` and the tiebreaker compare it in this type. */
export type SqlIdType = "uuid" | "text" | "integer";

/**
 * How an array field (`string_array`, `lookup_array`) is stored: a jsonb
 * array (`postgres_jsonb`'s `data->'f'`) or a Postgres array (`text[]`; any
 * element type, compared as text).
 */
export type SqlArrayForm = "jsonb" | "text[]";

/**
 * Where the compiler finds a field and the row id in SQL. The compiler is the
 * same for every SQL source; only the resolver knows the storage. It is called
 * only for fields the allowlist let through (a live schema field, `FIELD_NAME_RE`).
 */
export interface FieldResolver {
  /** The text form of a field: `contains` / `starts_with` / `ends_with`, `is_null`, case-insensitive comparisons. */
  text(field: string, def: FieldDef): SQL;
  /**
   * The typed form: comparisons, `ORDER BY`, the keyset cursor. Compared with
   * parameters cast to `cast` (`sqlCastFor(def)`); a text form must compare by
   * code point (`codePointOrder`) for results to agree with `evaluateFilter`.
   */
  typed(field: string, def: FieldDef, cast: SqlCast): SQL;
  /** An array field's value and how it is stored. */
  array(field: string, def: FieldDef): { expr: SQL; form: SqlArrayForm };
  /** The row id: the `ORDER BY` tiebreaker, the cursor's last key, the `id` filter. */
  readonly id: SQL;
  readonly idType: SqlIdType;
}

/** The cast a field's filter values and cursor values take, by its type. */
export function sqlCastFor(def: FieldDef): SqlCast {
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

const castFor = sqlCastFor;

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
export function codePointOrder(expr: SQL): SQL {
  return sql`(${expr} COLLATE "C")`;
}

const codePoint = codePointOrder;

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

/**
 * The resolver of `postgres_jsonb`: every field in `data jsonb`, a uuid `id`
 * column. Its SQL text is the one the expression indexes are built on.
 */
export const jsonbResolver: FieldResolver = {
  text: (field) => textExpr(field),
  typed: (field, _def, cast) => typedExpr(field, cast),
  array: (field) => ({ expr: sql.raw(`(data->'${field}')`), form: "jsonb" }),
  id: sql.raw("id"),
  idType: "uuid",
};

const ID_CAST: Record<SqlIdType, string> = { uuid: "uuid", text: "text", integer: "bigint" };

/** A row id as a parameter of its type (`$1::uuid`, `$1::bigint`, `$1::text`). */
export function idParam(id: string, idType: SqlIdType): SQL {
  return sql`${id}::${sql.raw(ID_CAST[idType])}`;
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
function compileArrayCondition(cond: Condition, def: FieldDef, resolve: FieldResolver): SQL {
  const { field, op, value } = cond;
  const { expr: arr, form } = resolve.array(field, def);
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
  if (form === "text[]") {
    // Any element type, compared as text, as the jsonb elements are.
    const elems = sql`(SELECT u.v::text AS el FROM unnest(${arr}) AS u(v)) AS e`;
    const exists = sql`EXISTS (SELECT 1 FROM ${elems} WHERE ${test})`;
    return sql`(CASE WHEN ${arr} IS NOT NULL THEN ${op === "not_in" ? sql`NOT ${exists}` : exists} ELSE NULL END)`;
  }
  const exists = sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${arr}) AS e(el) WHERE ${test})`;
  return sql`(CASE WHEN jsonb_typeof(${arr}) = 'array' THEN ${op === "not_in" ? sql`NOT ${exists}` : exists} ELSE NULL END)`;
}

function compileCondition(cond: Condition, def: FieldDef, resolve: FieldResolver): SQL {
  const { field, op, value } = cond;
  const asText = resolve.text(field, def);

  if (op === "is_null") return sql`(${asText} IS NULL)`;
  if (op === "is_not_null") return sql`(${asText} IS NOT NULL)`;
  if (ARRAY_TYPES.has(def.type)) return compileArrayCondition(cond, def, resolve);

  if (op === "contains" || op === "starts_with" || op === "ends_with") {
    if (isMissing(value)) return NULL;
    const text = escapeLike(scalarText(value, field, op));
    const pattern =
      op === "contains" ? `%${text}%` : op === "starts_with" ? `${text}%` : `%${text}`;
    const like = sql.raw(cond.case_insensitive ? "ILIKE" : "LIKE");
    return sql`(${asText} ${like} ${pattern}::text)`;
  }

  const cast = castFor(def);
  // case_insensitive only means something for text comparisons, as in evaluateFilter.
  const ci = cond.case_insensitive === true && cast === "text";
  // lower() under the database's collation (a "C" lower() folds ASCII only), then code point order.
  const lhs = ci ? codePoint(sql`lower(${asText})`) : resolve.typed(field, def, cast);
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

/**
 * A condition on the row id (`id`, when the schema has no such field): the
 * `id` column as text, so a malformed id is a miss, not a cast error.
 * `allowedCondition` already limited the op to eq neq in not_in and the nulls.
 */
function compileIdCondition(cond: Condition, resolve: FieldResolver): SQL {
  const { field, op, value } = cond;
  const id = sql`(${resolve.id}::text)`;
  if (op === "is_null") return sql`(${id} IS NULL)`;
  if (op === "is_not_null") return sql`(${id} IS NOT NULL)`;
  if (op === "eq" || op === "neq") {
    if (isMissing(value)) return NULL;
    return sql`(${id} ${sql.raw(op === "eq" ? "=" : "<>")} ${scalarText(value, field, op)}::text)`;
  }
  if (!Array.isArray(value)) throw badValue(field, op, "an array");
  const items = value.filter((v) => !isMissing(v)).map((v) => scalarText(v, field, op));
  const arr = sql`${sql.param(items)}::text[]`;
  return op === "in" ? sql`(${id} = ANY(${arr}))` : sql`(${id} <> ALL(${arr}))`;
}

/**
 * A filter tree as a WHERE expression, with SQL's three-valued logic (which
 * evaluateFilter mirrors). Every field passes the allowlist of `schema`
 * first (an unknown one is a `validation_error`, a value of the wrong type
 * too); `resolve` says where the fields live (`jsonbResolver` by default).
 */
export function compileFilter(
  node: FilterNode | null | undefined,
  schema: SchemaDoc,
  resolve: FieldResolver = jsonbResolver,
): SQL {
  if (!node) return sql`TRUE`;
  if (isCondition(node)) {
    const def = allowedCondition(schema, node);
    return def ? compileCondition(node, def, resolve) : compileIdCondition(node, resolve);
  }
  if ("and" in node) {
    if (node.and.length === 0) return sql`TRUE`;
    return sql`(${sql.join(
      node.and.map((n) => compileFilter(n, schema, resolve)),
      sql` AND `,
    )})`;
  }
  if ("or" in node) {
    if (node.or.length === 0) return sql`FALSE`;
    return sql`(${sql.join(
      node.or.map((n) => compileFilter(n, schema, resolve)),
      sql` OR `,
    )})`;
  }
  return sql`(NOT ${compileFilter(node.not, schema, resolve)})`;
}

/** One compiled sort key: its typed expression, and the cast its cursor value takes. */
export interface SortTerm {
  field: string;
  dir: SortDir;
  cast: SqlCast;
  expr: SQL;
}

/** The sort keys allowlisted against `schema` and resolved to typed expressions. */
export function compileSort(
  sort: SortKey[] | undefined,
  schema: SchemaDoc,
  resolve: FieldResolver = jsonbResolver,
): SortTerm[] {
  return (sort ?? []).map(({ field, dir }) => {
    const def = allowedField(schema, field, "sort");
    const cast = castFor(def);
    return { field, dir: dir ?? "asc", cast, expr: resolve.typed(field, def, cast) };
  });
}

/** `ORDER BY` the requested keys, NULLS LAST both ways, then the row id ascending as the tiebreaker. */
export function orderBy(terms: SortTerm[], resolve: FieldResolver = jsonbResolver): SQL {
  const keys = terms.map(
    (t) => sql`${t.expr} ${sql.raw(t.dir === "desc" ? "DESC" : "ASC")} NULLS LAST`,
  );
  return sql.join([...keys, sql`${resolve.id} ASC`], sql`, `);
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
 * Rows strictly after the cursor position in `ORDER BY terms…, id ASC` (the
 * resolver's id) with
 * NULLS LAST. When every key runs the same direction and the cursor has no
 * missing value this is the row comparison `(e1, …, id) > ($1, …, $id)`
 * (for all-desc `(e1, …, $id) < ($1, …, id)`, which keeps the id ascending),
 * widened by the NULL tails a row comparison cannot see. Otherwise (mixed
 * directions, or a cursor sitting in a NULL tail) it is the lexicographic
 * expansion `k1 after v1 OR (k1 = v1 AND k2 after v2) OR …`.
 */
export function cursorPredicate(
  terms: SortTerm[],
  values: CursorValue[],
  id: string,
  resolve: FieldResolver = jsonbResolver,
): SQL {
  const value = (i: number) => param(values[i], (terms[i] as SortTerm).cast);
  const idCol = resolve.id;
  const idParam_ = idParam(id, resolve.idType);
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
        ? sql`((${exprs}, ${idParam_}) < (${params}, ${idCol}))`
        : sql`((${exprs}, ${idCol}) > (${params}, ${idParam_}))`;
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
  terms_.push(and([...prefixEqual(terms.length), sql`(${idCol} > ${idParam_})`]));
  return or(terms_);
}
