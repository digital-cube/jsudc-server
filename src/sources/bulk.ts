import { type MutateManyFailure, UdcError } from "@jsudc/core";
import { type SQL, sql } from "drizzle-orm";
import { notFound } from "./fields.js";
import type { SqlIdType } from "./sql.js";

/** How many rows one `mutate_many` request may touch unless the host says otherwise. */
export const DEFAULT_MUTATE_MANY_LIMIT = 10_000;

/** The refusal of a request that would touch more than `limit` rows: nothing is written. */
export function tooManyRows(collection: string, limit: number, by: "ids" | "filter"): UdcError {
  return new UdcError(
    "validation_error",
    `mutate_many on ${collection}: the ${by} reach${by === "ids" ? "" : "es"} more than ${limit} rows`,
    { collection, reason: "too_many_rows", limit, by },
  );
}

/** One id that was not changed because it is not there (missing, or outside the scope). */
export function notFoundFailure(id: string): MutateManyFailure {
  return { id, code: "not_found", message: notFound(id).message };
}

/** The ids of `requested` that are not in `found`, in request order, as `not_found` failures. */
export function missing(
  requested: readonly string[],
  found: ReadonlySet<string>,
): MutateManyFailure[] {
  return requested.filter((id) => !found.has(id)).map(notFoundFailure);
}

const ARRAY_CAST: Record<SqlIdType, string> = {
  uuid: "uuid[]",
  text: "text[]",
  integer: "bigint[]",
};

/** One element of a Postgres array literal, quoted. */
function element(id: string): string {
  return `"${id.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** `ids` as one array parameter of the id type (`$1::uuid[]`); the ids are already of that type. */
export function idArray(ids: readonly string[], idType: SqlIdType): SQL {
  return sql`${`{${ids.map(element).join(",")}}`}::${sql.raw(ARRAY_CAST[idType])}`;
}
