import {
  type Capabilities,
  evaluateFilter,
  type FieldType,
  type FilterNode,
  type ListResponse,
  type Row,
  type SchemaDoc,
  type SortKey,
  UdcError,
} from "@jsudc/core";
import { assertQueryFields, notFound } from "./fields.js";
import {
  ALL_FILTER_OPS,
  DEFAULT_PAGE_SIZE,
  type Source,
  type SourceAddField,
  type SourceListRequest,
  type SourceMutation,
  type SourceUpdateField,
} from "./source.js";

const isMissing = (v: unknown) => v === null || v === undefined;

const NUMBER_TYPES = new Set<FieldType>(["integer", "decimal", "year", "rating"]);
const INSTANT_TYPES = new Set<FieldType>(["date", "datetime"]);

function asNumber(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : Number.NaN;
}

function asInstant(v: unknown): number {
  return typeof v === "number" ? v : Date.parse(String(v));
}

function byNumber(x: number, y: number): number {
  // An unparseable value sorts after every parseable one, as a NULL would.
  if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) ? (Number.isNaN(y) ? 0 : 1) : -1;
  return x - y;
}

/**
 * Two non-missing values of a field of `type`: numbers numerically, dates
 * and datetimes by instant (`+02:00` and `Z` spellings of one moment are
 * equal), bools false first, everything else as text with `localeCompare`.
 */
export function compareByType(type: FieldType | undefined, a: unknown, b: unknown): number {
  if (type && NUMBER_TYPES.has(type)) return byNumber(asNumber(a), asNumber(b));
  if (type && INSTANT_TYPES.has(type)) return byNumber(asInstant(a), asInstant(b));
  if (type === "bool" || (typeof a === "boolean" && typeof b === "boolean")) {
    return Number(a === true) - Number(b === true);
  }
  if (typeof a === "number" && typeof b === "number") return a - b;
  const text = (v: unknown) => (typeof v === "object" ? JSON.stringify(v) : String(v));
  return text(a).localeCompare(text(b));
}

/** `rows` in `sort` order: NULLS LAST both ways, then `__meta.id` ascending, as the SQL source. */
export function sortRows(rows: readonly Row[], sort: readonly SortKey[], schema: SchemaDoc): Row[] {
  const keys = sort.map((k) => ({ ...k, type: schema.fields[k.field]?.type }));
  const byId = (a: Row, b: Row) =>
    a.__meta.id < b.__meta.id ? -1 : a.__meta.id > b.__meta.id ? 1 : 0;
  return [...rows].sort((a, b) => {
    for (const { field, dir, type } of keys) {
      const x = a[field];
      const y = b[field];
      if (isMissing(x) || isMissing(y)) {
        if (isMissing(x) && isMissing(y)) continue;
        return isMissing(x) ? 1 : -1;
      }
      const c = compareByType(type, x, y);
      if (c !== 0) return dir === "desc" ? -c : c;
    }
    return byId(a, b);
  });
}

export interface ArrayQuery {
  filter?: FilterNode | undefined;
  sort?: SortKey[] | undefined;
  offset?: number | undefined;
  limit: number;
  /** Rows placed first, outside filter and sort (the filesystem's `..`); counted and paged. */
  head?: readonly Row[] | undefined;
  /** Without sort keys, keep the array's own order instead of ordering by id. */
  keepOrder?: boolean | undefined;
}

/**
 * Filter (`evaluateFilter`), sort (`sortRows`) and one offset page of
 * `rows`, with the total of what matched (the head included).
 */
export function queryRows(
  rows: readonly Row[],
  schema: SchemaDoc,
  q: ArrayQuery,
): { rows: Row[]; total: number } {
  const matched = rows.filter((r) => evaluateFilter(q.filter, r));
  const sorted = q.keepOrder && !q.sort?.length ? matched : sortRows(matched, q.sort ?? [], schema);
  const ordered = [...(q.head ?? []), ...sorted];
  const offset = Math.max(0, q.offset ?? 0);
  return { rows: ordered.slice(offset, offset + q.limit), total: ordered.length };
}

