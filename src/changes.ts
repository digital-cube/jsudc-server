import {
  type ChangeEvent,
  type ChangeOp,
  evaluateFilter,
  type FilterNode,
  ROW_ID,
} from "@jsudc/core";
import { type RowScopeOptions, rowScopePins } from "./scope.js";

/**
 * The values of one or more changed rows that a row scope can test, kept on
 * the server only: a subscriber whose scope holds for them is told, with the
 * ids of the rows they belong to.
 */
export interface ChangeMatch {
  /** The rows these values belong to; absent: every id of the notice (or the whole collection). */
  ids?: string[] | undefined;
  /** Field values (scalars and short arrays of scalars; no `__meta`). */
  values: Record<string, unknown>;
}

/**
 * One change as it travels between the processes of a server (the bus): the
 * event every client may receive, and, server side only, the values a scope
 * tests. It never reaches a client as it is.
 */
export interface ChangeNotice {
  collection: string;
  op: ChangeOp;
  /** The changed rows; absent: "this collection changed". */
  ids?: string[] | undefined;
  /**
   * What the scope rule tests. Absent: nothing is known about the rows, and
   * only subscribers with no scope on the collection are told.
   */
  match?: ChangeMatch[] | undefined;
}

export type ChangeListener = (notice: ChangeNotice) => void;

/**
 * How notices reach every process of the server: `publish` sends one to all
 * of them (this one included), `subscribe` registers a listener and returns
 * its unsubscribe. `MemoryChangeBus` is one process; `PostgresChangeBus`
 * spans processes on one database over `LISTEN` / `NOTIFY`; a host may pass
 * its own (Redis pub/sub, NATS, …). Delivery is at most once: there is no
 * replay, a client refetches after a reconnect.
 */
export interface ChangeBus {
  publish(notice: ChangeNotice): void | Promise<void>;
  subscribe(listener: ChangeListener): () => void;
  /** Release connections; the feed's `close` calls it. */
  close?(): void | Promise<void>;
}

/** The default bus: listeners in this process only (one server process). */
export class MemoryChangeBus implements ChangeBus {
  private readonly listeners = new Set<ChangeListener>();

  publish(notice: ChangeNotice): void {
    for (const listener of [...this.listeners]) listener(notice);
  }

  subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** How many listeners are subscribed. */
  get size(): number {
    return this.listeners.size;
  }
}

/** Burst control: past `maxEvents` events for one collection within `windowMs`, the rest become one event without ids. */
export interface ChangeCoalesceOptions {
  /** Default 250 ms. */
  windowMs?: number | undefined;
  /** Default 20. */
  maxEvents?: number | undefined;
}

export interface ChangeFeedOptions {
  /** Default: a `MemoryChangeBus` (one process). */
  bus?: ChangeBus | undefined;
  /** How often the stream sends a heartbeat comment. Default 15 000 ms. */
  heartbeatMs?: number | undefined;
  /** The `retry:` hint of the stream: how long a client waits before it reconnects. Default 3000 ms. */
  retryMs?: number | undefined;
  /** Burst control per stream and collection; `false` sends every event. */
  coalesce?: ChangeCoalesceOptions | false | undefined;
  /** An event naming more rows than this is sent without ids. Default 500. */
  maxIds?: number | undefined;
  /** Where a failing bus is logged (the dispatcher's log when the feed is given to one). */
  log?: { error(obj: unknown, msg?: string): void } | undefined;
}

/** What a host passes to `notify`. */
export interface NotifyOptions<Ctx = unknown> {
  /** What happened. Default `"update"`. */
  op?: ChangeOp | undefined;
  /** The changed rows; absent: "this collection changed". */
  ids?: readonly string[] | undefined;
  /**
   * The request context the rows belong to (the user a background job wrote
   * for): the `eq` conditions of the row scope for it are the values the
   * scope rule tests, so only that scope is told.
   */
  ctx?: Ctx | undefined;
  /**
   * The changed rows' values (any fields a scope tests; a `__meta.id` names
   * the row). Preferred over `ctx` when both are given.
   */
  rows?: readonly Record<string, unknown>[] | undefined;
}

