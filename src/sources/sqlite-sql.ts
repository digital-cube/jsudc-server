// The SQLite side of the SQL compiler: the dialect, a resolver over typed
// columns, the datetime form the storage and the parameters share, and the
// renderer that turns a compiled `SQL` into text + parameters for a driver.
// No driver is imported: `node:sqlite`, `better-sqlite3` or any other runs the
// text. Needs SQLite 3.38 or newer (JSON built in; `NULLS LAST` is 3.30,
// row values 3.15).

import type { FieldDef } from "@jsudc/core";
import { type SQL, sql } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import type { FieldResolver, SqlCast, SqlIdType } from "./sql.js";
import { escapeLike, likePattern, type SqlDialect, type SqlTextOp } from "./sql-dialect.js";

const DATETIME_PARTS =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:Z|([+-])(\d{2}):?(\d{2}))?$/;

/**
 * An ISO 8601 datetime in the one form a SQLite collection stores and binds:
 * UTC, milliseconds, fixed width (`2021-05-31T22:00:00.000Z`), so text order
 * is time order. `2021-06-01T00:00:00+02:00` and `2021-05-31T22:00Z` give the
 * same text. A value without an offset is UTC. Digits after the millisecond
 * are dropped (Postgres keeps microseconds). Years 0001–9999. Anything that
 * is not an ISO 8601 datetime is answered unchanged (a value that `coerce`
 * did not check, such as the text of a cursor, can then only miss).
 */
export function sqliteDateTime(value: string): string {
  const m = DATETIME_PARTS.exec(value);
  if (!m) return value;
  const [, y, mo, d, h, mi, s, frac, sign, oh, om] = m;
  const at = new Date(0);
  at.setUTCFullYear(Number(y), Number(mo) - 1, Number(d));
  at.setUTCHours(
    Number(h),
    Number(mi),
    Number(s ?? 0),
    Number((frac ?? "").padEnd(3, "0").slice(0, 3)),
  );
  if (Number.isNaN(at.getTime())) return value;
  const offset = sign ? (sign === "-" ? -1 : 1) * (Number(oh) * 60 + Number(om)) : 0;
  return new Date(at.getTime() - offset * 60_000).toISOString();
}

const INTEGER_TEXT = /^-?\d+$/;

/**
 * A value of `cast` as SQLite binds it: a boolean as 1/0, a datetime in
 * `sqliteDateTime`'s form, a number as a number. A cursor value arrives as
 * the text `sortKeyText` selected (`"10"`, `"1"`, `"0.1"`) and is turned back
 * into its type here, as Postgres's `$1::numeric` does in SQL.
 */
function sqliteValue(value: unknown, cast: SqlCast): unknown {
  switch (cast) {
    case "boolean":
      if (value === true || value === "1" || value === "true") return 1;
      if (value === false || value === "0" || value === "false") return 0;
      return value;
    case "numeric":
      if (typeof value !== "string") return value;
      if (INTEGER_TEXT.test(value)) {
        const n = Number(value);
        return Number.isSafeInteger(n) ? n : BigInt(value);
      }
      return Number(value);
    case "timestamptz":
      return typeof value === "string" ? sqliteDateTime(value) : value;
    default:
      return value;
  }
}

/** A JSON array of values bound as one parameter, read back with `json_each` (a bigint kept exact). */
function jsonList(items: readonly unknown[], cast: SqlCast): string {
  const parts = items.map((v) => {
    const out = sqliteValue(v, cast);
    return typeof out === "bigint" ? out.toString() : JSON.stringify(out);
  });
  return `[${parts.join(",")}]`;
}

