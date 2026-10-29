import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CollectionRegistry, loadRegistry, readCollectionAssets } from "../src/registry.js";
import { MemorySource } from "../src/sources/memory.js";
import { COLLECTIONS_DIR } from "./helpers.js";

const fixtures = (name: string) => join(import.meta.dirname, "fixtures", name);

describe("collection registry", () => {
  it("scans every directory, parses view.yaml and schema.json, skips plain files", () => {
    const assets = readCollectionAssets(fixtures("ok"));
    expect(assets.map((a) => a.name)).toEqual(["books", "notes"]);
    const [books, notes] = assets;
    expect(books?.view.default_renderer).toBe("cards");
    expect(books?.schema.field_order).toEqual(["title", "pages"]);
    expect(books?.seedFile).toMatch(/books\/seed\.json$/);
    // Zod defaults applied.
    expect(notes?.view).toMatchObject({
      page_size_default: 10,
      pagination: "infinite",
      columns: [],
    });
    expect(notes?.seedFile).toBeNull();
  });

  it("registers name → {source, view} through the source factory", async () => {
    const registry = loadRegistry(fixtures("ok"), (a) => new MemorySource({ schema: a.schema }));
    expect(registry.list().map((c) => c.name)).toEqual(["books", "notes"]);
    const books = registry.get("books");
    expect(books.view.available_renderers).toEqual(["table", "cards"]);
    expect((await books.source.describe()).fields.title?.type).toBe("string");
  });

  it("reads the fixture collections, one per source kind", () => {
    const assets = readCollectionAssets(COLLECTIONS_DIR);
    expect(Object.fromEntries(assets.map((a) => [a.name, a.source.kind]))).toEqual({
      companies: "postgres_jsonb",
      files: "filesystem",
      menu: "yaml_menu",
      notes: "memory",
      quakes: "http_api",
    });
    // A database or memory collection may bring rows; files, the menu and the net bring their own.
    expect(assets.filter((a) => a.seedFile !== null).map((a) => a.name)).toEqual([
      "companies",
      "notes",
    ]);
    expect(Object.keys(assets.find((a) => a.name === "files")?.docs ?? {})).toEqual(["en"]);
  });
  it("loads the companies fixture", () => {
    const companies = readCollectionAssets(COLLECTIONS_DIR).find((a) => a.name === "companies");
    expect(companies?.name).toBe("companies");
    expect(companies?.view).toMatchObject({
      available_renderers: ["table", "cards", "map"],
      pagination: "infinite",
      page_size_default: 50,
      row_height: 48,
      search: { fields: ["name", "pib", "mb", "city"] },
      card_options: { title_field: "name", subtitle_field: "pib", size: "medium" },
    });
    const editable = companies?.view.columns.filter((c) => c.editable).map((c) => c.field);
    expect(editable).toEqual([
      "name",
      "city",
      "industry",
      "employees",
      "revenue_eur",
      "founded",
      "active",
    ]);
    expect(companies?.view.filters?.map((f) => `${f.field}:${f.kind}`)).toEqual([
      "city:select",
      "industry:select",
      "active:bool",
      "employees:range",
    ]);
    expect(companies?.view.filterable?.fields).toHaveLength(10);
  });

  it.each([
    ["bad-view", /broken\/view\.yaml.*\n.*pagination/s],
    ["bad-yaml", /broken\/view\.yaml/],
    ["bad-schema", /broken\/schema\.json/],
    ["no-schema", /lonely\/schema\.json/],
    ["core-fields", /withcore\/schema\.json.*core_fields must be empty/],
    ["bad-name", /Bad-Name.*collection name/],
    ["bad-calendar", /agenda\/view\.yaml.*calendar_options.*\n.*start_field: day is date/s],
    ["bad-tree", /thread\/view\.yaml.*tree_options.*\n.*label_field: title is not a field/s],
    ["lazy-tree", /chart\/view\.yaml.*invalid.*children_count_field/s],
    ["bad-map", /places\/view\.yaml.*map_options.*\n.*popup_fields\[1\]: website is not a field/s],
    ["map-without-options", /plain\/view\.yaml.*invalid.*lists map, so map_options/s],
    ["bad-chart", /series\/view\.yaml.*chart_options.*\n.*series\[1\]\.field: mem is not a field/s],
    ["bad-pie", /stars\/view\.yaml.*invalid.*a pie needs value_field/s],
  ])("fails startup on %s, naming the file", (dir, message) => {
    expect(() => readCollectionAssets(fixtures(dir))).toThrow(message);
  });

  it("refuses a duplicate name and answers not_found for an unknown one", () => {
    const registry = new CollectionRegistry();
    const [asset] = readCollectionAssets(fixtures("ok"));
    if (!asset) throw new Error("fixture missing");
    const c = { name: "x", source: new MemorySource({ schema: asset.schema }), view: asset.view };
    registry.register(c);
    expect(() => registry.register(c)).toThrow(/twice/);
    expect(() => registry.get("y")).toThrow(/unknown collection/);
  });
});
