import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTIONS,
  type DescribeResponse,
  filter as f,
  type ListResponse,
  MENU_SCHEMA,
  type Row,
  type SourceReadResponse,
} from "@jsudc/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDispatcher } from "../src/dispatcher.js";
import { CollectionRegistry, loadRegistry, readCollectionAssets } from "../src/registry.js";
import { makeSource } from "../src/sources/factory.js";
import { MemorySource } from "../src/sources/memory.js";
import { type MenuCollection, YamlMenuSource } from "../src/sources/yaml-menu.js";
import { COLLECTIONS_DIR, companiesSchema, companiesSource, useTestDb } from "./helpers.js";

// A Postgres collection beside the menu, for the unsupported_op case (no query is run).
const { db } = useTestDb();
const FIXTURE = join(import.meta.dirname, "fixtures", "menu");
const sha1 = (path: string) => createHash("sha1").update(path).digest("hex");

const COLLECTIONS: MenuCollection[] = [
  { name: "alpha", group: "database" },
  { name: "beta", group: "database" },
  { name: "docs", group: "files" },
  { name: "quakes", group: "internet" },
];

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A copy of the fixture collection in a temp dir, so a test may rewrite its YAML. */
function copyFixture(): { dir: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), "jsudc-menu-"));
  tmpDirs.push(root);
  cpSync(FIXTURE, root, { recursive: true });
  return { dir: join(root, "navi"), file: join(root, "navi", "data", "menu.yaml") };
}

function source(file: string, collections: MenuCollection[] = COLLECTIONS) {
  return new YamlMenuSource({
    file,
    displayPath: "navi/data/menu.yaml",
    dynamic: true,
    collectionIcons: { alpha: "lucide:building-2" },
    collections: () => collections,
  });
}

const all = async (src: YamlMenuSource, req: Parameters<YamlMenuSource["list"]>[0] = {}) =>
  src.list({ page: { limit: 1000 }, ...req });

const byCode = (rows: Row[]) => new Map(rows.map((r) => [r.code as string, r]));

/** Bump the mtime past the cached one, whatever the file system's resolution. */
function touchLater(file: string, seconds: number) {
  const t = new Date(Date.now() + seconds * 1000);
  utimesSync(file, t, t);
}

