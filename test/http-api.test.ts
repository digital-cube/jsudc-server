import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type HttpApiOptions, HttpApiOptionsSchema, SchemaDocSchema } from "@jsudc/core";
import { describe, expect, it } from "vitest";
import { readCollectionAssets } from "../src/registry.js";
import {
  coerceValue,
  type FetchLike,
  HttpApiSource,
  interpolateHeaders,
  mapItems,
} from "../src/sources/http-api.js";
import { COLLECTIONS_DIR, ids, rejectsWith } from "./helpers.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "http");

const schema = SchemaDocSchema.parse({
  version: "v1",
  fields: {
    title: { type: "string" },
    count: { type: "integer" },
    score: { type: "decimal" },
    seen: { type: "datetime" },
    day: { type: "date" },
    ok: { type: "bool" },
    lng: { type: "decimal" },
    lat: { type: "decimal" },
    authors: { type: "string_array" },
    first_author: { type: "string" },
    raw: { type: "json" },
  },
});

const options = (o: Partial<HttpApiOptions> = {}): HttpApiOptions =>
  HttpApiOptionsSchema.parse({
    base_url: "https://api.example.test/",
    list_endpoint: "/v1/things?limit=5",
    id_field: "meta.key",
    list_unwrap: "data.items",
    field_map: {
      title: "info.name",
      count: "info.count",
      score: "info.score",
      seen: "info.seen_ms",
      day: "info.seen_iso",
      lng: "geo.coordinates[0]",
      lat: "geo.coordinates[1]",
      authors: "people[*].name",
      first_author: "people[0].name",
    },
    ...o,
  });

const ITEMS = [
  {
    meta: { key: "a" },
    info: {
      name: "Alpha",
      count: "7",
      score: 1.5,
      seen_ms: 1_793_144_631_480,
      seen_iso: "2026-10-27T10:00:00+02:00",
    },
    ok: "true",
    geo: { coordinates: [20.46, 44.81, 12] },
    people: [{ name: "Ana" }, { name: "Bo" }],
    raw: { x: 1 },
  },
  {
    meta: { key: "b" },
    info: { name: "Beta", count: 2.9, score: "x", seen_ms: null },
    ok: 0,
    geo: { coordinates: [] },
    people: [],
  },
  { meta: {}, info: { name: "Gamma", count: 11 }, ok: true },
];
const BODY = { data: { items: ITEMS } };

