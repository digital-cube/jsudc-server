import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import {
  type Capabilities,
  MENU_SCHEMA,
  MenuFileSchema,
  type MenuNode,
  parseMenuRef,
  type Row,
  type SourceGroup,
  type SourceReadResponse,
  UdcError,
} from "@jsudc/core";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { type ArrayLoad, ArraySource, READ_ONLY_ARRAY_CAPABILITIES } from "./array.js";

/** One collection of the live registry, as a `udc:collections` branch lists it. */
export interface MenuCollection {
  name: string;
  group: SourceGroup;
}

export const DEFAULT_COLLECTION_ICON = "lucide:table";

/** A node's id: the sha1 of its path of codes from the root (`COLLECTIONS/DATABASE`), as udc-py. */
export const menuNodeId = (path: string) => createHash("sha1").update(path).digest("hex");

/**
 * The menu YAML as nodes, or why not: a parse error, a node the schema
 * refuses, a `children:` reference that is garbage or `api:`. The message
 * starts with `file`.
 */
export function parseMenuFile(file: string, text: string): MenuNode[] {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new Error(`${file}: cannot parse (${(err as Error).message})`);
  }
  const res = MenuFileSchema.safeParse(raw);
  if (!res.success) throw new Error(`${file}: invalid\n${z.prettifyError(res.error)}`);
  const check = (nodes: MenuNode[], at: string) => {
    for (const n of nodes) {
      const path = at ? `${at}/${n.code}` : n.code;
      if (typeof n.children === "string") {
        try {
          parseMenuRef(n.children);
        } catch (err) {
          throw new Error(`${file}: ${path}: ${(err as Error).message}`);
        }
      } else if (n.children) check(n.children, path);
    }
  };
  check(res.data, "");
  return res.data;
}

interface Flatten {
  dynamic: boolean;
  collectionIcons: Record<string, string>;
  collections: readonly MenuCollection[];
}

/** The leaves a `udc:` reference stands for, now. */
function resolveRef(text: string, opts: Flatten): MenuNode[] {
  if (!opts.dynamic) return [];
  const ref = parseMenuRef(text);
  return opts.collections
    .filter((c) => ref.group === undefined || c.group === ref.group)
    .map((c) => ({
      code: `COLLECTION_${c.name.toUpperCase()}`,
      translation_key: `COLLECTIONS_${c.name.toUpperCase()}`,
      icon: opts.collectionIcons[c.name] ?? DEFAULT_COLLECTION_ICON,
      url: `/udc/${c.name}`,
    }));
}

/**
 * The nodes as rows, depth first in file order: `order` is the index among
 * siblings, `depth` from 0 at the root, `ancestor_ids` root first,
 * `children_count` what the node has after its reference is resolved.
 * Every row under a resolved reference is `is_dynamic`.
 */
export function flattenMenu(nodes: readonly MenuNode[], opts: Flatten): Row[] {
  const out: Row[] = [];
  const walk = (
    level: readonly MenuNode[],
    path: string,
    ancestors: string[],
    isDynamic: boolean,
  ) => {
    level.forEach((node, order) => {
      const at = path ? `${path}/${node.code}` : node.code;
      const id = menuNodeId(at);
      const fromRef = typeof node.children === "string";
      const children = fromRef
        ? resolveRef(node.children as string, opts)
        : ((node.children as MenuNode[] | undefined) ?? []);
      out.push({
        __meta: { id, version: 1 },
        code: node.code,
        translation_key: node.translation_key ?? null,
        icon: node.icon ?? null,
        url: node.url ?? null,
        parent_id: ancestors.at(-1) ?? null,
        order,
        depth: ancestors.length,
        ancestor_ids: [...ancestors],
        children_count: children.length,
        is_dynamic: isDynamic,
      });
      walk(children, at, [...ancestors, id], isDynamic || fromRef);
    });
  };
  walk(nodes, "", [], false);
  return out;
}

export interface YamlMenuSourceOptions {
  /** The menu YAML, absolute. */
  file: string;
  /** What `source.read` calls it (relative to the collections directory). */
  displayPath: string;
  dynamic: boolean;
  collectionIcons: Record<string, string>;
  /** The live registry, asked on every list (a collection registered later is listed too). */
  collections: () => readonly MenuCollection[];
  pageSizeDefault?: number | undefined;
}