describe("YamlMenuSource: flatten", () => {
  it("ids are the sha1 of the code path; order, depth, ancestors, children counts", async () => {
    const { file } = copyFixture();
    const { rows } = await all(source(file));
    const rows_ = byCode(rows);
    const home = rows_.get("HOME") as Row;
    const coll = rows_.get("COLLECTIONS") as Row;
    const db = rows_.get("DATABASE") as Row;
    const tickets = rows_.get("TICKETS") as Row;

    expect(home.__meta.id).toBe(sha1("HOME"));
    expect(db.__meta.id).toBe(sha1("COLLECTIONS/DATABASE"));
    expect(tickets.__meta.id).toBe(sha1("VIEWS/TICKETS"));
    expect(home).toMatchObject({
      code: "HOME",
      translation_key: "MENU_HOME",
      icon: "lucide:house",
      url: "/",
      parent_id: null,
      order: 0,
      depth: 0,
      ancestor_ids: [],
      children_count: 0,
      is_dynamic: false,
    });
    expect(coll).toMatchObject({ order: 1, depth: 0, children_count: 2, url: null });
    expect(db).toMatchObject({
      parent_id: coll.__meta.id,
      order: 0,
      depth: 1,
      ancestor_ids: [coll.__meta.id],
      is_dynamic: false,
    });
    expect(tickets).toMatchObject({ order: 0, depth: 1, url: "/udc/tickets?tab=kanban" });
    expect(rows_.get("MAP")).toMatchObject({ order: 1 });
  });

  it("serves the rows in file order (depth first) without a sort", async () => {
    const { file } = copyFixture();
    const { rows } = await all(source(file));
    expect(rows.map((r) => r.code).slice(0, 4)).toEqual([
      "HOME",
      "COLLECTIONS",
      "DATABASE",
      "COLLECTION_ALPHA",
    ]);
  });

  it("reordering two leaves keeps their ids and swaps their order", async () => {
    const { file } = copyFixture();
    const src = source(file);
    const before = byCode((await all(src)).rows);
    const text = readFileSync(file, "utf8");
    const swapped = text.replace(
      /( {4}- code: TICKETS\n(?: {6}.*\n)+)( {4}- code: MAP\n(?: {6}.*\n)+)/,
      "$2$1",
    );
    expect(swapped).not.toBe(text);
    writeFileSync(file, swapped);
    touchLater(file, 5);
    const after = byCode((await all(src)).rows);
    for (const code of ["TICKETS", "MAP"]) {
      expect(after.get(code)?.__meta.id).toBe(before.get(code)?.__meta.id);
    }
    expect(after.get("MAP")?.order).toBe(0);
    expect(after.get("TICKETS")?.order).toBe(1);
  });

  it("resolves udc:collections?group=database against the registry, as dynamic leaves", async () => {
    const { file } = copyFixture();
    const { rows } = await all(source(file));
    const rows_ = byCode(rows);
    const db = rows_.get("DATABASE") as Row;
    expect(db.children_count).toBe(2);
    // A collection is listed once per branch that names its group: find the DATABASE one.
    const under = (code: string) =>
      rows.find((r) => r.code === code && r.parent_id === db.__meta.id) as Row;
    const alpha = under("COLLECTION_ALPHA");
    expect(alpha).toMatchObject({
      translation_key: "COLLECTIONS_ALPHA",
      icon: "lucide:building-2",
      url: "/udc/alpha",
      parent_id: db.__meta.id,
      depth: 2,
      order: 0,
      children_count: 0,
      is_dynamic: true,
    });
    expect(alpha.ancestor_ids).toEqual([sha1("COLLECTIONS"), db.__meta.id]);
    expect(alpha.__meta.id).toBe(sha1("COLLECTIONS/DATABASE/COLLECTION_ALPHA"));
    expect(under("COLLECTION_BETA")).toMatchObject({ icon: "lucide:table", order: 1 });
    // Without a group: every collection of the registry.
    expect(rows_.get("EVERYTHING")?.children_count).toBe(4);
  });

  it("the dynamic branch follows the registry on every list", async () => {
    const { file } = copyFixture();
    const live = [...COLLECTIONS];
    const src = source(file, live);
    const count = async () =>
      byCode((await all(src)).rows).get("DATABASE")?.children_count as number;
    expect(await count()).toBe(2);
    live.push({ name: "gamma", group: "database" });
    expect(await count()).toBe(3);
  });

  it("dynamic: false leaves a reference branch childless", async () => {
    const { file } = copyFixture();
    const src = new YamlMenuSource({
      file,
      displayPath: "m.yaml",
      dynamic: false,
      collectionIcons: {},
      collections: () => COLLECTIONS,
    });
    const rows_ = byCode((await all(src)).rows);
    expect(rows_.get("DATABASE")?.children_count).toBe(0);
    expect(rows_.has("COLLECTION_ALPHA")).toBe(false);
  });
});

