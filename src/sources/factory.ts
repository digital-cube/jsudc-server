import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { sourceGroup } from "@jsudc/core";
import type { Db } from "../db/client.js";
import type { CollectionAsset, CollectionRegistry } from "../registry.js";
import { FilesystemSource } from "./filesystem.js";
import { type Env, type FetchLike, HttpApiSource, type SourceLog } from "./http-api.js";
import { MemorySource } from "./memory.js";
import { PostgresJsonbSource } from "./postgres-jsonb.js";
import type { Source } from "./source.js";
import { YamlMenuSource } from "./yaml-menu.js";

/** `UDC_HTTP_SOURCES=off` (or `0`, `false`, `no`): no collection is fetched from the net. */
export function httpSourcesEnabled(env: Env): boolean {
  const v = env.UDC_HTTP_SOURCES?.trim().toLowerCase();
  return !(v === "off" || v === "0" || v === "false" || v === "no");
}

/** The variable that overrides an http_api collection's cache TTLs: `UDC_FLIGHTS_CACHE_TTL_MS` for `flights`. */
export const cacheTtlEnvVar = (collection: string) =>
  `UDC_${collection.toUpperCase()}_CACHE_TTL_MS`;

/** The variable that moves a filesystem collection's root: `UDC_FILES_ROOT` for `files`. */
export const rootEnvVar = (collection: string) => `UDC_${collection.toUpperCase()}_ROOT`;

/** `root` of a filesystem source: the env override, else the option, relative to the collection directory. */
export function filesystemRoot(asset: CollectionAsset, root: string, env: Env): string {
  const override = env[rootEnvVar(asset.name)];
  const chosen = override?.trim() ? override.trim() : root;
  return isAbsolute(chosen) ? chosen : resolve(asset.dir, chosen);
}

export interface SourceDeps {
  /** Needed by postgres_jsonb collections only. */
  db?: Db | undefined;
  /**
   * The variables `UDC_*` overrides and `${VAR}` headers are read from: the
   * host passes `process.env` (or a subset). None without it.
   */
  env?: Env | undefined;
  fetch?: FetchLike | undefined;
  /** What a yaml_menu's `udc:collections` branches list; none without it. */
  registry?: CollectionRegistry | undefined;
  /** An http_api source's line per upstream call and its credential warnings. */
  log?: SourceLog | undefined;
}

/**
 * The source `source.yaml` asks for. `null` for an http_api collection when
 * `UDC_HTTP_SOURCES` is off: the registry then does not serve it. With
 * `UDC_HTTP_FIXTURES=<dir>` every http_api collection reads
 * `<dir>/<collection>.json` (or `.1.json`, `.2.json`, … one per upstream
 * call) instead of calling upstream; `UDC_<NAME>_CACHE_TTL_MS` overrides a
 * collection's cache TTLs.
 */
export function makeSource(asset: CollectionAsset, deps: SourceDeps): Source | null {
  const env = deps.env ?? {};
  const pageSizeDefault = asset.view.page_size_default;
  const { source } = asset;
  switch (source.kind) {
    case "postgres_jsonb": {
      if (!deps.db) throw new Error(`${asset.name}: a postgres_jsonb collection needs a database`);
      return new PostgresJsonbSource({
        db: deps.db,
        table: source.options.table ?? asset.name,
        initialSchema: asset.schema,
        pageSizeDefault,
      });
    }
    case "memory":
      return new MemorySource({
        schema: asset.schema,
        rows: asset.seedFile ? JSON.parse(readFileSync(asset.seedFile, "utf8")) : [],
        pageSizeDefault,
      });
    case "filesystem":
      return new FilesystemSource({
        name: asset.name,
        schema: asset.schema,
        root: filesystemRoot(asset, source.options.root, env),
        followSymlinks: source.options.follow_symlinks,
        maxEntries: source.options.max_entries,
        pageSizeDefault,
      });
    case "http_api": {
      if (!httpSourcesEnabled(env)) return null;
      const fixtures = env.UDC_HTTP_FIXTURES?.trim();
      // A test (or a demo) that cannot wait out a 4-minute cache sets both TTLs at once.
      const ttl = Number(env[cacheTtlEnvVar(asset.name)]?.trim() || Number.NaN);
      const options =
        Number.isInteger(ttl) && ttl >= 0
          ? { ...source.options, cache_ttl_ms: ttl, cache_ttl_ms_authenticated: ttl }
          : source.options;
      return new HttpApiSource({
        name: asset.name,
        schema: asset.schema,
        options,
        log: deps.log,
        fetch: deps.fetch,
        env,
        fixturesDir: fixtures ? resolve(fixtures) : undefined,
        pageSizeDefault,
      });
    }
    case "yaml_menu": {
      const file = resolve(asset.dir, source.options.file);
      const { registry } = deps;
      return new YamlMenuSource({
        file,
        displayPath: relative(dirname(asset.dir), file).split("\\").join("/"),
        dynamic: source.options.dynamic,
        collectionIcons: source.options.collection_icons,
        collections: () =>
          (registry?.list() ?? []).map((c) => ({
            name: c.name,
            group: sourceGroup(c.source.kind ?? "postgres_jsonb"),
          })),
        pageSizeDefault,
      });
    }
  }
}
