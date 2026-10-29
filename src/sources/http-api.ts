import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Capabilities,
  type FieldDef,
  getPath,
  type HttpApiAuth,
  type HttpApiHistory,
  type HttpApiOptions,
  historyFieldName,
  parseFieldPath,
  type Row,
  type SchemaDoc,
  type SourceInfo,
  UdcError,
  withHistoryFields,
} from "@jsudc/core";
import { type ArrayLoad, ArraySource, READ_ONLY_ARRAY_CAPABILITIES } from "./array.js";

/** The part of `fetch` the source uses; a test hands in its own. */
export type FetchLike = (
  url: string,
  init: {
    headers: Record<string, string>;
    signal: AbortSignal;
    method?: string;
    body?: string;
  },
) => Promise<{ ok: boolean; status: number; statusText: string; json(): Promise<unknown> }>;

export type Env = Record<string, string | undefined>;

/** Where a source says what it did upstream: one line per call, a warning when the credential fails. */
export interface SourceLog {
  info(msg: string): void;
  warn(msg: string): void;
}

const NO_LOG: SourceLog = { info: () => {}, warn: () => {} };

const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * The headers with every `${VAR}` filled from `env`. A header naming a
 * variable that is unset (or empty) is dropped whole: no `Bearer ` with
 * nothing after it.
 */
export function interpolateHeaders(
  headers: Record<string, string> | undefined,
  env: Env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, template] of Object.entries(headers ?? {})) {
    let missing = false;
    const value = template.replace(VAR_RE, (_, v: string) => {
      const got = env[v];
      if (got === undefined || got === "") missing = true;
      return got ?? "";
    });
    if (!missing) out[name] = value;
  }
  return out;
}

const finite = (n: number) => (Number.isFinite(n) ? n : null);

/** One upstream value as the schema type wants it; `null` when it cannot be read as one. */
export function coerceValue(v: unknown, def: FieldDef): unknown {
  if (v === null || v === undefined) return null;
  switch (def.type) {
    case "integer":
    case "year": {
      const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
      return Number.isFinite(n) ? Math.trunc(n) : null;
    }
    case "decimal":
    case "rating":
      return typeof v === "number"
        ? finite(v)
        : typeof v === "string" && v.trim()
          ? finite(Number(v))
          : null;
    case "bool":
      if (typeof v === "boolean") return v;
      if (v === "true" || v === 1 || v === "1") return true;
      if (v === "false" || v === 0 || v === "0") return false;
      return null;
    case "datetime":
    case "date": {
      // Epoch milliseconds (USGS) or an ISO string (GitHub); always out as ISO.
      const ms = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
      if (!Number.isFinite(ms)) return null;
      const iso = new Date(ms).toISOString();
      return def.type === "date" ? iso.slice(0, 10) : iso;
    }
    case "string_array":
    case "lookup_array":
      if (Array.isArray(v)) return v.filter((x) => x !== null && x !== undefined).map(String);
      return typeof v === "string" ? [v] : null;
    case "json":
      return v;
    default:
      // Upstream padding is never content: OpenSky pads a callsign to 8 characters.
      if (typeof v === "string") return v.trim();
      if (typeof v === "number" || typeof v === "boolean") return String(v);
      return JSON.stringify(v);
  }
}

/** `path` is there and `null` (not missing): `{"states": null}`. */
function holdsNull(body: unknown, path: string): boolean {
  const steps = parseFieldPath(path);
  const last = steps?.at(-1);
  if (!steps || !last || !("key" in last)) return false;
  const parent = steps.length > 1 ? getPath(body, steps.slice(0, -1)) : body;
  return (
    parent !== null &&
    typeof parent === "object" &&
    Object.hasOwn(parent, last.key) &&
    (parent as Record<string, unknown>)[last.key] === null
  );
}

/**
 * The rows of one upstream response: `list_unwrap` walked to the array,
 * each item mapped field by field (`field_map[field]`, else `item[field]`)
 * and coerced by the schema type (a number in an `epoch_seconds` field is
 * read as seconds); `__meta.id` from `id_field` (a missing or repeated id
 * gets the item's position appended). A `null` at `list_unwrap` is no rows
 * (OpenSky's empty box).
 */