describe("YamlMenuSource: the file", () => {
  it("re-reads the file when its mtime or size changed, and only then", async () => {
    const { file } = copyFixture();
    // A whole second, so restoring it below is exact on any file system.
    const mtime = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    utimesSync(file, mtime, mtime);
    const src = source(file);
    const key = async () => byCode((await all(src)).rows).get("MAP")?.translation_key;
    expect(await key()).toBe("MENU_VIEW_MAP");
    // Same size, same mtime: the cached flatten.
    writeFileSync(file, readFileSync(file, "utf8").replace("MENU_VIEW_MAP", "MENU_VIEW_PAM"));
    utimesSync(file, mtime, mtime);
    expect(await key()).toBe("MENU_VIEW_MAP");
    touchLater(file, 5);
    expect(await key()).toBe("MENU_VIEW_PAM");
    // A size change counts as well, whatever the mtime says.
    writeFileSync(file, `${readFileSync(file, "utf8")}- code: ABOUT\n  url: /about\n`);
    utimesSync(file, mtime, mtime);
    expect((await all(src)).total).toBe(14);
  });

  it("fails at construction on a missing or invalid file, naming it", () => {
    const { file } = copyFixture();
    expect(() => source(join(file, "..", "nope.yaml"))).toThrow(/nope\.yaml/);
    writeFileSync(file, "- code: A\n  children: [oops\n");
    expect(() => source(file)).toThrow(new RegExp(`${file.replaceAll(".", "\\.")}.*cannot parse`));
    writeFileSync(file, "- url: /no-code\n");
    expect(() => source(file)).toThrow(/menu\.yaml: invalid/);
    writeFileSync(file, '- code: X\n  children: "api:/api/menu/x"\n');
    expect(() => source(file)).toThrow(/menu\.yaml.*api: references .* not supported/s);
    writeFileSync(file, '- code: X\n  children: "udc:tables"\n');
    expect(() => source(file)).toThrow(/menu\.yaml.*unknown udc: target/s);
  });

  it("a file that turns invalid at runtime serves the last good rows, stale", async () => {
    const { file } = copyFixture();
    const src = source(file);
    const good = await all(src);
    expect(good.stale).toBeUndefined();
    writeFileSync(file, "- code: A\n  children: [oops\n");
    touchLater(file, 5);
    const stale = await all(src);
    expect(stale.stale).toBe(true);
    expect(stale.rows.map((r) => r.__meta.id)).toEqual(good.rows.map((r) => r.__meta.id));
    expect(stale.rows.every((r) => r.__meta.stale === true)).toBe(true);
    const read = await src.readSource();
    expect(read.text).toContain("[oops");
    expect(read.error).toMatch(/cannot parse/);
    // Fixed again: fresh rows, no error.
    writeFileSync(file, "- code: ONLY\n");
    touchLater(file, 10);
    const fixed = await all(src);
    expect(fixed.stale).toBeUndefined();
    expect(fixed.rows.map((r) => r.code)).toEqual(["ONLY"]);
    expect((await src.readSource()).error).toBeUndefined();
  });

  it("a file that is gone at runtime answers internal with the reason", async () => {
    const { file } = copyFixture();
    const src = source(file);
    await all(src);
    rmSync(file);
    await expect(src.readSource()).rejects.toMatchObject({ code: "internal" });
    // The rows of the last good read are still served.
    expect((await all(src)).stale).toBe(true);
  });

  it("source.read returns the bytes, the display path and the mtime", async () => {
    const { file } = copyFixture();
    const read = await source(file).readSource();
    expect(read.text).toBe(readFileSync(file, "utf8"));
    expect(read.path).toBe("navi/data/menu.yaml");
    expect(Number.isNaN(Date.parse(read.mtime))).toBe(false);
    expect(ACTIONS["source.read"].response.safeParse(read).success).toBe(true);
  });

  it("is read-only, with the full array filter set", async () => {
    const { file } = copyFixture();
    const src = source(file);
    expect(src.capabilities).toMatchObject({
      mutate: false,
      schema_edit: false,
      source_yaml: true,
      reindex: false,
      tree_reparent: false,
    });
    expect(src.capabilities.supported_filter_ops).toContain("contains");
    await expect(src.mutate({ op: "insert", row: { code: "X" } })).rejects.toMatchObject({
      code: "unsupported_op",
    });
    const hits = await all(src, { filter: f.contains("translation_key", "view_t") });
    expect(hits.rows.map((r) => r.code)).toEqual(["TICKETS"]);
    const roots = await all(src, { filter: f.isNull("parent_id") });
    expect(roots.rows.map((r) => r.code)).toEqual(["HOME", "COLLECTIONS", "VIEWS"]);
  });
});