/** A fetch that answers from a script and records every call. */
function scripted(...answers: (unknown | Error | { status: number })[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const next = answers.length > 1 ? answers.shift() : answers[0];
    if (next instanceof Error) throw next;
    if (next && typeof next === "object" && "status" in next) {
      const { status } = next as { status: number };
      return { ok: false, status, statusText: "Nope", json: async () => ({}) };
    }
    return { ok: true, status: 200, statusText: "OK", json: async () => next };
  };
  return { fetch, calls };
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("field mapping", () => {
  it("walks dotted paths, [N] and [*], unwraps the list and keys rows by id_field", () => {
    const rows = mapItems(BODY, schema, options());
    expect(ids(rows)).toEqual(["a", "b", "#2"]);
    expect(rows[0]).toMatchObject({
      title: "Alpha",
      lng: 20.46,
      lat: 44.81,
      authors: ["Ana", "Bo"],
      first_author: "Ana",
      raw: { x: 1 },
    });
    expect(rows[1]).toMatchObject({ lng: null, lat: null, authors: [], first_author: null });
    // An unmapped field reads item[field].
    expect(rows.map((r) => r.ok)).toEqual([true, false, true]);
    expect(rows[0]?.__meta.version).toBe(1);
  });

  it("coerces by schema type", () => {
    const [a, b, c] = mapItems(BODY, schema, options());
    expect(a).toMatchObject({
      count: 7,
      score: 1.5,
      seen: "2026-10-27T23:43:51.480Z",
      day: "2026-10-27",
    });
    expect(b).toMatchObject({ count: 2, score: null, seen: null });
    expect(c).toMatchObject({ count: 11, authors: null, raw: null });
    expect(coerceValue("1", { type: "bool" })).toBe(true);
    expect(coerceValue("maybe", { type: "bool" })).toBeNull();
    expect(coerceValue(42, { type: "string" })).toBe("42");
    expect(coerceValue({ a: 1 }, { type: "text" })).toBe('{"a":1}');
    expect(coerceValue("tag", { type: "string_array" })).toEqual(["tag"]);
    expect(coerceValue("2026-10-27T10:00:00+02:00", { type: "datetime" })).toBe(
      "2026-10-27T08:00:00.000Z",
    );
    expect(coerceValue("not a date", { type: "datetime" })).toBeNull();
  });

  it("refuses a body without the array, numbers repeated ids, caps at max_rows", () => {
    expect(() => mapItems({ data: {} }, schema, options())).toThrow(/no array at data.items/);
    expect(() => mapItems({}, schema, options({ list_unwrap: undefined }))).toThrow(/not an array/);
    const twice = mapItems(
      [{ meta: { key: "x" } }, { meta: { key: "x" } }],
      schema,
      options({ list_unwrap: undefined }),
    );
    expect(ids(twice)).toEqual(["x", "x#1"]);
    expect(mapItems(BODY, schema, options({ max_rows: 2 }))).toHaveLength(2);
  });

  it("fills ${VAR} headers and drops one whose variable is unset", () => {
    const headers = {
      Accept: "application/json",
      Authorization: "Bearer ${TOKEN}",
      "X-Two": "${A}-${B}",
    };
    expect(interpolateHeaders(headers, { TOKEN: "t0k", A: "1", B: "2" })).toEqual({
      Accept: "application/json",
      Authorization: "Bearer t0k",
      "X-Two": "1-2",
    });
    expect(interpolateHeaders(headers, { A: "1", TOKEN: "" })).toEqual({
      Accept: "application/json",
    });
  });
});

describe("HttpApiSource", () => {
  const make = (
    fetch: FetchLike,
    extra: Partial<ConstructorParameters<typeof HttpApiSource>[0]> = {},
  ) => {
    const c = clock();
    const src = new HttpApiSource({
      name: "things",
      schema,
      options: options({
        cache_ttl_ms: 60_000,
        headers: { Authorization: "Bearer ${TOKEN}", Accept: "x" },
      }),
      fetch,
      env: {},
      now: c.now,
      ...extra,
    });
    return { src, c };
  };

  it("fetches base_url + list_endpoint with the headers, read-only, offset paging", async () => {
    const { fetch, calls } = scripted(BODY);
    const { src } = make(fetch);
    const res = await src.list({});
    expect(calls).toEqual([
      { url: "https://api.example.test/v1/things?limit=5", headers: { Accept: "x" } },
    ]);
    expect(res.total).toBe(3);
    expect(res.stale).toBe(false);
    expect(res.fetched_at).toBe(new Date(1_000_000).toISOString());
    expect(src.capabilities).toMatchObject({
      mutate: false,
      schema_edit: false,
      paging: ["offset"],
    });
    await rejectsWith(src.mutate({ op: "insert", row: {} }), "unsupported_op");
    await rejectsWith(src.list({ page: { limit: 1, cursor: "c" } }), "unsupported_op");
  });

  it("keeps the upstream order when no sort is asked for", async () => {
    const { src } = make(scripted({ data: { items: [...ITEMS].reverse() } }).fetch);
    expect(ids((await src.list({})).rows)).toEqual(["#0", "b", "a"]);
    expect(ids((await src.list({ sort: [{ field: "title" }] })).rows)).toEqual(["a", "b", "#0"]);
  });

  it("filters, sorts and pages the fetched array in memory", async () => {
    const { src } = make(scripted(BODY).fetch);
    const res = await src.list({
      filter: { field: "count", op: "gte", value: 3 },
      sort: [{ field: "count", dir: "desc" }],
      page: { limit: 1 },
    });
    expect(res.rows.map((r) => r.title)).toEqual(["Gamma"]);
    expect(res.total).toBe(2);
    const second = await src.list({
      sort: [{ field: "count", dir: "desc" }],
      page: { limit: 1, offset: 1 },
    });
    expect(second.rows.map((r) => r.title)).toEqual(["Alpha"]);
    expect((await src.read("b")).title).toBe("Beta");
    await rejectsWith(src.read("zz"), "not_found");
  });

  it("serves from the cache inside the TTL and shares one call between concurrent misses", async () => {
    const { fetch, calls } = scripted(BODY);
    const { src, c } = make(fetch);
    await Promise.all([src.list({}), src.list({}), src.list({ page: { limit: 1, offset: 1 } })]);
    expect(calls).toHaveLength(1);
    c.advance(59_999);
    await src.list({ sort: [{ field: "title" }] });
    expect(calls).toHaveLength(1);
    c.advance(1);
    const fresh = await src.list({});
    expect(calls).toHaveLength(2);
    expect(fresh.fetched_at).toBe(new Date(1_060_000).toISOString());
  });

  it("serves the old copy marked stale when upstream fails after a good fetch", async () => {
    const { fetch, calls } = scripted(BODY, { status: 503 }, BODY);
    const { src, c } = make(fetch);
    await src.list({});
    c.advance(60_000);
    const stale = await src.list({});
    expect(calls).toHaveLength(2);
    expect(stale.stale).toBe(true);
    expect(stale.fetched_at).toBe(new Date(1_000_000).toISOString());
    expect(stale.rows.every((r) => r.__meta.stale === true)).toBe(true);
    expect(stale.total).toBe(3);
    // The failure counts as a check: the next attempt waits another TTL.
    c.advance(30_000);
    await src.list({});
    expect(calls).toHaveLength(2);
    c.advance(30_000);
    const back = await src.list({});
    expect(calls).toHaveLength(3);
    expect(back.stale).toBe(false);
    expect(back.rows[0]?.__meta.stale).toBeUndefined();
  });

  it("answers internal with the upstream status when the first fetch fails", async () => {
    const { src } = make(scripted({ status: 403 }).fetch);
    const err = await rejectsWith(src.list({}), "internal");
    expect(err.details).toMatchObject({
      status: 403,
      url: "https://api.example.test/v1/things?limit=5",
    });
    const down = make(scripted(new TypeError("fetch failed")).fetch).src;
    const err2 = await rejectsWith(down.list({}), "internal");
    expect(err2.message).toMatch(/unreachable: fetch failed/);
    expect(err2.details).toMatchObject({ status: null });
  });

  it("sends a ${VAR} header when the variable is set", async () => {
    const { fetch, calls } = scripted(BODY);
    await make(fetch, { env: { TOKEN: "abc" } }).src.list({});
    expect(calls[0]?.headers).toEqual({ Authorization: "Bearer abc", Accept: "x" });
  });

  it("refuses to call upstream without env_required, naming the variables", async () => {
    const { fetch, calls } = scripted(BODY);
    const src = new HttpApiSource({
      name: "things",
      schema,
      options: options({ env_required: ["API_KEY", "API_SECRET"] }),
      fetch,
      env: { API_KEY: "k" },
    });
    const err = await rejectsWith(src.list({}), "unsupported_op");
    expect(err.message).toMatch(/needs API_SECRET set/);
    expect(calls).toHaveLength(0);
  });

  it("reads <UDC_HTTP_FIXTURES>/<collection>.json instead of fetching", async () => {
    const { fetch, calls } = scripted(new Error("must not fetch"));
    const quakes = readCollectionAssets(COLLECTIONS_DIR).find((a) => a.name === "quakes");
    if (quakes?.source.kind !== "http_api") throw new Error("quakes is not http_api");
    const src = new HttpApiSource({
      name: "quakes",
      schema: quakes.schema,
      options: quakes.source.options,
      fetch,
      fixturesDir: FIXTURES,
    });
    const res = await src.list({ sort: [{ field: "mag", dir: "desc" }], page: { limit: 500 } });
    expect(calls).toHaveLength(0);
    expect(res.total).toBe(100);
    const top = res.rows[0];
    expect(top?.mag).toBeGreaterThanOrEqual(7);
    // GeoJSON is [lng, lat, depth]; the epoch-ms time arrives as an ISO instant.
    const raw = JSON.parse(readFileSync(join(FIXTURES, "quakes.json"), "utf8")).features.find(
      (f: { id: string }) => f.id === top?.__meta.id,
    );
    expect(top).toMatchObject({
      lng: raw.geometry.coordinates[0],
      lat: raw.geometry.coordinates[1],
      depth: raw.geometry.coordinates[2],
      time: new Date(raw.properties.time).toISOString(),
      place: raw.properties.place,
    });
    const missing = new HttpApiSource({
      name: "nothing",
      schema,
      options: options(),
      fixturesDir: FIXTURES,
    });
    const err = await rejectsWith(missing.list({}), "internal");
    expect(err.message).toMatch(/nothing\.json cannot be read/);
  });
});