export function mapItems(body: unknown, schema: SchemaDoc, opts: HttpApiOptions): Row[] {
  const list = opts.list_unwrap ? getPath(body, opts.list_unwrap) : body;
  if (list === null && opts.list_unwrap && holdsNull(body, opts.list_unwrap)) return [];
  if (!Array.isArray(list)) {
    throw new UdcError(
      "internal",
      opts.list_unwrap
        ? `upstream answer has no array at ${opts.list_unwrap}`
        : "upstream answer is not an array",
    );
  }
  const fields = schema.field_order.filter((f) => !schema.fields[f]?.deleted);
  const seconds = new Set(opts.epoch_seconds ?? []);
  const seen = new Set<string>();
  return list.slice(0, opts.max_rows).map((item, i) => {
    const raw = getPath(item, opts.id_field);
    let id = raw === null || typeof raw === "object" ? `#${i}` : String(raw);
    if (seen.has(id)) id = `${id}#${i}`;
    seen.add(id);
    const row: Row = { __meta: { id, version: 1 } };
    for (const f of fields) {
      const v = getPath(item, opts.field_map[f] ?? f);
      row[f] = coerceValue(
        seconds.has(f) && typeof v === "number" ? v * 1000 : v,
        schema.fields[f] as FieldDef,
      );
    }
    return row;
  });
}

/**
 * The sliding window of `history`: per row id, the last `size` values of
 * each field. `apply` is one poll: every row's current values appended (a
 * null skipped) and served as `<field>_history`, oldest first; an id absent
 * for `ttl_polls` polls in a row is forgotten.
 */
export class HistoryWindow {
  private readonly ids = new Map<string, { missed: number; values: Map<string, number[]> }>();

  constructor(private readonly cfg: HttpApiHistory) {}

  apply(rows: Row[]): Row[] {
    const seen = new Set<string>();
    const out = rows.map((row) => {
      const id = row.__meta.id;
      seen.add(id);
      let entry = this.ids.get(id);
      if (!entry) {
        entry = { missed: 0, values: new Map() };
        this.ids.set(id, entry);
      }
      entry.missed = 0;
      const next: Row = { ...row };
      for (const f of this.cfg.fields) {
        const list = entry.values.get(f) ?? [];
        const v = row[f];
        if (typeof v === "number" && Number.isFinite(v)) {
          list.push(v);
          if (list.length > this.cfg.size) list.splice(0, list.length - this.cfg.size);
        }
        entry.values.set(f, list);
        next[historyFieldName(f)] = [...list];
      }
      return next;
    });
    for (const [id, entry] of this.ids) {
      if (seen.has(id)) continue;
      entry.missed += 1;
      if (entry.missed >= this.cfg.ttl_polls) this.ids.delete(id);
    }
    return out;
  }
}

interface Token {
  value: string;
  /** When to fetch the next one (ms): 90 % of `expires_in` after this one came. */
  refreshAt: number;
}

/** A token endpoint without `expires_in`: assume five minutes. */
const DEFAULT_EXPIRES_IN_S = 300;

/**
 * An OAuth2 client-credentials grant: one token, reused until 90 % of its
 * lifetime, then fetched again. `active` is false (and nothing is ever
 * fetched) when either variable is unset.
 */
export class OAuthClient {
  private token: Token | null = null;
  private readonly id: string | undefined;
  private readonly secret: string | undefined;

  constructor(
    private readonly auth: HttpApiAuth,
    env: Env,
    private readonly fetch: FetchLike,
    private readonly now: () => number,
    private readonly timeoutMs: number,
  ) {
    this.id = env[auth.client_id_env] || undefined;
    this.secret = env[auth.client_secret_env] || undefined;
  }

  get active(): boolean {
    return this.id !== undefined && this.secret !== undefined;
  }

  /** A valid bearer token; `fresh` drops the cached one first (after a 401). Throws when the endpoint fails. */
  async bearer(fresh = false): Promise<string> {
    if (fresh) this.token = null;
    if (this.token && this.now() < this.token.refreshAt) return this.token.value;
    const at = this.now();
    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.id ?? "",
      client_secret: this.secret ?? "",
    });
    if (this.auth.scope) form.set("scope", this.auth.scope);
    const res = await this.fetch(this.auth.token_url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form.toString(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`token endpoint answered ${res.status} ${res.statusText}`.trim());
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string" || body.access_token === "") {
      throw new Error("token endpoint answered without an access_token");
    }
    const ttl = typeof body.expires_in === "number" ? body.expires_in : DEFAULT_EXPIRES_IN_S;
    this.token = { value: body.access_token, refreshAt: at + ttl * 1000 * 0.9 };
    return this.token.value;
  }
}

