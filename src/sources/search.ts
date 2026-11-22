import {
  type Capabilities,
  type FilterNode,
  type ListResponse,
  type Row,
  type SortKey,
  UdcError,
} from "@jsudc/core";
import {
  DEFAULT_PAGE_SIZE,
  type Source,
  type SourceContext,
  type SourceListRequest,
} from "./source.js";

/**
 * The search text a source acts on: trimmed, and `undefined` when there is
 * none (absent, empty or only whitespace), which is a list without search.
 */
export function searchText(search: string | undefined): string | undefined {
  const text = search?.trim();
  return text ? text : undefined;
}

/**
 * `unsupported_op` for a `search` sent to a collection whose source does not
 * answer it (`capabilities.search` is not `"source"`): the text is refused,
 * never silently ignored (which would list every row).
 */
export function assertSearchable(
  capabilities: Capabilities,
  collection: string,
  search: string | undefined,
): void {
  if (searchText(search) === undefined || capabilities.search === "source") return;
  throw new UdcError(
    "unsupported_op",
    `collection ${collection} does not answer search itself (search is not "source"): filter with contains instead`,
    { collection, field: "search" },
  );
}

const OFFSET_KEY = "o";

/**
 * The cursor of a page in relevance order: the offset of the next page,
 * opaque to the client (base64url JSON `{"o":n}`). A source pages a search by
 * offset; it hands this out as `next_cursor` so a client that walks by cursor
 * (the infinite list) walks a search as well.
 */
export function encodeSearchCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ [OFFSET_KEY]: offset })).toString("base64url");
}

/** The offset in a cursor made by `encodeSearchCursor`; anything else is a `validation_error`. */
export function decodeSearchCursor(cursor: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    parsed = undefined;
  }
  const offset = (parsed as Record<string, unknown> | null | undefined)?.[OFFSET_KEY];
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) {
    throw new UdcError("validation_error", "malformed cursor", { field: "page.cursor" });
  }
  return offset;
}

/** Where a page of a search starts and how long it is: `offset`, or the cursor of the previous page. */
export function searchPage(
  req: SourceListRequest,
  pageSizeDefault = DEFAULT_PAGE_SIZE,
): { limit: number; offset: number } {
  const limit = req.page?.limit ?? pageSizeDefault;
  const cursor = req.page?.cursor;
  const offset = cursor != null ? decodeSearchCursor(cursor) : (req.page?.offset ?? 0);
  return { limit, offset };
}

function and(a: FilterNode, b: FilterNode | undefined): FilterNode {
  return b ? { and: [a, b] } : a;
}

/** What a host's `search` function is asked: the text, the page, and who is asking. */
export interface SearchIndexQuery {
  /** The search box's text, trimmed (never empty). */
  text: string;
  /** The page to answer: `limit` ids from `offset` in relevance order. */
  page: { limit: number; offset: number };
  /**
   * The client's sort, when it chose one: the host orders its hits by it
   * (or ignores it and keeps relevance); jsudc keeps the order of `ids`.
   */
  sort?: SortKey[] | undefined;
  /**
   * The filter the rows must also match: the client's (chips, tree), with
   * the row scope ANDed in for a source that does not enforce it itself.
   * Informative: jsudc applies it when it loads the rows; a host whose
   * index can filter too narrows its hits with it.
   */
  filter?: FilterNode | undefined;
  /** What the host's `context` hook answered for this request. */
  ctx: unknown;
  collection: string;
  /** The host's row scope for this request; jsudc applies it whatever the host does with it. */
  rowScope?: FilterNode | undefined;
}

/** What a host's `search` function answers. */
export interface SearchIndexResult {
  /** The matching row ids of the page, most relevant first. */
  ids: readonly string[];
  /** How many rows match in all, when the index knows; `null` or absent: unknown. */
  total?: number | null | undefined;
}

export interface SearchIndexOptions {
  /**
   * Answer the search outside the database (OpenSearch, Elasticsearch, a
   * vector index): the ids of one page of hits, in relevance order. jsudc
   * then loads exactly those rows from the source, under the row scope and
   * the client's filter, in that order.
   */
  search(query: SearchIndexQuery): Promise<SearchIndexResult> | SearchIndexResult;
}

/**
 * `source`, with the search box answered by an external index: it reports
 * `capabilities.search: "source"`, and a `list` with a `search` asks
 * `opts.search` for one page of ids in relevance order, then loads those
 * rows from `source` with `id in ids` ANDed into the filter (so under the
 * row scope and the client's filter) and returns them in the index's order.
 * An id the scope or the filter hides is dropped, not replaced: a page may
 * come back shorter than its limit. `total` is the index's (an upper bound
 * once rows are dropped), `null` when it gives none. A page is asked for by
 * `offset`, or by the `next_cursor` of the previous page. A `list` without
 * `search`, and every other method, is `source`'s own.
 *
 * Loading by `id in ids` needs a filter on `id` to mean the row id: true for
 * every built-in source unless its schema has a field named `id` that is not.
 */
export function withSearchIndex(source: Source, opts: SearchIndexOptions): Source {
  const capabilities: Capabilities = { ...source.capabilities, search: "source" };
  const bound = <K extends keyof Source>(key: K): Partial<Pick<Source, K>> => {
    const fn = source[key];
    return typeof fn === "function" ? ({ [key]: fn.bind(source) } as Partial<Pick<Source, K>>) : {};
  };
  return {
    capabilities,
    ...(source.kind === undefined ? {} : { kind: source.kind }),
    ...(source.enforcesRowScope === undefined ? {} : { enforcesRowScope: source.enforcesRowScope }),
    ...(source.notFilterable === undefined ? {} : { notFilterable: source.notFilterable }),
    describe: source.describe.bind(source),
    read: source.read.bind(source),
    mutate: source.mutate.bind(source),
    addField: source.addField.bind(source),
    updateField: source.updateField.bind(source),
    softDeleteField: source.softDeleteField.bind(source),
    ...bound("reindex"),
    ...bound("reparent"),
    ...bound("mutateMany"),
    ...bound("readSource"),
    ...bound("info"),
    async list(req: SourceListRequest, sctx?: SourceContext): Promise<ListResponse> {
      const text = searchText(req.search);
      if (text === undefined) {
        const { search: _search, ...rest } = req;
        return source.list(rest, sctx);
      }
      const page = searchPage(req);
      const hit = await opts.search({
        text,
        page,
        ...(req.sort?.length ? { sort: req.sort } : {}),
        ...(req.filter === undefined ? {} : { filter: req.filter }),
        ctx: sctx?.ctx,
        collection: sctx?.collection ?? "",
        ...(sctx?.rowScope === undefined ? {} : { rowScope: sctx.rowScope }),
      });
      // At most one page, whatever the host sent.
      const given = hit.ids.slice(0, page.limit).map(String);
      const ids = [...new Set(given)];
      const total = typeof hit.total === "number" ? hit.total : null;
      const more = total !== null ? page.offset + given.length < total : given.length >= page.limit;
      const next_cursor = more ? encodeSearchCursor(page.offset + given.length) : null;
      if (ids.length === 0) return { rows: [], next_cursor, total };
      const loaded = await source.list(
        {
          filter: and({ field: "id", op: "in", value: ids }, req.filter),
          page: { limit: ids.length, offset: 0 },
        },
        sctx,
      );
      const byId = new Map<string, Row>(loaded.rows.map((r) => [String(r.__meta.id), r]));
      const rows = ids.flatMap((id) => {
        const row = byId.get(id);
        return row ? [row] : [];
      });
      return { rows, next_cursor, total };
    },
  };
}