describe("yaml_menu through the registry and the dispatcher", () => {
  function serve() {
    const registry = loadRegistry(FIXTURE, (a, reg) => makeSource(a, { registry: reg }));
    // The fixture registry has only the menu; give the dynamic branch something to list.
    const view = registry.get("navi").view;
    registry.register({
      name: "alpha",
      source: new MemorySource({ schema: companiesSchema }),
      view,
    });
    registry.register({ name: "pg", source: companiesSource(db), view });
    const dispatcher = createDispatcher(registry, { log: { error: vi.fn() } });
    const call = async (action: string, payload: unknown) =>
      dispatcher.dispatch({ kind: `udc.${action}`, id: "t", payload });
    return { registry, call };
  }

  it("needs no schema.json: the schema is MENU_SCHEMA", () => {
    const [asset] = readCollectionAssets(FIXTURE);
    expect(asset?.source.kind).toBe("yaml_menu");
    expect(Object.keys(asset?.schema.fields ?? {})).toContain("is_dynamic");
  });

  it("refuses a schema.json that disagrees with MENU_SCHEMA", () => {
    const { dir } = copyFixture();
    writeFileSync(
      join(dir, "schema.json"),
      JSON.stringify({ version: "v1", fields: { code: { type: "string" } } }),
    );
    expect(() => readCollectionAssets(join(dir, ".."))).toThrow(
      /schema\.json: disagrees with MENU_SCHEMA[\s\S]*order: missing/,
    );
  });

  it("describe carries source_yaml; list resolves against the registry; source.read serves the file", async () => {
    const { call } = serve();
    const desc = await call("describe", { collection: "navi" });
    expect(desc.kind).toBe("udc.describe.ok");
    const d = desc.payload as DescribeResponse;
    expect(d.capabilities.source_yaml).toBe(true);
    expect(d.source_kind).toBe("yaml_menu");

    const list = await call("list", { collection: "navi", page: { limit: 100 } });
    const rows = (list.payload as ListResponse).rows;
    const dynamic = rows.filter((r) => r.is_dynamic).map((r) => r.code);
    // DATABASE lists alpha and pg; EVERYTHING lists every collection, the menu too, in registry order.
    expect(dynamic).toEqual([
      "COLLECTION_ALPHA",
      "COLLECTION_PG",
      "COLLECTION_NAVI",
      "COLLECTION_ALPHA",
      "COLLECTION_PG",
    ]);

    const read = await call("source.read", { collection: "navi" });
    expect(read.kind).toBe("udc.source.read.ok");
    expect((read.payload as SourceReadResponse).path).toBe("navi/data/menu.yaml");
    expect((read.payload as SourceReadResponse).text).toContain("udc:collections");
  });

  it.each(["pg", "alpha"])(
    "source.read on %s (no source_yaml) answers unsupported_op",
    async (collection) => {
      const { call } = serve();
      const res = await call("source.read", { collection });
      expect(res.kind).toBe("udc.source.read.err");
      expect(res.payload).toMatchObject({ code: "unsupported_op" });
    },
  );

  it("answers list like a memory source holding the same rows", async () => {
    const { registry, call } = serve();
    const menuRows = (
      (await call("list", { collection: "navi", page: { limit: 100 } })).payload as ListResponse
    ).rows;
    // Its own registry: one beside the menu would be listed by the menu's dynamic branch.
    const twins = new CollectionRegistry();
    twins.register({
      name: "navi",
      source: new MemorySource({ schema: MENU_SCHEMA, rows: menuRows }),
      view: registry.get("navi").view,
    });
    const twin = createDispatcher(twins, { log: { error: vi.fn() } });
    const queries = [
      { filter: f.isNull("parent_id"), sort: [{ field: "order" }] },
      { filter: f.contains("url", "/udc/"), sort: [{ field: "code", dir: "desc" as const }] },
      { filter: f.eq("is_dynamic", true), sort: [{ field: "depth" }, { field: "code" }] },
      { filter: f.gte("depth", 1), sort: [{ field: "order" }], page: { limit: 3, offset: 2 } },
    ];
    for (const q of queries) {
      const strip = (res: { payload: unknown }) => {
        const p = res.payload as ListResponse;
        return { total: p.total, rows: p.rows.map(({ __meta, ...rest }) => [__meta.id, rest]) };
      };
      const menu = strip(await call("list", { collection: "navi", ...q }));
      const mem = strip(
        await twin.dispatch({ kind: "udc.list", id: "t", payload: { collection: "navi", ...q } }),
      );
      expect(menu, JSON.stringify(q)).toEqual(mem);
      expect(menu.total).toBeGreaterThan(0);
    }
  });

  it("the collections listing groups the menu under files", async () => {
    const { call } = serve();
    const res = await call("collections", {});
    const listed = (res.payload as { collections: { name: string; group: string }[] }).collections;
    expect(listed.find((c) => c.name === "navi")).toMatchObject({
      source_kind: "yaml_menu",
      group: "files",
    });
  });

  it("an empty registry still serves the static nodes", async () => {
    const { file } = copyFixture();
    const reg = new CollectionRegistry();
    const src = new YamlMenuSource({
      file,
      displayPath: "x",
      dynamic: true,
      collectionIcons: {},
      collections: () => reg.list().map((c) => ({ name: c.name, group: "database" })),
    });
    expect(byCode((await all(src)).rows).get("DATABASE")?.children_count).toBe(0);
  });
});

describe("the menu fixture collection", () => {
  it("lists every collection once under its group; a Doc leaf points at a README", async () => {
    const registry = loadRegistry(COLLECTIONS_DIR, (a, reg) =>
      a.source.kind === "yaml_menu" || a.source.kind === "memory"
        ? makeSource(a, { registry: reg })
        : new MemorySource({ schema: a.schema }),
    );
    const menu = registry.get("menu").source;
    const { rows } = await menu.list({ page: { limit: 1000 } });
    const roots = rows.filter((r) => r.parent_id === null).map((r) => r.code);
    expect(roots).toEqual(["HOME", "COLLECTIONS", "DOCS"]);
    const dynamic = rows.filter((r) => r.is_dynamic);
    expect(dynamic.map((r) => r.url).sort()).toEqual(
      registry
        .list()
        .map((c) => `/udc/${c.name}`)
        .sort(),
    );
    expect(dynamic.find((r) => r.code === "COLLECTION_MENU")?.icon).toBe("lucide:list-tree");
    for (const doc of rows.filter((r) => String(r.url).endsWith("?tab=doc"))) {
      const name = String(doc.url).replace(/^\/udc\/(\w+)\?tab=doc$/, "$1");
      expect(registry.get(name).docs?.en, name).toBeTruthy();
    }
  });
});