interface Snapshot {
  rows: Row[];
  /** When upstream answered them (ms). */
  fetchedAt: number;
  /** When upstream was last asked, answered or not (ms): the TTL runs from here. */
  checkedAt: number;
  stale: boolean;
}

/**
 * A collection fetched from an HTTP JSON API. The mapped array is kept in
 * memory for `cache_ttl_ms` (`cache_ttl_ms_authenticated` while the `auth`
 * client is in use): every `list` inside it (filter, sort, page) is served
 * without calling upstream, concurrent misses share one call. When
 * upstream fails after a good fetch the old array is served with
 * `stale: true` (and the next attempt waits another TTL); a failing first
 * fetch answers `internal` with the upstream status.
 *
 * `history` runs on every upstream answer, after mapping and before the
 * snapshot is kept, and its `<field>_history` fields are in the schema
 * `describe` serves. `auth` (OAuth2 client credentials) sends a bearer
 * token when both variables are set: a 401 is retried once with a fresh
 * token, a failing token endpoint leaves that one poll anonymous (logged
 * once until the endpoint answers again).
 *
 * With `fixturesDir` the response is read from `<fixturesDir>/<name>.json`
 * and nothing goes out; when `<name>.1.json` exists, successive upstream
 * calls read `.1`, `.2`, … and then keep reading the last one.
 */
export class HttpApiSource extends ArraySource {
  readonly capabilities: Capabilities = { ...READ_ONLY_ARRAY_CAPABILITIES };
  readonly kind = "http_api";
  // Unsorted, the rows come as upstream sent them: USGS newest first, GitHub by last update.
  protected override readonly keepOrder = true;
  protected readonly label: string;
  readonly name: string;
  private readonly opts: HttpApiOptions;
  private readonly fetch: FetchLike;
  private readonly env: Env;
  private readonly fixturesDir: string | undefined;
  private readonly now: () => number;
  private readonly log: SourceLog;
  /** The schema the rows are mapped by: the one written, without the history fields. */
  private readonly mapSchema: SchemaDoc;
  private readonly history: HistoryWindow | null;
  private readonly oauth: OAuthClient | null;
  /** How the last upstream call went out; `null` before the first. */
  private lastAuth: "oauth2" | "anonymous" | null = null;
  /** The token endpoint is failing: logged once, until it answers again. */
  private tokenFailing = false;
  private fixturePoll = 0;
  private snapshot: Snapshot | null = null;
  private inflight: Promise<Snapshot> | null = null;

  constructor(args: {
    name: string;
    schema: SchemaDoc;
    options: HttpApiOptions;
    fetch?: FetchLike | undefined;
    env?: Env | undefined;
    fixturesDir?: string | undefined;
    now?: (() => number) | undefined;
    pageSizeDefault?: number | undefined;
    log?: SourceLog | undefined;
  }) {
    super({ ...args, schema: withHistoryFields(args.schema, args.options.history) });
    this.name = args.name;
    this.label = `collection ${args.name} (http_api)`;
    this.opts = args.options;
    this.mapSchema = args.schema;
    this.fetch = args.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.env = args.env ?? {};
    this.fixturesDir = args.fixturesDir;
    this.now = args.now ?? Date.now;
    this.log = args.log ?? NO_LOG;
    this.history = args.options.history ? new HistoryWindow(args.options.history) : null;
    const oauth = args.options.auth
      ? new OAuthClient(args.options.auth, this.env, this.fetch, this.now, args.options.timeout_ms)
      : null;
    this.oauth = oauth?.active ? oauth : null;
  }

  /** `oauth2` while the client is configured and its last poll used it; else `anonymous`. */
  private get auth(): "oauth2" | "anonymous" {
    if (!this.oauth || this.fixturesDir !== undefined) return "anonymous";
    return this.lastAuth ?? "oauth2";
  }

  /** The TTL the cache runs on now: the authenticated one while authenticated. */
  get cacheTtlMs(): number {
    const authed = this.opts.cache_ttl_ms_authenticated;
    return this.auth === "oauth2" && authed !== undefined ? authed : this.opts.cache_ttl_ms;
  }