/** One stream's subscription: the scope of every collection it asked for, and where events go. */
export interface ChangeSubscriber {
  /** Collection → the subscriber's row scope on it (`undefined`: none). */
  scopes: ReadonlyMap<string, FilterNode | undefined>;
  send(event: ChangeEvent): void;
}

const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_RETRY_MS = 3000;
const DEFAULT_WINDOW_MS = 250;
const DEFAULT_MAX_EVENTS = 20;
const DEFAULT_MAX_IDS = 500;
/** Longer strings are not kept for the scope rule: a scope tests ids and short codes. */
const MAX_VALUE_LENGTH = 256;
const MAX_ARRAY_VALUES = 64;

type Scalar = string | number | boolean | null;

function keptScalar(v: unknown): v is Scalar {
  if (v === null || typeof v === "number" || typeof v === "boolean") return true;
  return typeof v === "string" && v.length <= MAX_VALUE_LENGTH;
}

/**
 * The values of a row the scope rule keeps: scalars (strings up to 256
 * characters) and arrays of up to 64 of them; the row id as `id` when the
 * row has no such field. Row contents beyond that never sit in a notice.
 */
export function scopeValues(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(row)) {
    if (field === "__meta") continue;
    if (keptScalar(value)) out[field] = value;
    else if (
      Array.isArray(value) &&
      value.length <= MAX_ARRAY_VALUES &&
      value.every((v) => keptScalar(v))
    ) {
      out[field] = value;
    }
  }
  const id = (row.__meta as { id?: unknown } | undefined)?.id;
  if (typeof id === "string" && !Object.hasOwn(out, ROW_ID)) out[ROW_ID] = id;
  return out;
}

function rowId(row: Record<string, unknown>): string | undefined {
  const id = (row.__meta as { id?: unknown } | undefined)?.id;
  return typeof id === "string" ? id : undefined;
}

function unique(ids: Iterable<string>): string[] {
  return [...new Set(ids)];
}

/**
 * The event a subscriber with `scope` on the collection receives for
 * `notice`, or `null` when it is told nothing: no scope, every id; a scope,
 * only when it holds for at least one row's values, and then only those rows'
 * ids. A notice with nothing to test never crosses a scope.
 */
export function eventFor(
  notice: ChangeNotice,
  scope: FilterNode | undefined,
): Omit<ChangeEvent, "collection"> | null {
  const base = { op: notice.op };
  if (!scope) return notice.ids ? { ...base, ids: notice.ids } : base;
  if (!notice.match) return null;
  const ids: string[] = [];
  let whole = false;
  let any = false;
  for (const m of notice.match) {
    let holds = false;
    try {
      holds = evaluateFilter(scope, m.values);
    } catch {
      holds = false;
    }
    if (!holds) continue;
    any = true;
    const these = m.ids ?? notice.ids;
    if (these) ids.push(...these);
    else whole = true;
  }
  if (!any) return null;
  return whole ? base : { ...base, ids: unique(ids) };
}

/** Holds a stream to `maxEvents` events per collection per window; the rest go out as one, without ids. */
class Coalescer {
  private readonly state = new Map<
    string,
    { start: number; count: number; ops: Set<ChangeOp>; timer?: ReturnType<typeof setTimeout> }
  >();

  constructor(
    private readonly send: (event: ChangeEvent) => void,
    private readonly windowMs: number,
    private readonly maxEvents: number,
  ) {}

  push(event: ChangeEvent): void {
    const now = Date.now();
    let s = this.state.get(event.collection);
    if (!s || (now - s.start >= this.windowMs && !s.timer)) {
      s = { start: now, count: 0, ops: new Set() };
      this.state.set(event.collection, s);
    }
    s.count += 1;
    if (s.count <= this.maxEvents) {
      this.send(event);
      return;
    }
    s.ops.add(event.op);
    if (s.timer) return;
    const held = s;
    held.timer = setTimeout(
      () => {
        this.state.delete(event.collection);
        const [only] = held.ops;
        this.send({
          collection: event.collection,
          op: held.ops.size === 1 && only ? only : "update",
        });
      },
      Math.max(0, held.start + this.windowMs - now),
    );
  }

