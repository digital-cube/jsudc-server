import type { Executor } from "../db/client.js";
import type { OnMutateResult, RowChange } from "./on-mutate.js";

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