/** Escape the GLOB metacharacters (`*`, `?`, `[`) so the value matches literally. */
export function escapeGlob(value: string): string {
  return value.replace(/[*?[]/g, (ch) => `[${ch}]`);
}

function globPattern(op: SqlTextOp, escaped: string): string {
  return op === "contains" ? `*${escaped}*` : op === "starts_with" ? `${escaped}*` : `*${escaped}`;
}

/**
 * SQLite: parameters without casts (values converted in JS: booleans 1/0,
 * datetimes to `sqliteDateTime`'s UTC text, cursor text back to numbers);
 * `COLLATE BINARY`, which is code point order for UTF-8 text; a list as one
 * JSON parameter (`IN (SELECT value FROM json_each(?))`); array fields as a
 * JSON array in a TEXT column (`json_each`, whatever `form` the resolver
 * names).
 *
 * The text ops: case-sensitive ones use `GLOB` (SQLite's `LIKE` ignores ASCII
 * case, and `PRAGMA case_sensitive_like` is deprecated and per connection);
 * case-insensitive ones `lower(x) LIKE lower(?) ESCAPE '\'`. Case folding is
 * SQL `lower()` everywhere (comparisons too), and SQLite's built-in `lower()`
 * folds ASCII only: `Č` stays `Č`. For `evaluateFilter`'s Unicode folding the
 * host loads ICU or registers its own `lower`, e.g. with `node:sqlite`:
 * `db.function("lower", { deterministic: true }, (s) => s == null ? null : String(s).toLowerCase())`.
 */
export const sqliteDialect: SqlDialect = {
  name: "sqlite",
  param: (value, cast) => sql`${sqliteValue(value, cast)}`,
  idParam: (id, idType) => sql`${idType === "integer" ? sqliteValue(id, "numeric") : id}`,
  idText: (id) => sql`CAST(${id} AS TEXT)`,
  codePointOrder: (expr) => sql`(${expr} COLLATE BINARY)`,
  unknown: sql`NULL`,
  textMatch: (expr, op, text, ci) =>
    ci
      ? sql`lower(${expr}) LIKE lower(${likePattern(op, escapeLike(text))}) ESCAPE '\\'`
      : sql`${expr} GLOB ${globPattern(op, escapeGlob(text))}`,
  anyOf: (lhs, items, cast) =>
    sql`${lhs} IN (SELECT value FROM json_each(${jsonList(items, cast)}))`,
  noneOf: (lhs, items, cast) =>
    sql`${lhs} NOT IN (SELECT value FROM json_each(${jsonList(items, cast)}))`,
  arrayHas: (arr, _form, test, negate) => {
    const elems = sql`(SELECT CAST(j.value AS TEXT) AS el FROM json_each(${arr}) AS j) AS e`;
    const exists = sql`EXISTS (SELECT 1 FROM ${elems} WHERE ${test})`;
    return sql`(CASE WHEN json_type(${arr}) = 'array' THEN ${negate ? sql`NOT ${exists}` : exists} ELSE NULL END)`;
  },
  sortKeyText: (expr) => sql`CAST(${expr} AS TEXT)`,
};

export interface SqliteColumnResolverOptions {
  /** Field → its SQL expression: a column, or any expression with one value per row. */
  fields: Readonly<Record<string, SQL>>;
  /** The row id expression. */
  id: SQL;
  /** `integer` (default: a rowid or `INTEGER PRIMARY KEY`), `text` or `uuid` (stored as text). */
  idType?: SqlIdType | undefined;
}

const NUMERIC_TYPES: ReadonlySet<FieldDef["type"]> = new Set(["integer", "decimal", "year"]);

/**
 * A resolver over the typed columns of a SQLite table, compiling with
 * `sqliteDialect`. The storage it expects, per field type:
 *
 * - `integer`, `year`: INTEGER; `decimal`: NUMERIC (a REAL column would
 *   hold `-3` as `-3.0` and its text would not be `evaluateFilter`'s `-3`);
 * - `bool`: INTEGER 0/1 (its text form is `true` / `false`);
 * - `date`: TEXT `YYYY-MM-DD`; `datetime`: TEXT in `sqliteDateTime`'s form;
 * - `string_array`, `lookup_array`, `json`: TEXT holding JSON;
 * - everything else: TEXT. A missing value is SQL NULL.
 */
export function sqliteColumnResolver(opts: SqliteColumnResolverOptions): FieldResolver {
  const expr = (field: string): SQL => {
    const e = Object.hasOwn(opts.fields, field) ? opts.fields[field] : undefined;
    if (!e) throw new Error(`sqliteColumnResolver: no SQL expression for the field ${field}`);
    return e;
  };
  return {
    text: (field, def) => {
      const e = expr(field);
      if (def.type === "bool") return sql`(CASE ${e} WHEN 1 THEN 'true' WHEN 0 THEN 'false' END)`;
      return NUMERIC_TYPES.has(def.type) ? sql`CAST(${e} AS TEXT)` : sql`(${e})`;
    },
    typed: (field, _def, cast) =>
      cast === "text" ? sqliteDialect.codePointOrder(expr(field)) : sql`(${expr(field)})`,
    array: (field) => ({ expr: sql`(${expr(field)})`, form: "jsonb" }),
    id: opts.id,
    idType: opts.idType ?? "integer",
    dialect: sqliteDialect,
  };
}

const renderer = new SQLiteSyncDialect();

/** A compiled statement as a SQLite driver takes it: `?` placeholders and their values in order. */
export interface SqliteQuery {
  sql: string;
  params: unknown[];
}

/**
 * Render a `SQL` built with `sqliteDialect` (or any `sql` template) for a
 * SQLite driver: `db.prepare(q.sql).all(...q.params)`. Uses drizzle's SQLite
 * renderer, so no drizzle database object is needed. Identifiers are quoted
 * with `"`.
 */
export function sqliteQuery(query: SQL): SqliteQuery {
  const { sql: text, params } = renderer.sqlToQuery(query);
  return { sql: text, params };
}