  close(): void {
    for (const s of this.state.values()) clearTimeout(s.timer);
    this.state.clear();
  }
}

/**
 * The change feed of one server process. Give it to `createDispatcher`
 * (`changes`): every collection then reports `capabilities.changes`, jsudc's
 * own writes (`mutate`, `mutate_many`, `reindex`, `tree.reparent`) notify it
 * after they commit, and `udcPlugin` serves the stream at `GET /udc/changes`.
 * A host calls `notify` after writes jsudc did not make. Several processes
 * share one `bus`.
 */
export class ChangeFeed {
  readonly bus: ChangeBus;
  readonly heartbeatMs: number;
  readonly retryMs: number;
  private readonly coalesce: { windowMs: number; maxEvents: number } | false;
  private readonly maxIds: number;
  private log: ChangeFeedOptions["log"];
  private scope: RowScopeOptions = {};
  private readonly subscribers = new Set<ChangeSubscriber>();
  private unsubscribeBus: (() => void) | undefined;

  constructor(opts: ChangeFeedOptions = {}) {
    this.bus = opts.bus ?? new MemoryChangeBus();
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;
    this.coalesce =
      opts.coalesce === false
        ? false
        : {
            windowMs: opts.coalesce?.windowMs ?? DEFAULT_WINDOW_MS,
            maxEvents: opts.coalesce?.maxEvents ?? DEFAULT_MAX_EVENTS,
          };
    this.maxIds = opts.maxIds ?? DEFAULT_MAX_IDS;
    this.log = opts.log;
  }

  /**
   * Bind the feed to a dispatcher's scope hooks (and its log): `createDispatcher`
   * calls it. `notify` resolves `ctx` through them.
   */
  attach(scope: RowScopeOptions, log?: ChangeFeedOptions["log"]): void {
    this.scope = scope;
    this.log ??= log;
  }

  /** How many streams of this process are subscribed. */
  get listenerCount(): number {
    return this.subscribers.size;
  }

  /**
   * Tell every stream that may see them that rows of `collection` changed —
   * what a host calls after its own writes (a sync job, an import). With
   * `rows`, a scoped stream is told when its scope holds for one of them;
   * with `ctx`, when its scope agrees with the `eq` conditions of the scope
   * for that context. Neither, on a collection that has a row scope, throws:
   * nothing is broadcast across scopes. Resolves when the bus took it.
   */
  async notify<Ctx = unknown>(collection: string, opts: NotifyOptions<Ctx> = {}): Promise<void> {
    const op = opts.op ?? "update";
    let match: ChangeMatch[] | undefined;
    let ids = opts.ids ? [...opts.ids] : undefined;
    if (opts.rows) {
      match = opts.rows.map((row) => {
        const id = rowId(row);
        return id === undefined
          ? { values: scopeValues(row) }
          : { ids: [id], values: scopeValues(row) };
      });
      if (!ids) {
        const named = opts.rows.map(rowId);
        if (named.length > 0 && named.every((id) => id !== undefined))
          ids = unique(named as string[]);
      }
    } else if (opts.ctx !== undefined) {
      const scope = this.scope.rowScope?.(opts.ctx, collection);
      if (scope) match = [{ values: rowScopePins(scope) }];
    } else if (this.hasScope(collection)) {
      throw new Error(
        `ChangeFeed.notify(${JSON.stringify(collection)}): the collection has a row scope; ` +
          "pass the ctx the rows belong to, or the rows, so only that scope is told",
      );
    }
    await this.publish({ collection, op, ids, match });
  }

