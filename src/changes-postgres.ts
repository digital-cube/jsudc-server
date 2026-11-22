import { randomUUID } from "node:crypto";
import { CHANGE_OPS } from "@jsudc/core";
import pg from "pg";
import type { ChangeBus, ChangeListener, ChangeMatch, ChangeNotice } from "./changes.js";

export interface PostgresChangeBusOptions {
  /** The database every server process shares; the bus keeps one dedicated connection on it for `LISTEN`. */
  connectionString: string;
  /** Where `NOTIFY` is sent from (the host's pool, say). Default: a pool of its own, at most 2 connections. */
  pool?: pg.Pool | undefined;
  /** The `LISTEN` / `NOTIFY` channel; every process of one server must agree. Default `jsudc_changes`. */
  channel?: string | undefined;
  /** The first wait before the listening connection is reopened, doubled per failure. Default 500 ms. */
  reconnectDelayMs?: number | undefined;
  /** The longest wait between reconnect attempts. Default 30 000 ms. */
  maxReconnectDelayMs?: number | undefined;
  log?: { error(obj: unknown, msg?: string): void } | undefined;
}

export const DEFAULT_CHANGE_CHANNEL = "jsudc_changes";

/** Postgres refuses a `NOTIFY` payload of 8000 bytes or more; stay under it. */
export const NOTIFY_PAYLOAD_LIMIT = 7900;

/** A value of a match kept when one row alone is too large for a payload. */
const SHORT_VALUE = 64;

interface Wire {
  /** The publishing bus, so it skips its own notices (it delivered them already). */
  o: string;
  n: ChangeNotice;
}

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/** The match of one row cut to its short values, or `null` when even that does not fit. */
function shrink(m: ChangeMatch, fits: (m: ChangeMatch) => boolean): ChangeMatch | null {
  const values = Object.fromEntries(
    Object.entries(m.values).filter(([, v]) => JSON.stringify(v).length <= SHORT_VALUE),
  );
  const small = { values };
  return fits(small) ? small : null;
}

/**
 * The payloads one notice travels as. It fits: one. It does not: without ids
 * ("this collection changed"), and when the values a scope tests are still
 * too large, split over several payloads, each without ids.
 */
export function encodeNotice(
  notice: ChangeNotice,
  origin: string,
  limit = NOTIFY_PAYLOAD_LIMIT,
): string[] {
  const encode = (n: ChangeNotice) => JSON.stringify({ o: origin, n } satisfies Wire);
  const whole = encode(notice);
  if (bytes(whole) <= limit) return [whole];
  const base: ChangeNotice = { collection: notice.collection, op: notice.op };
  if (!notice.match) return [encode(base)];
  const values = notice.match.map((m) => ({ values: m.values }));
  const bare = encode({ ...base, match: values });
  if (bytes(bare) <= limit) return [bare];
  const fits = (m: ChangeMatch) => bytes(encode({ ...base, match: [m] })) <= limit;
  const out: string[] = [];
  let chunk: ChangeMatch[] = [];
  for (const m of values) {
    const one = fits(m) ? m : shrink(m, fits);
    if (!one) continue;
    if (chunk.length > 0 && bytes(encode({ ...base, match: [...chunk, one] })) > limit) {
      out.push(encode({ ...base, match: chunk }));
      chunk = [];
    }
    chunk.push(one);
  }
  if (chunk.length > 0) out.push(encode({ ...base, match: chunk }));
  // Every row too large to test: the notice still goes out, and reaches unscoped streams only.
  return out.length > 0 ? out : [encode(base)];
}

function decode(payload: string): Wire | null {
  try {
    const wire = JSON.parse(payload) as Partial<Wire>;
    const n = wire.n;
    if (
      typeof wire.o !== "string" ||
      !n ||
      typeof n.collection !== "string" ||
      !(CHANGE_OPS as readonly string[]).includes(n.op)
    ) {
      return null;
    }
    return wire as Wire;
  } catch {
    return null;
  }
}

/**
 * A `ChangeBus` across the server processes of one Postgres database: a
 * notice is delivered to this process's listeners at once and sent to the
 * others with `NOTIFY` on `channel`; one dedicated connection per process
 * `LISTEN`s, and is reopened (with backoff) when it drops. A notice over
 * NOTIFY's size limit goes out without ids, meaning "this collection
 * changed". Notices sent while a process's listening connection is down are
 * lost to it (no replay): its clients refetch when they reconnect.
 */
