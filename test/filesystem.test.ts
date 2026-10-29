import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FilterNode, SchemaDocSchema } from "@jsudc/core";
import { afterAll, describe, expect, it } from "vitest";
import { FilesystemSource, normalizeRelPath, takePathSelector } from "../src/sources/filesystem.js";
import { COLLECTIONS_DIR, rejectsWith } from "./helpers.js";

const schema = SchemaDocSchema.parse(
  JSON.parse(readFileSync(join(COLLECTIONS_DIR, "files", "schema.json"), "utf8")),
);
const root = join(COLLECTIONS_DIR, "files", "tree");
const src = new FilesystemSource({ name: "files", schema, root, pageSizeDefault: 50 });
const inDir = (dir: string, more?: FilterNode): FilterNode => ({
  and: [{ field: "path", op: "eq", value: dir }, ...(more ? [more] : [])],
});
const names = (rows: Record<string, unknown>[]) => rows.map((r) => r.name);

describe("takePathSelector / normalizeRelPath", () => {
  it("finds a path eq anywhere and strips every path condition", () => {
    expect(takePathSelector(undefined)).toEqual({ dir: null, rest: undefined });
    expect(takePathSelector({ field: "path", op: "eq", value: "docs" })).toEqual({
      dir: "docs",
      rest: undefined,
    });
    const nested: FilterNode = {
      and: [
        { field: "name", op: "contains", value: "g" },
        { or: [{ field: "path", op: "eq", value: "docs/deep" }] },
        { not: { field: "path", op: "starts_with", value: "x" } },
      ],
    };
    expect(takePathSelector(nested)).toEqual({
      dir: "docs/deep",
      rest: { field: "name", op: "contains", value: "g" },
    });
  });

  it("normalises and refuses traversal", () => {
    expect(normalizeRelPath("")).toBe("");
    expect(normalizeRelPath("/")).toBe("");
    expect(normalizeRelPath("docs/")).toBe("docs");
    expect(normalizeRelPath("./docs//deep/.")).toBe("docs/deep");
    expect(normalizeRelPath("docs/deep/..")).toBe("docs");
    for (const bad of ["..", "../x", "docs/../..", "/etc", "a\\..\\..", "x\0"]) {
      expect(() => normalizeRelPath(bad), bad).toThrow(/outside the root/);
    }
  });
});

