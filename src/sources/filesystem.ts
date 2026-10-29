import type { Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, posix, relative, sep } from "node:path";
import {
  type Capabilities,
  type FilterNode,
  isCondition,
  type Row,
  type SchemaDoc,
  type SortKey,
  UdcError,
} from "@jsudc/core";
import { type ArrayLoad, ArraySource, READ_ONLY_ARRAY_CAPABILITIES } from "./array.js";
import { notFound } from "./fields.js";
import type { SourceListRequest } from "./source.js";

/** The field whose `eq` condition picks the directory: navigation, not a filter. */
export const PATH_FIELD = "path";
/** The `name` of the row that leads to the parent directory. */
export const PARENT_NAME = "..";

/**
 * The directory a filter selects: the value of the first `path eq <dir>`
 * condition anywhere in the tree (as udc-py), and the tree without every
 * `path` condition, which then runs in memory over that directory's entries.
 */
export function takePathSelector(node: FilterNode | undefined): {
  dir: string | null;
  rest: FilterNode | undefined;
} {
  let dir: string | null = null;
  const strip = (n: FilterNode): FilterNode | undefined => {
    if (isCondition(n)) {
      if (n.field !== PATH_FIELD) return n;
      if (n.op === "eq" && dir === null && typeof n.value === "string") dir = n.value;
      return undefined;
    }
    if ("and" in n || "or" in n) {
      const key = "and" in n ? "and" : "or";
      const kids = ("and" in n ? n.and : n.or)
        .map(strip)
        .filter((k): k is FilterNode => k !== undefined);
      if (kids.length === 0) return undefined;
      return kids.length === 1 ? kids[0] : ({ [key]: kids } as FilterNode);
    }
    const inner = strip(n.not);
    return inner === undefined ? undefined : { not: inner };
  };
  const rest = node ? strip(node) : undefined;
  return { dir, rest };
}

/**
 * A root-relative directory in its one normal form: forward slashes, no
 * leading, trailing or doubled slash, no `.`; `""` is the root. Anything that
 * would leave the root (`..`, an absolute path, a NUL) is a `validation_error`.
 */
export function normalizeRelPath(raw: string): string {
  if (raw.includes("\0")) throw traversal(raw);
  const slashed = raw.replace(/\\/g, "/");
  if (slashed.startsWith("/") && slashed.replace(/\/+/g, "") !== "") throw traversal(raw);
  const norm = posix.normalize(slashed.replace(/^\/+/, "") || ".").replace(/\/+$/, "");
  if (norm === ".." || norm.startsWith("../")) throw traversal(raw);
  return norm === "." ? "" : norm;
}

function traversal(path: string): UdcError {
  return new UdcError("validation_error", `path outside the root: ${JSON.stringify(path)}`, {
    field: PATH_FIELD,
    path,
  });
}

/** `readme.MD` → `md`; `null` for a directory or a name without an extension. */
function extOf(name: string, isDir: boolean): string | null {
  if (isDir) return null;
  const ext = extname(name);
  return ext.length > 1 ? ext.slice(1).toLowerCase() : null;
}

/**
 * The entries of one directory under `root`, read-only. Rows are
 * `{path, name, kind, ext, size, mtime}` with `path` root-relative and the
 * row id; a directory has no size. Below the root a `..` row comes first,
 * whatever the sort and filter. Without `followSymlinks` a symlink is not
 * listed; with it, one whose target lies outside the root is not either.
 */
export class FilesystemSource extends ArraySource {
  readonly capabilities: Capabilities = { ...READ_ONLY_ARRAY_CAPABILITIES };
  readonly kind = "filesystem";
  protected readonly label: string;
  // Folders before files, then by name: the order a file manager opens with.
  protected override readonly defaultSort: SortKey[] = [
    { field: "kind", dir: "asc" },
    { field: "name", dir: "asc" },
  ];

  readonly root: string;
  private readonly followSymlinks: boolean;
  private readonly maxEntries: number;
  private realRoot: Promise<string> | null = null;

