import type { MutateOp, Row } from "@jsudc/core";
import type { Executor } from "../db/client.js";
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
 * A host's own write, hung on every mutation of a Postgres source. It runs
 * inside the source's transaction, after the source's statement and before
 * `COMMIT`: the database has already accepted the change (constraints, the
 * version check, the row scope) and the row is locked. `tx` runs SQL on that
 * same transaction. Throwing rolls everything back: a `UdcError` is answered
 * to the caller as it is, anything else as `internal` (and logged). A
 * returned row is what the caller receives; the source does not write it.
 *
 * Declared as a method in the options, so a host may type `ctx` as its own
 * context.
 */
export type OnMutateHook<Ctx = unknown> = (
  ctx: Ctx,
  change: RowChange,
  tx: Executor,
) => OnMutateResult;

/** What a hook returns: nothing (the common case), or the row the caller receives. */
// biome-ignore lint/suspicious/noConfusingVoidType: a hook that returns nothing is typed `void`.
export type OnMutateResult = Row | undefined | void | Promise<Row | undefined | void>;

/** Run `hook` on `change` and answer the row the caller receives. */
export async function runOnMutate(
  hook: OnMutateHook,
  sctx: SourceContext | undefined,
  change: RowChange,
  tx: Executor,
): Promise<Row> {
  const written = (change.after ?? change.before) as Row;
  const returned = await hook(sctx?.ctx, change, tx);
  if (!returned) return written;
  // A row without `__meta` is not a protocol row: it keeps the written row's id and version.
  return returned.__meta ? returned : { ...(returned as Row), __meta: written.__meta };
}