/** What a subclass hands the array core for one `list`. */
export interface ArrayLoad {
  rows: Row[];
  /** The filter to apply in memory; defaults to the request's. */
  filter?: FilterNode | undefined;
  /** Rows placed first, outside filter and sort (the filesystem's `..`). */
  head?: Row[];
  /** Extra fields of the answer (`fetched_at`, `stale`). */
  extra?: Partial<ListResponse>;
}

export const READ_ONLY_ARRAY_CAPABILITIES: Capabilities = {
  mutate: false,
  subscribe: false,
  total_count: true,
  schema_edit: false,
  config_edit: false,
  reindex: false,
  tree_reparent: false,
  source_yaml: false,
  paging: ["offset"],
  supported_filter_ops: ALL_FILTER_OPS,
};

/**
 * A source whose rows are an array in memory: subclasses say where the
 * array comes from (`load`), this class filters it with udc-core's
 * `evaluateFilter`, sorts it by schema type and pages it by offset. A cursor
 * is refused (`paging: ["offset"]`), so the UI walks it by offset. Read-only
 * by default: `mutate` and the schema edits answer `unsupported_op`.
 */
export abstract class ArraySource implements Source {
  abstract readonly capabilities: Capabilities;
  protected readonly schema: SchemaDoc;
  protected readonly pageSizeDefault: number;
  /** For error messages: "the memory source", "collection files". */
  protected abstract readonly label: string;

  constructor(opts: { schema: SchemaDoc; pageSizeDefault?: number | undefined }) {
    this.schema = opts.schema;
    this.pageSizeDefault = opts.pageSizeDefault ?? DEFAULT_PAGE_SIZE;
  }

  protected abstract load(req: SourceListRequest): Promise<ArrayLoad>;

  /** The order of a `list` that asks for none (ties are always broken by id). */
  protected readonly defaultSort: SortKey[] = [];
  /** Without a sort (and no `defaultSort`), serve the rows in the order `load` gave them. */
  protected readonly keepOrder: boolean = false;

  async describe(): Promise<SchemaDoc> {
    return this.schema;
  }

  async list(req: SourceListRequest): Promise<ListResponse> {
    assertQueryFields(this.schema, req.filter, req.sort);
    if (req.page?.cursor != null) {
      throw new UdcError("unsupported_op", `${this.label} pages by offset only (paging: offset)`);
    }
    const loaded = await this.load(req);
    const offset = req.page?.offset ?? 0;
    const limit = req.page?.limit ?? this.pageSizeDefault;
    const page = queryRows(loaded.rows, this.schema, {
      filter: "filter" in loaded ? loaded.filter : req.filter,
      sort: req.sort?.length ? req.sort : this.defaultSort,
      offset,
      limit,
      head: loaded.head,
      keepOrder: this.keepOrder,
    });
    return { ...loaded.extra, rows: page.rows, next_cursor: null, total: page.total };
  }

  async read(id: string): Promise<Row> {
    const { rows } = await this.load({});
    const row = rows.find((r) => r.__meta.id === id);
    if (!row) throw notFound(id);
    return row;
  }

  async mutate(_m: SourceMutation): Promise<Row> {
    throw this.readOnly("mutate: false");
  }

  addField(_req: SourceAddField): Promise<SchemaDoc> {
    return Promise.reject(this.readOnly("schema_edit: false"));
  }

  updateField(_req: SourceUpdateField): Promise<SchemaDoc> {
    return Promise.reject(this.readOnly("schema_edit: false"));
  }

  softDeleteField(_field: string): Promise<SchemaDoc> {
    return Promise.reject(this.readOnly("schema_edit: false"));
  }

  protected readOnly(what: string): UdcError {
    return new UdcError("unsupported_op", `${this.label} is read-only (${what})`);
  }
}