describe("FilesystemSource", () => {
  it("is read-only and pages by offset", () => {
    expect(src.capabilities).toMatchObject({
      mutate: false,
      schema_edit: false,
      reindex: false,
      paging: ["offset"],
    });
  });

  it("lists the root: folders first, then files by name, root-relative paths", async () => {
    const res = await src.list({});
    expect(names(res.rows)).toEqual(["docs", "media", "a.txt", "b.md", "big.json"]);
    expect(res.total).toBe(5);
    const a = res.rows.find((r) => r.name === "a.txt");
    expect(a).toMatchObject({
      __meta: { id: "a.txt", version: 1 },
      path: "a.txt",
      kind: "file",
      ext: "txt",
      size: 5,
    });
    expect(typeof a?.mtime).toBe("string");
    expect(Number.isNaN(Date.parse(String(a?.mtime)))).toBe(false);
    expect(res.rows.find((r) => r.name === "docs")).toMatchObject({
      kind: "dir",
      ext: null,
      size: null,
    });
  });

  it("selects a directory with path eq and puts .. first", async () => {
    const docs = await src.list({ filter: inDir("docs") });
    expect(names(docs.rows)).toEqual(["..", "deep", "guide.md"]);
    expect(docs.rows[0]).toMatchObject({ path: "", kind: "dir" });
    expect(docs.rows[1]).toMatchObject({ path: "docs/deep" });
    const deep = await src.list({ filter: inDir("docs/deep/") });
    expect(deep.rows.map((r) => r.path)).toEqual(["docs", "docs/deep/table.csv"]);
    expect(deep.total).toBe(2);
  });

  it("refuses a traversal and answers not_found for a missing folder", async () => {
    await rejectsWith(src.list({ filter: inDir("../..") }), "validation_error");
    await rejectsWith(src.list({ filter: inDir("docs/../../etc") }), "validation_error");
    await rejectsWith(src.list({ filter: inDir("nope") }), "not_found");
    await rejectsWith(src.list({ filter: inDir("a.txt") }), "not_found");
  });

  it("sorts by size, numerically, folders (no size) last", async () => {
    const asc = await src.list({ sort: [{ field: "size", dir: "asc" }] });
    expect(names(asc.rows)).toEqual(["a.txt", "b.md", "big.json", "docs", "media"]);
    const desc = await src.list({ sort: [{ field: "size", dir: "desc" }] });
    expect(names(desc.rows)).toEqual(["big.json", "b.md", "a.txt", "docs", "media"]);
  });

  it("runs the rest of the filter (a chip on ext, a search) inside the folder; .. stays", async () => {
    const md = await src.list({ filter: { field: "ext", op: "in", value: ["md", "json"] } });
    expect(names(md.rows)).toEqual(["b.md", "big.json"]);
    const docs = await src.list({
      filter: inDir("docs", {
        field: "name",
        op: "contains",
        value: "GUI",
        case_insensitive: true,
      }),
    });
    expect(names(docs.rows)).toEqual(["..", "guide.md"]);
    expect(docs.total).toBe(2);
  });

  it("pages by offset with .. counted once, refuses a cursor", async () => {
    const p1 = await src.list({ filter: inDir("docs"), page: { limit: 2 } });
    const p2 = await src.list({ filter: inDir("docs"), page: { limit: 2, offset: 2 } });
    expect([...names(p1.rows), ...names(p2.rows)]).toEqual(["..", "deep", "guide.md"]);
    expect(p1.total).toBe(3);
    await rejectsWith(src.list({ page: { limit: 2, cursor: "x" } }), "unsupported_op");
  });

  it("reads one entry by its path and refuses writes", async () => {
    expect(await src.read("docs/guide.md")).toMatchObject({ name: "guide.md", size: 22 });
    await rejectsWith(src.read("docs/missing.md"), "not_found");
    await rejectsWith(src.mutate({ op: "delete", id: "a.txt" }), "unsupported_op");
    await rejectsWith(
      src.addField({ name: "x", fielddef: { type: "string" }, position: { where: "end" } }),
      "unsupported_op",
    );
  });

  it("caps a directory at max_entries", async () => {
    const capped = new FilesystemSource({ name: "files", schema, root, maxEntries: 2 });
    expect((await capped.list({})).total).toBe(2);
  });

  describe("symlinks", () => {
    const tmp = mkdtempSync(join(tmpdir(), "jsudc-fs-"));
    const outside = mkdtempSync(join(tmpdir(), "jsudc-out-"));
    writeFileSync(join(tmp, "real.txt"), "real");
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(join(tmp, "real.txt"), join(tmp, "inside-link.txt"));
    symlinkSync(join(outside, "secret.txt"), join(tmp, "outside-link.txt"));
    afterAll(() => {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    });

    it("skips every link by default", async () => {
      const s = new FilesystemSource({ name: "files", schema, root: tmp });
      expect(names((await s.list({})).rows)).toEqual(["real.txt"]);
      await rejectsWith(s.resolveFile("inside-link.txt"), "not_found");
    });

    it("follows a link inside the root, never one that leaves it", async () => {
      const s = new FilesystemSource({ name: "files", schema, root: tmp, followSymlinks: true });
      expect(names((await s.list({})).rows)).toEqual(["inside-link.txt", "real.txt"]);
      expect(await s.resolveFile("inside-link.txt")).toMatch(/real\.txt$/);
      await rejectsWith(s.resolveFile("outside-link.txt"), "validation_error");
    });
  });
});
