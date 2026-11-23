import { type SQL, sql } from "drizzle-orm";
import type { SqlArrayForm, SqlCast, SqlIdType } from "./sql.js";

/** The text ops: a value is matched literally (no metacharacters) as a substring, prefix or suffix. */
export type SqlTextOp = "contains" | "starts_with" | "ends_with";

/**
 * The SQL text the compiler (`compileFilter`, `compileSort`, `orderBy`,
 * `cursorPredicate`, `sortKeyColumns`, `idParam`) writes where databases
 * differ. The three-valued logic, the keyset cursor and the allowlist are the
 * compiler's and the same for every dialect; a dialect only spells the pieces.
 * A `FieldResolver` carries it (`dialect`, `postgresDialect` when absent).
 *
 * Every method gets values the compiler already checked (`coerce`); a
 * dialect binds them as parameters and never writes one into the text.
 */
export interface SqlDialect {
  /** `postgres`, `sqlite`: for messages, and for a host that branches on it. */
  readonly name: string;
  /**
   * A value bound as a parameter of `cast`: a filter value (a number, a
   * boolean, a date or datetime string, a string) or a cursor value (the text
   * `sortKeyText` selected).
   */
  param(value: unknown, cast: SqlCast): SQL;
  /** A row id (a string, as a cursor and `read` carry it) as a parameter of its type. */
  idParam(id: string, idType: SqlIdType): SQL;
  /** The row id expression as text: the `id` filter compares it so, a malformed id being a miss. */
  idText(id: SQL): SQL;
  /** `expr` compared and ordered by code point, as JavaScript's `<` (BMP) and `evaluateFilter`. */
  codePointOrder(expr: SQL): SQL;
  /** The UNKNOWN (SQL NULL) of a condition whose value is missing. */
  readonly unknown: SQL;
  /** `expr` contains / starts with / ends with `text`, literally; case-insensitive when `ci`. Unparenthesised. */
  textMatch(expr: SQL, op: SqlTextOp, text: string, ci: boolean): SQL;
  /** `lhs` equals one of `items` (coerced, no nulls, possibly none), bound as ONE parameter. Unparenthesised. */
  anyOf(lhs: SQL, items: readonly unknown[], cast: SqlCast): SQL;
  /** `lhs` equals none of `items`; TRUE for no items (the caller keeps a NULL `lhs` UNKNOWN). Unparenthesised. */
  noneOf(lhs: SQL, items: readonly unknown[], cast: SqlCast): SQL;
  /**
   * Whether an element of the array value `arr` passes `test` (`negate`: none
   * does), each element as text under the name `e.el`. A value that is not
   * an array (SQL NULL, a missing field) is UNKNOWN. Parenthesised.
   */
  arrayHas(arr: SQL, form: SqlArrayForm, test: SQL, negate: boolean): SQL;
  /** The text of a sort value, selected next to each row so the next cursor can be built. */
  sortKeyText(expr: SQL): SQL;
}

/** Escape the LIKE metacharacters so the value matches literally (`\` is the escape character). */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** `%text%`, `text%`, `%text` for an already escaped LIKE text. */
export function likePattern(op: SqlTextOp, escaped: string): string {
  return op === "contains" ? `%${escaped}%` : op === "starts_with" ? `${escaped}%` : `%${escaped}`;
}

const PG_ID_CAST: Record<SqlIdType, string> = { uuid: "uuid", text: "text", integer: "bigint" };

/**
 * Postgres: every parameter cast (`$1::numeric`), `COLLATE "C"` for code
 * point order, `LIKE` / `ILIKE`, one array parameter for a list
 * (`= ANY($1::text[])`), `unnest` and `jsonb_array_elements_text` for array
 * fields. The default dialect: its text is what the compiler wrote before it
 * had dialects, byte for byte.
 */
export const postgresDialect: SqlDialect = {
  name: "postgres",
  param: (value, cast) => sql`${value}::${sql.raw(cast)}`,
  idParam: (id, idType) => sql`${id}::${sql.raw(PG_ID_CAST[idType])}`,
  idText: (id) => sql`(${id}::text)`,
  codePointOrder: (expr) => sql`(${expr} COLLATE "C")`,
  unknown: sql`NULL::boolean`,
  textMatch: (expr, op, text, ci) =>
    sql`${expr} ${sql.raw(ci ? "ILIKE" : "LIKE")} ${likePattern(op, escapeLike(text))}::text`,
  // One array parameter: a bare JS array would expand into a value list.
  anyOf: (lhs, items, cast) => sql`${lhs} = ANY(${sql.param(items)}::${sql.raw(cast)}[])`,
  noneOf: (lhs, items, cast) => sql`${lhs} <> ALL(${sql.param(items)}::${sql.raw(cast)}[])`,
  arrayHas: (arr, form, test, negate) => {
    if (form === "text[]") {
      // Any element type, compared as text, as the jsonb elements are.
      const elems = sql`(SELECT u.v::text AS el FROM unnest(${arr}) AS u(v)) AS e`;
      const exists = sql`EXISTS (SELECT 1 FROM ${elems} WHERE ${test})`;
      return sql`(CASE WHEN ${arr} IS NOT NULL THEN ${negate ? sql`NOT ${exists}` : exists} ELSE NULL END)`;
    }
    const exists = sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${arr}) AS e(el) WHERE ${test})`;
    return sql`(CASE WHEN jsonb_typeof(${arr}) = 'array' THEN ${negate ? sql`NOT ${exists}` : exists} ELSE NULL END)`;
  },
  sortKeyText: (expr) => sql`(${expr})::text`,
};