  /** For `describe`: the credential in use and the cache TTL. */
  info(): SourceInfo {
    return { auth: this.auth, cache_ttl_ms: this.cacheTtlMs };
  }

  get url(): string {
    return this.opts.base_url.replace(/\/+$/, "") + this.opts.list_endpoint;
  }

  protected async load(): Promise<ArrayLoad> {
    const snap = await this.current();
    const rows = snap.stale
      ? snap.rows.map((r) => ({ ...r, __meta: { ...r.__meta, stale: true } }))
      : snap.rows;
    return {
      rows,
      extra: { fetched_at: new Date(snap.fetchedAt).toISOString(), stale: snap.stale },
    };
  }

  private async current(): Promise<Snapshot> {
    const missing = (this.opts.env_required ?? []).filter((v) => !this.env[v]);
    if (missing.length > 0) {
      throw new UdcError(
        "unsupported_op",
        `${this.label} needs ${missing.join(", ")} set in the server's environment`,
        { env_required: missing },
      );
    }
    const snap = this.snapshot;
    if (snap && this.now() - snap.checkedAt < this.cacheTtlMs) return snap;
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async refresh(): Promise<Snapshot> {
    const at = this.now();
    try {
      const mapped = mapItems(await this.fetchBody(), this.mapSchema, this.opts);
      const rows = this.history ? this.history.apply(mapped) : mapped;
      this.snapshot = { rows, fetchedAt: at, checkedAt: at, stale: false };
      return this.snapshot;
    } catch (err) {
      const old = this.snapshot;
      if (!old) throw err instanceof UdcError ? err : this.upstreamError(err);
      this.snapshot = { ...old, checkedAt: at, stale: true };
      return this.snapshot;
    }
  }

  private async fetchBody(): Promise<unknown> {
    if (this.fixturesDir !== undefined) return this.readFixture(this.fixturesDir);
    let token = await this.bearer(false);
    let res = await this.get(token);
    if (res.status === 401 && token !== null) {
      // An expired or revoked token: one retry with a fresh one.
      token = await this.bearer(true);
      if (token !== null) res = await this.get(token);
    }
    this.lastAuth = this.oauth ? (token === null ? "anonymous" : "oauth2") : null;
    this.log.info(
      `${this.name}: GET ${this.url} → ${res.status} (${token === null ? "anonymous" : "oauth2"})`,
    );
    if (!res.ok) {
      throw new UdcError("internal", `upstream answered ${res.status} ${res.statusText}`.trim(), {
        url: this.url,
        status: res.status,
      });
    }
    return res.json();
  }

  private get(token: string | null) {
    const headers = interpolateHeaders(this.opts.headers, this.env);
    if (token !== null) headers.Authorization = `Bearer ${token}`;
    return this.fetch(this.url, { headers, signal: AbortSignal.timeout(this.opts.timeout_ms) });
  }

  /** The client's token, or `null` (anonymous) without a client or when its endpoint fails. */
  private async bearer(fresh: boolean): Promise<string | null> {
    if (!this.oauth) return null;
    try {
      const token = await this.oauth.bearer(fresh);
      this.tokenFailing = false;
      return token;
    } catch (err) {
      if (!this.tokenFailing) {
        this.tokenFailing = true;
        const reason = err instanceof Error ? err.message : String(err);
        this.log.warn(`${this.name}: ${reason}; calling upstream anonymously until it answers`);
      }
      return null;
    }
  }

  /** `<name>.json`, or `<name>.1.json`, `.2`, … one per upstream call, the last one repeating. */
  private async readFixture(dir: string): Promise<unknown> {
    let file = join(dir, `${this.name}.json`);
    if (existsSync(join(dir, `${this.name}.1.json`))) {
      let n = this.fixturePoll + 1;
      while (n > 1 && !existsSync(join(dir, `${this.name}.${n}.json`))) n -= 1;
      this.fixturePoll = n;
      file = join(dir, `${this.name}.${n}.json`);
    }
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch (err) {
      throw new UdcError("internal", `fixture ${file} cannot be read`, {
        fixture: file,
        reason: (err as Error).message,
      });
    }
  }

  private upstreamError(err: unknown): UdcError {
    const reason = err instanceof Error ? err.message : String(err);
    return new UdcError("internal", `upstream unreachable: ${reason}`, {
      url: this.url,
      status: null,
      reason,
    });
  }
}