  /**
   * Whether `collection` has a row scope, without a request at hand: the
   * dispatcher's `rowScope` asked with no context answers a filter, or throws
   * (it reads a context that is not there). Answering `undefined` for no
   * context reads as unscoped, so such a notice reaches only unscoped streams.
   */
  private hasScope(collection: string): boolean {
    const { rowScope } = this.scope;
    if (!rowScope) return false;
    try {
      return rowScope(undefined, collection) !== undefined;
    } catch {
      return true;
    }
  }

  /**
   * jsudc's own write, after its commit: the rows as the source answered them
   * (`__meta.id` and every field, the scope fields included), `before` rows
   * for an update. `ids: false` sends no ids (a write that touched more rows
   * than it names).
   */
  async written(
    collection: string,
    op: ChangeOp,
    rows: readonly Record<string, unknown>[],
    opts: { ids?: false | readonly string[]; match?: ChangeMatch[] } = {},
  ): Promise<void> {
    const match = [
      ...rows.map((row) => {
        const id = rowId(row);
        return id === undefined || opts.ids === false
          ? { values: scopeValues(row) }
          : { ids: [id], values: scopeValues(row) };
      }),
      ...(opts.match ?? []),
    ];
    const named = rows.map(rowId).filter((id): id is string => id !== undefined);
    const ids =
      opts.ids === false
        ? undefined
        : opts.ids
          ? [...opts.ids]
          : named.length
            ? unique(named)
            : undefined;
    await this.publish({ collection, op, ids, match });
  }

  /** Publish a notice on the bus; a failing bus is logged, never thrown into a committed write. */
  async publish(notice: ChangeNotice): Promise<void> {
    const ids = notice.ids && notice.ids.length > this.maxIds ? undefined : notice.ids;
    const match = notice.match?.map((m) =>
      m.ids && m.ids.length > this.maxIds ? { values: m.values } : m,
    );
    const capped: ChangeNotice = {
      collection: notice.collection,
      op: notice.op,
      ...(ids ? { ids } : {}),
      ...(match ? { match } : {}),
    };
    // Without ids on the notice, a match's ids would be all a scoped stream gets: drop them too.
    if (!capped.ids && capped.match) capped.match = capped.match.map((m) => ({ values: m.values }));
    this.ensureListening();
    try {
      await this.bus.publish(capped);
    } catch (err) {
      this.log?.error({ err, collection: notice.collection }, "udc change feed: publish failed");
    }
  }

  /**
   * A stream's subscription; returns its unsubscribe. Events are filtered by
   * the scope rule, ids capped, bursts coalesced, before `send`.
   */
  subscribe(sub: ChangeSubscriber): () => void {
    const coalescer = this.coalesce
      ? new Coalescer((e) => sub.send(e), this.coalesce.windowMs, this.coalesce.maxEvents)
      : undefined;
    const entry: ChangeSubscriber = {
      scopes: sub.scopes,
      send: (e) => (coalescer ? coalescer.push(e) : sub.send(e)),
    };
    this.subscribers.add(entry);
    this.ensureListening();
    return () => {
      coalescer?.close();
      this.subscribers.delete(entry);
    };
  }

  private ensureListening(): void {
    this.unsubscribeBus ??= this.bus.subscribe((notice) => this.deliver(notice));
  }

  private deliver(notice: ChangeNotice): void {
    for (const sub of this.subscribers) {
      if (!sub.scopes.has(notice.collection)) continue;
      const event = eventFor(notice, sub.scopes.get(notice.collection));
      if (!event) continue;
      try {
        sub.send({ collection: notice.collection, ...event });
      } catch (err) {
        this.log?.error({ err, collection: notice.collection }, "udc change feed: send failed");
      }
    }
  }

  /** Stop listening to the bus and close it. Open streams end with their server. */
  async close(): Promise<void> {
    this.unsubscribeBus?.();
    this.unsubscribeBus = undefined;
    await this.bus.close?.();
  }
}

/** A change feed: `createDispatcher(registry, { changes: createChangeFeed() })`. */
export function createChangeFeed(opts: ChangeFeedOptions = {}): ChangeFeed {
  return new ChangeFeed(opts);
}