export class PostgresChangeBus implements ChangeBus {
  /** This bus's id in the payloads it sends. */
  readonly origin = randomUUID();
  readonly channel: string;
  private readonly connectionString: string;
  private readonly pool: pg.Pool;
  private readonly ownPool: boolean;
  private readonly minDelay: number;
  private readonly maxDelay: number;
  private readonly log: PostgresChangeBusOptions["log"];
  private readonly listeners = new Set<ChangeListener>();
  private client: pg.Client | undefined;
  private backendPid: number | undefined;
  private connecting = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private waiters: (() => void)[] = [];

  constructor(opts: PostgresChangeBusOptions) {
    const channel = opts.channel ?? DEFAULT_CHANGE_CHANNEL;
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(channel)) {
      throw new Error(`PostgresChangeBus: channel must be a lower-case identifier, not ${channel}`);
    }
    this.channel = channel;
    this.connectionString = opts.connectionString;
    this.ownPool = !opts.pool;
    this.pool = opts.pool ?? new pg.Pool({ connectionString: opts.connectionString, max: 2 });
    this.minDelay = opts.reconnectDelayMs ?? 500;
    this.maxDelay = opts.maxReconnectDelayMs ?? 30_000;
    this.log = opts.log;
  }

  /** Whether the listening connection is up and `LISTEN`ing. */
  get listening(): boolean {
    return this.client !== undefined;
  }

  /** The backend pid of the listening connection while it is up. */
  get pid(): number | undefined {
    return this.client ? this.backendPid : undefined;
  }

  /** Resolves once the listening connection is up (at once when it is, or the bus is closed). */
  whenListening(): Promise<void> {
    this.start();
    if (this.client || this.closed) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async publish(notice: ChangeNotice): Promise<void> {
    this.deliver(notice);
    for (const payload of encodeNotice(notice, this.origin)) {
      await this.pool.query("SELECT pg_notify($1, $2)", [this.channel, payload]);
    }
  }

  subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    this.start();
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Open the listening connection, unless it is open, opening or waiting to reopen. */
  start(): void {
    if (this.closed || this.client || this.connecting || this.timer) return;
    void this.connect();
  }

  private async connect(): Promise<void> {
    this.connecting = true;
    const client = new pg.Client({ connectionString: this.connectionString });
    let up = false;
    const lost = (err?: unknown) => {
      if (!up) return;
      up = false;
      if (this.client === client) this.client = undefined;
      if (err) this.log?.error({ err }, "udc change bus: the listening connection dropped");
      client.removeAllListeners("notification");
      void client.end().catch(() => {});
      this.reconnect();
    };
    client.on("error", lost);
    client.on("end", () => lost());
    client.on("notification", (msg) => {
      if (msg.channel !== this.channel || msg.payload === undefined) return;
      const wire = decode(msg.payload);
      if (wire && wire.o !== this.origin) this.deliver(wire.n);
    });
    try {
      await client.connect();
      up = true;
      await client.query(`LISTEN ${this.channel}`);
      const pid = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      if (this.closed) {
        up = false;
        await client.end().catch(() => {});
        return;
      }
      this.backendPid = pid.rows[0]?.pid;
      this.client = client;
      this.attempt = 0;
      for (const resolve of this.waiters.splice(0)) resolve();
    } catch (err) {
      if (up) lost(err);
      else {
        this.log?.error({ err }, "udc change bus: cannot open the listening connection");
        void client.end().catch(() => {});
        this.reconnect();
      }
    } finally {
      this.connecting = false;
    }
  }

  private reconnect(): void {
    if (this.closed || this.timer) return;
    this.attempt += 1;
    const delay = Math.min(this.maxDelay, this.minDelay * 2 ** (this.attempt - 1));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.start();
    }, delay);
  }

  private deliver(notice: ChangeNotice): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(notice);
      } catch (err) {
        this.log?.error({ err }, "udc change bus: a listener failed");
      }
    }
  }

  /** Close the listening connection (and the bus's own pool); no reconnect after it. */
  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    const client = this.client;
    this.client = undefined;
    for (const resolve of this.waiters.splice(0)) resolve();
    if (client) {
      client.removeAllListeners();
      client.on("error", () => {});
      await client.end().catch(() => {});
    }
    if (this.ownPool) await this.pool.end();
  }
}

/** A `PostgresChangeBus`: `createChangeFeed({ bus: createPostgresChangeBus({ connectionString }) })`. */
export function createPostgresChangeBus(opts: PostgresChangeBusOptions): PostgresChangeBus {
  return new PostgresChangeBus(opts);
}
