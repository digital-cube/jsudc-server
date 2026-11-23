import type { MutateOp, Row } from "@jsudc/core";
import type { SourceContext } from "./source.js";

/**
 * One row a mutation wrote, as the `onMutate` hook sees it. Nothing in it is
 * specific to a single-row request: a bulk action calls the hook once per row
 * with the same shape.
 */
export interface RowChange {
  op: MutateOp;
  /** The collection the write is for (the request's, or the source's table without one). */
  collection: string;
  /** The row id, as `__meta.id` carries it. */
  id: string;
  /** The row as it was: update and delete; `null` on insert. */
  before: Row | null;
  /** The row as written: insert and update; `null` on delete. */
  after: Row | null;
  /**
   * What the request wrote: the patch of an update, the fields of an insert
   * (with the row scope's pinned values), `null` on delete. No `__meta`.
   */
  patch: Record<string, unknown> | null;
}

/**
 * A hook as `runOnMutate` calls it, whatever its transaction is: the
 * Postgres sources' `OnMutateHook` (`@jsudc/server/postgres`) passes an
 * `Executor`. Kept free of any driver type so the root entry stays so.
 */
export type MutateHookOn<Tx, Ctx = unknown> = (
  ctx: Ctx,
  change: RowChange,
  tx: Tx,
) => OnMutateResult;

/** What a hook returns: nothing (the common case), or the row the caller receives. */
// biome-ignore lint/suspicious/noConfusingVoidType: a hook that returns nothing is typed `void`.
export type OnMutateResult = Row | undefined | void | Promise<Row | undefined | void>;

/** Run `hook` on `change` and answer the row the caller receives. */
export async function runOnMutate<Tx>(
  hook: MutateHookOn<Tx>,
  sctx: SourceContext | undefined,
  change: RowChange,
  tx: Tx,
): Promise<Row> {
  const written = (change.after ?? change.before) as Row;
  const returned = await hook(sctx?.ctx, change, tx);
  if (!returned) return written;
  // A row without `__meta` is not a protocol row: it keeps the written row's id and version.
  return returned.__meta ? returned : { ...(returned as Row), __meta: written.__meta };
}
