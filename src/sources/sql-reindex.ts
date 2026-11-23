import { UdcError } from "@jsudc/core";
import { type SQL, sql } from "drizzle-orm";
import type { SqlDialect } from "./sql-dialect.js";

/**
 * The parts of a relational source's `reindex` statement (`postgres_table`,
 * `sqlite_table`). The write side is the table the rows live in, by its own
 * unqualified columns; the read side is what the rows are numbered over: the
 * source's `FROM` (a table, or one with joins), its id and order expressions
 * there, and the condition (the request's scope, the base `where` and the
 * row scope) the source compiled.
 */
export interface ReindexStatement {
  table: SQL;
  id: SQL;
  order: SQL;
  /** The version column, bumped on every row renumbered; `null` without one. */
  version: SQL | null;
  from: SQL;
  fromId: SQL;
  fromOrder: SQL;
  where: SQL;
  gap: number;
  dialect: SqlDialect;
}

/**
 * One `UPDATE … FROM`: number the rows of `where` by their current order
 * (NULLS LAST, ties by id) and write `n * gap` back, bumping each version;
 * every renumbered id comes back as text (`__id`). The same text in both
 * dialects but the id cast, so the two sources renumber alike.
 */
export function reindexUpdate(s: ReindexStatement): SQL {
  const set = [
    sql`${s.order} = __r.__n * ${s.gap}`,
    ...(s.version ? [sql`${s.version} = coalesce(${s.version}, 0) + 1`] : []),
  ];
  // The subquery has only __rid and __n: every bare column of SET and WHERE is the table's.
  return sql`
    UPDATE ${s.table} SET ${sql.join(set, sql`, `)}
    FROM (
      SELECT ${s.fromId} AS __rid,
             ROW_NUMBER() OVER (ORDER BY ${s.fromOrder} ASC NULLS LAST, ${s.fromId} ASC) AS __n
      FROM ${s.from}
      WHERE ${s.where}
    ) AS __r
    WHERE ${s.id} = __r.__rid
    RETURNING ${s.dialect.idText(s.id)} AS __id`;
}

/**
 * The column a `reindex` names `field` by: a writable column of the write
 * table (`columns`), and for the order field not the id (`isId`); else
 * `validation_error`. `source` names the source in the message
 * (`postgres_table message`).
 */
export function reindexColumn<C>(
  columns: ReadonlyMap<string, C> | undefined,
  field: string,
  what: "order_field" | "scope",
  isId: (field: string) => boolean,
  source: string,
): C {
  const column = columns?.get(field);
  if (column === undefined || (what === "order_field" && isId(field))) {
    throw new UdcError(
      "validation_error",
      `reindex ${what} ${field} is not a writable column of ${source}`,
      { field },
    );
  }
  return column;
}