/** What tells one read of the file from the next: its mtime and its size. */
const statKey = (st: { mtimeMs: number; size: number }) => `${st.mtimeMs}:${st.size}`;

interface Parsed {
  /** `mtime:size` of the file the nodes were read from (`statKey`). */
  key: string;
  nodes: MenuNode[];
}

/**
 * A menu written as nested YAML, served as flat tree rows (`MENU_SCHEMA`).
 * The file is read at construction (a missing or invalid one fails startup)
 * and again on a `list` whose `stat` differs from the last read; a file that
 * turns invalid keeps the last good nodes, served with `stale: true`.
 * `children: "udc:collections?group=…"` is resolved on every list against
 * the registry. Read-only; filter, sort and paging are `ArraySource`'s.
 */
export class YamlMenuSource extends ArraySource {
  readonly capabilities: Capabilities = { ...READ_ONLY_ARRAY_CAPABILITIES, source_yaml: true };
  readonly kind = "yaml_menu";
  protected readonly label: string;
  /** Without a sort, the file's own order (depth first), as a person wrote it. */
  protected override readonly keepOrder = true;
  private readonly opts: YamlMenuSourceOptions;
  private good: Parsed;
  /** Why the file as it is now cannot be served; `null` while it can. */
  private failure: string | null = null;
  private failedKey: string | null = null;

  constructor(opts: YamlMenuSourceOptions) {
    super({ schema: MENU_SCHEMA, pageSizeDefault: opts.pageSizeDefault });
    this.opts = opts;
    this.label = `menu ${opts.displayPath}`;
    let text: string;
    let key: string;
    try {
      const st = statSync(opts.file);
      key = statKey(st);
      text = readFileSync(opts.file, "utf8");
    } catch (err) {
      throw new Error(`${opts.file}: cannot read the menu (${(err as Error).message})`);
    }
    this.good = { key, nodes: parseMenuFile(opts.file, text) };
  }

  /** The nodes to serve: re-read when the file changed; the last good ones when it broke. */
  private async current(): Promise<{ nodes: MenuNode[]; stale: boolean }> {
    let key: string;
    try {
      const st = await stat(this.opts.file);
      key = statKey(st);
    } catch (err) {
      this.failure = `cannot read the menu (${(err as Error).message})`;
      this.failedKey = null;
      return { nodes: this.good.nodes, stale: true };
    }
    if (key === this.good.key) {
      this.failure = null;
      return { nodes: this.good.nodes, stale: false };
    }
    if (key !== this.failedKey) {
      try {
        const text = await readFile(this.opts.file, "utf8");
        const nodes = parseMenuFile(this.opts.displayPath, text);
        this.good = { key, nodes };
        this.failure = null;
        this.failedKey = null;
        return { nodes, stale: false };
      } catch (err) {
        this.failure = (err as Error).message;
        this.failedKey = key;
      }
    }
    return { nodes: this.good.nodes, stale: true };
  }

  protected async load(): Promise<ArrayLoad> {
    const { nodes, stale } = await this.current();
    const rows = flattenMenu(nodes, {
      dynamic: this.opts.dynamic,
      collectionIcons: this.opts.collectionIcons,
      collections: this.opts.collections(),
    });
    if (!stale) return { rows };
    return {
      rows: rows.map((r) => ({ ...r, __meta: { ...r.__meta, stale: true } })),
      extra: { stale: true },
    };
  }

  /** The file as written, for the Source tab; `error` when it no longer parses. */
  async readSource(): Promise<SourceReadResponse> {
    let text: string;
    let mtime: Date;
    try {
      [text, { mtime }] = await Promise.all([
        readFile(this.opts.file, "utf8"),
        stat(this.opts.file),
      ]);
    } catch (err) {
      throw new UdcError(
        "internal",
        `${this.opts.displayPath}: cannot read the menu (${(err as Error).message})`,
      );
    }
    await this.current();
    return {
      path: this.opts.displayPath,
      text,
      mtime: mtime.toISOString(),
      ...(this.failure ? { error: this.failure } : {}),
    };
  }
}
