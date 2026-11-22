import {
  type Capabilities,
  type FieldDef,
  type FilterNode,
  type ListResponse,
  type MutateManyFailure,
  type MutateManyOp,
  type MutateOp,
  type PageRequest,
  type Row,
  type SchemaDoc,
  type SchemaPosition,
  type SortKey,
  type SourceInfo,
  type SourceKind,
  type SourceReadResponse,
  SUPPORTED_OPS,
  type TreeReparentFields,
} from "@jsudc/core";

/** A `list` request as a source sees it: the collection is already resolved. */
export interface SourceListRequest {
  filter?: FilterNode | undefined;
  sort?: SortKey[] | undefined;
  page?: PageRequest | undefined;
  /**
   * The search box's text (`ListRequest.search`), for a source whose
   * `capabilities.search` is `"source"`: the rows must match it as well as
   * the filter (and the row scope). With no `sort` the source may order them
   * by relevance. The generic layer refuses it for any other source, and
   * passes it trimmed, never empty.
   */
  search?: string | undefined;
}

export interface SourceMutation {
  op: MutateOp;
  id?: string | undefined;
  row?: Record<string, unknown> | undefined;
  expected_version?: number | undefined;
}

/**
 * A `mutate_many` request as a source sees it: the collection resolved, the
 * ids deduplicated, the patch with the row scope's pins written over, and
 * `limit`, the most rows it may touch (the dispatcher's `mutateManyLimit`).
 */
export interface SourceMutateMany {
  op: MutateManyOp;
  /** The rows to change; exactly one of `ids` and `filter`. */
  ids?: string[] | undefined;
  /** The client's filter; a source with `enforcesRowScope` ANDs `SourceContext.rowScope` in. */
  filter?: FilterNode | undefined;
  /** With `filter`: matching rows left alone. */
  except_ids?: string[] | undefined;
  /** The patch of an `update`. */
  row?: Record<string, unknown> | undefined;
  /** More matching rows than this is a `validation_error`, before anything is written. */
  limit: number;
}

/** What `mutateMany` answers: rows changed, and the ids of the request that were not there. */
export interface MutateManyResult {
  updated: number;
  failed: MutateManyFailure[];
}

export interface SourceAddField {
  name: string;
  fielddef: FieldDef;
  position: SchemaPosition;
}

/** A `reindex` request as a source sees it; the defaults are already applied by the caller or here. */
export interface SourceReindex {
  scope: Record<string, string | number | boolean>;
  order_field?: string | undefined;
  gap?: number | undefined;
}

export const DEFAULT_ORDER_FIELD = "order";

/** A `tree.reparent` request as a source sees it: the collection is already resolved. */
export interface SourceTreeReparent {
  id: string;
  parent: string | null;
  order: number;
  expected_version?: number | undefined;
  fields: TreeReparentFields;
}

export interface TreeReparentResult {
  row: Row;
  updated: number;
}

export interface SourceUpdateField {
  name: string;
  fielddef: FieldDef;
}

/**
 * Where a collection's rows live. Phase 1 has one real implementation
 * (Postgres jsonb) and an in-memory one for dispatcher tests. The schema
 * methods return the new active document (soft-deleted fields included);
 * a source without `capabilities.schema_edit` refuses them.
 */
export interface Source {
  readonly capabilities: Capabilities;
  /** Where the rows live (the `kind` of `source.yaml`); absent reads as `postgres_jsonb`. */
  readonly kind?: SourceKind;
  /**
   * `true` when the source applies `SourceContext.rowScope` itself, inside
   * the statements that read and write (see `SourceContext`). The dispatcher
   * then leaves the in-scope checks of `read`, `mutate`, `reindex` and
   * `tree.reparent` to it; without it, the dispatcher reads the row first.
   */
  readonly enforcesRowScope?: boolean;
  /**
   * Schema fields the source refuses in a client filter (it answers
   * `validation_error`, as for an unknown field): `describe` leaves them out
   * of `filterable`. Absent: every field is filterable.
   */
  readonly notFilterable?: readonly string[];
  /** The active schema document, `version` in its wire form (`"v<n>"`). */
  describe(sctx?: SourceContext): Promise<SchemaDoc>;
  list(req: SourceListRequest, sctx?: SourceContext): Promise<ListResponse>;
  read(id: string, sctx?: SourceContext): Promise<Row>;
  mutate(op: SourceMutation, sctx?: SourceContext): Promise<Row>;
  addField(req: SourceAddField, sctx?: SourceContext): Promise<SchemaDoc>;
  updateField(req: SourceUpdateField, sctx?: SourceContext): Promise<SchemaDoc>;
  softDeleteField(field: string, sctx?: SourceContext): Promise<SchemaDoc>;
  /**
   * Renumber `order_field` of the rows matching `scope` to `gap`, `2*gap`, …
   * in their current order (NULLs last, ties by id), bumping each version.
   * Answers how many rows it renumbered. Present when `capabilities.reindex`.
   */
  reindex?(req: SourceReindex, sctx?: SourceContext): Promise<number>;
  /**
   * Move a node under `parent` at `order` in one transaction, keeping the
   * structure fields named in `fields` consistent: depth and ancestor ids of
   * the node and its whole subtree, the children count of both parents.
   * Refuses a cycle. Present when `capabilities.tree_reparent`.
   */
  reparent?(req: SourceTreeReparent, sctx?: SourceContext): Promise<TreeReparentResult>;
  /**
   * `mutate_many` natively, all or nothing (one transaction): the patch
   * validated before anything is written, every changed row's version bumped,
   * a filter matching more than `limit` rows refused. Only called on a source
   * that applies the row scope itself (`enforcesRowScope`) or without one;
   * otherwise, and when it is absent, the dispatcher reads the rows in scope
   * and calls `mutate` for each.
   */
  mutateMany?(req: SourceMutateMany, sctx?: SourceContext): Promise<MutateManyResult>;
  /** The file the rows are read from, as written (`source.read`). Present when `capabilities.source_yaml`. */
  readSource?(sctx?: SourceContext): Promise<SourceReadResponse>;
  /** How the source reaches its rows now (an http_api credential, its cache TTL), for `describe`. */
  info?(sctx?: SourceContext): SourceInfo;
}

/**
 * The trailing, optional argument of every `Source` method: who is asking,
 * and the row scope the host imposes for them on this collection. A source
 * that ignores it keeps working: the dispatcher enforces `rowScope` around
 * every source in one generic layer. A source that sets `enforcesRowScope`
 * applies `rowScope` inside its own statements as well (postgres_jsonb), so
 * the check and the write are one statement.
 */
export interface SourceContext {
  /** What the host's `context` hook answered for this request; `undefined` without one. */
  ctx: unknown;
  /** The collection the call is for. */
  collection: string;
  /**
   * The host's row filter for this collection and this `ctx` (the
   * dispatcher's `rowScope` option, resolved). Absent: no scope. Not the
   * `scope` of a `reindex` request, which names the rows to renumber.
   */
  rowScope?: FilterNode | undefined;
}

export const ALL_FILTER_OPS = [...SUPPORTED_OPS];

export const DEFAULT_PAGE_SIZE = 50;