  constructor(opts: {
    name: string;
    schema: SchemaDoc;
    /** Absolute. */
    root: string;
    followSymlinks?: boolean | undefined;
    maxEntries?: number | undefined;
    pageSizeDefault?: number | undefined;
  }) {
    super(opts);
    if (!isAbsolute(opts.root)) throw new Error(`filesystem root must be absolute: ${opts.root}`);
    this.label = `collection ${opts.name} (filesystem)`;
    this.root = opts.root;
    this.followSymlinks = opts.followSymlinks ?? false;
    this.maxEntries = opts.maxEntries ?? 5000;
  }

  protected async load(req: SourceListRequest): Promise<ArrayLoad> {
    const { dir, rest } = takePathSelector(req.filter);
    const rel = normalizeRelPath(dir ?? "");
    const rows = await this.entries(rel);
    const head: Row[] = [];
    if (rel !== "") {
      const parent = posix.dirname(rel);
      head.push(this.parentRow(parent === "." ? "" : parent));
    }
    return { rows, filter: rest, head };
  }

  override async read(id: string): Promise<Row> {
    const rel = normalizeRelPath(id);
    if (rel === "") throw notFound(id);
    const parent = posix.dirname(rel);
    const rows = await this.entries(parent === "." ? "" : parent);
    const row = rows.find((r) => r.__meta.id === rel);
    if (!row) throw notFound(id);
    return row;
  }

  /**
   * The absolute path of a root-relative file, refusing a traversal and,
   * after symlinks are resolved, anything outside the root.
   */
  async resolveFile(rawPath: string): Promise<string> {
    const rel = normalizeRelPath(rawPath);
    const abs = join(this.root, ...rel.split("/").filter(Boolean));
    const real = await realpath(abs).catch(() => {
      throw notFound(rawPath);
    });
    const rootReal = await this.rootReal();
    if (!this.inside(rootReal, real)) throw traversal(rawPath);
    // Without follow_symlinks a link is not listed, so it cannot be opened either.
    const direct = join(rootReal, ...rel.split("/").filter(Boolean));
    if (!this.followSymlinks && real !== direct) throw notFound(rawPath);
    return real;
  }

  private rootReal(): Promise<string> {
    this.realRoot ??= realpath(this.root).catch(() => this.root);
    return this.realRoot;
  }

  private inside(rootReal: string, real: string): boolean {
    const r = relative(rootReal, real);
    return r === "" || (!r.startsWith(`..${sep}`) && r !== ".." && !isAbsolute(r));
  }

  private async entries(rel: string): Promise<Row[]> {
    const abs = join(this.root, ...rel.split("/").filter(Boolean));
    let dirents: Dirent[];
    try {
      dirents = await readdir(abs, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        throw new UdcError("not_found", `no such directory: ${JSON.stringify(rel)}`, {
          path: rel,
        });
      }
      throw err;
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const rootReal = await this.rootReal();
    const rows: Row[] = [];
    for (const d of dirents) {
      if (rows.length >= this.maxEntries) break;
      if (d.isSymbolicLink()) {
        if (!this.followSymlinks) continue;
        const real = await realpath(join(abs, d.name)).catch(() => null);
        if (!real || !this.inside(rootReal, real)) continue;
      }
      const st = await stat(join(abs, d.name)).catch(() => null);
      if (!st || (!st.isFile() && !st.isDirectory())) continue;
      const isDir = st.isDirectory();
      const path = rel === "" ? d.name : `${rel}/${d.name}`;
      rows.push({
        __meta: { id: path, version: 1 },
        path,
        name: d.name,
        kind: isDir ? "dir" : "file",
        ext: extOf(d.name, isDir),
        size: isDir ? null : st.size,
        mtime: st.mtime.toISOString(),
      });
    }
    return rows;
  }

  private parentRow(parent: string): Row {
    return {
      __meta: { id: PARENT_NAME, version: 1, parent: true },
      path: parent,
      name: PARENT_NAME,
      kind: "dir",
      ext: null,
      size: null,
      mtime: null,
    };
  }
}
