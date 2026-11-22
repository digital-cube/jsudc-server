import {
  type Capabilities,
  type Condition,
  type DescribeResponse,
  evaluateFilter,
  type FilterNode,
  isCondition,
  isRowIdField,
  type ListResponse,
  ROW_ID,
  type Row,
  type SchemaDoc,
  type SortKey,
  UdcError,
} from "@jsudc/core";
import { buildDescribe } from "./describe.js";
import type { Collection, CollectionRegistry } from "./registry.js";
import { assertValidRow, filterFields, notFound, withoutMeta } from "./sources/fields.js";
import type {
  Source,
  SourceContext,
  SourceListRequest,
  SourceMutation,
  SourceReindex,
  SourceTreeReparent,
  TreeReparentResult,
} from "./sources/source.js";

/** Which action a `CollectionAccess` hook is asked about, on which collection. */
export interface AccessRequest {
  /**
   * The action name (`describe`, `list`, `schema.add_field`, …); `collections`
   * when the `collections` listing asks whether to show the collection, and
   * `read` for a file of `GET /udc/files/blob`.
   */
  action: string;
  collection: string;
}

/**
 * The host-imposed part of the dispatcher: who sees which rows of which
 * collection. Every hook gets the value the plugin's `context` answered for
 * the request (`undefined` when there is none). Methods, so a host may type
 * `ctx` as its own context.
 */
export interface RowScopeOptions<Ctx = unknown> {
  /**
   * The row filter (core's filter DSL) this `ctx` is held to on `collection`,
   * or `undefined` for no limit. Every action ANDs it in; a client can never
   * send, see or lift it. Not the `scope` of a `reindex` request.
   */
  rowScope?(ctx: Ctx, collection: string): FilterNode | undefined;
  /**
   * `false` hides the collection from this `ctx`: it is left out of
   * `collections` (asked with action `collections`) and the action answers
   * `not_found`, as for a collection that does not exist. `true` lets a
   * scoped `ctx` run the actions that act for every tenant (`schema.*`,
   * `source.read`). `undefined` is today's behaviour.
   */
  access?(ctx: Ctx, req: AccessRequest): boolean | undefined;
  /**
   * Collections whose scope fields stay visible: shown in `describe` and the
   * rows, filterable and sortable (a client filter on them is still ANDed
   * with the scope). By default the fields a scope names are hidden.
   */
  showScopeFields?: readonly string[] | undefined;
}

/** The actions that change a collection for every tenant, refused under a scope unless `access` says `true`. */
export const TENANT_WIDE_ACTIONS = [
  "schema.add_field",
  "schema.update_field",
  "schema.soft_delete_field",
  "source.read",
] as const;

const SCHEMA_ACTIONS = TENANT_WIDE_ACTIONS.slice(0, 3);

/** `a AND b`, either side optional. */
export function andFilters(
  a: FilterNode | undefined,
  b: FilterNode | undefined,
): FilterNode | undefined {
  if (!a) return b;
  if (!b) return a;
  return { and: [a, b] };
}

/** A single condition, or the members of a top-level `and`, of the row scope. */
function topLevelConditions(scope: FilterNode): (Condition | null)[] {
  if (isCondition(scope)) return [scope];
  if ("and" in scope) return scope.and.map((n) => (isCondition(n) ? n : null));
  return [null];
}

const isPinned = (c: Condition | null): c is Condition =>
  c !== null && c.op === "eq" && c.case_insensitive !== true;

/**
 * The values a row in `scope` must hold: every top-level `eq` condition (a
 * single condition, or the members of a top-level `and`). An insert gets them
 * written into the row; a patch naming one of these fields gets it overwritten.
 */
export function rowScopePins(scope: FilterNode | undefined): Record<string, unknown> {
  if (!scope) return {};
  return Object.fromEntries(
    topLevelConditions(scope)
      .filter(isPinned)
      .map((c) => [c.field, c.value]),
  );
}

/** Whether the scope is nothing but top-level `eq` conditions (so `rowScopePins` says it all). */
function onlyPins(scope: FilterNode): boolean {
  return topLevelConditions(scope).every(isPinned);
}

/** The schema as a scoped client sees it: the hidden fields are not in it. */
export function withoutFields(schema: SchemaDoc, hidden: ReadonlySet<string>): SchemaDoc {
  if (hidden.size === 0) return schema;
  return {
    ...schema,
    fields: Object.fromEntries(Object.entries(schema.fields).filter(([f]) => !hidden.has(f))),
    field_order: schema.field_order.filter((f) => !hidden.has(f)),
  };
}

/** The `describe` answer without the hidden fields (schema, columns, filter builder, search, chips). */
export function describeWithout(
  d: DescribeResponse,
  hidden: ReadonlySet<string>,
): DescribeResponse {
  if (hidden.size === 0) return d;
  const { view } = d;
  return {
    ...d,
    schema: withoutFields(d.schema, hidden),
    view: {
      ...view,
      ...(view.columns ? { columns: view.columns.filter((c) => !hidden.has(c.field)) } : {}),
      ...(view.search
        ? { search: { ...view.search, fields: view.search.fields.filter((f) => !hidden.has(f)) } }
        : {}),
      ...(view.filters ? { filters: view.filters.filter((f) => !hidden.has(f.field)) } : {}),
      ...(view.filterable
        ? {
            filterable: {
              ...view.filterable,
              fields: view.filterable.fields.filter(
                (f) => !hidden.has(typeof f === "string" ? f : f.field),
              ),
            },
          }
        : {}),
    },
    filterable: { fields: d.filterable.fields.filter((f) => !hidden.has(f.field)) },
  };
}

function unknownField(field: string, where: string): UdcError {
  // The same answer as for a field the schema does not have (`allowedField`).
  return new UdcError("validation_error", `unknown field in ${where}: ${JSON.stringify(field)}`, {
    field,
    where,
  });
}

function outOfScope(collection: string): UdcError {
  return new UdcError("forbidden", `the row would fall outside the row scope of ${collection}`, {
    collection,
    reason: "out_of_scope",
  });
}

/**
 * One collection as one request may reach it: the `access` check passed,
 * the row scope resolved for its `ctx`, the scope fields to hide. Every
 * action on rows goes through here, whatever the source: this is the
 * generic layer that holds a host's own source to the scope as well. A
 * source with `enforcesRowScope` also gets the scope in its statements, and
 * the read-before-write checks are left to it.
 */
export class ScopedCollection {
  readonly collection: Collection;
  /** The host's row filter for this request; `undefined` when unscoped. */
  readonly rowScope: FilterNode | undefined;
  /** What every source method of this request receives. */
  readonly sctx: SourceContext;
  /** The scope fields this request does not see. */
  readonly hidden: ReadonlySet<string>;
  private readonly ctx: unknown;
  private readonly options: RowScopeOptions;

  constructor(collection: Collection, ctx: unknown, options: RowScopeOptions) {
    this.collection = collection;
    this.ctx = ctx;
    this.options = options;
    this.rowScope = options.rowScope?.(ctx, collection.name) ?? undefined;
    this.sctx = this.rowScope
      ? { ctx, collection: collection.name, rowScope: this.rowScope }
      : { ctx, collection: collection.name };
    this.hidden =
      this.rowScope && !options.showScopeFields?.includes(collection.name)
        ? new Set(filterFields(this.rowScope))
        : new Set();
  }

  get source(): Source {
    return this.collection.source;
  }

  private get native(): boolean {
    return this.source.enforcesRowScope === true;
  }

  /** `access` said `true` for this action. */
  private granted(action: string): boolean {
    return this.options.access?.(this.ctx, { action, collection: this.collection.name }) === true;
  }

  /**
   * The capabilities this request is told: under a scope, `schema_edit` and
   * `source_yaml` are off unless `access` grants every schema action
   * (respectively `source.read`).
   */
  capabilities(): Capabilities {
    const caps = this.source.capabilities;
    if (!this.rowScope) return caps;
    return {
      ...caps,
      schema_edit: caps.schema_edit && SCHEMA_ACTIONS.every((a) => this.granted(a)),
      source_yaml: caps.source_yaml && this.granted("source.read"),
    };
  }

  /** `forbidden` for an action that acts for every tenant, under a scope that `access` does not lift. */
  assertTenantWide(action: string): void {
    if (this.rowScope && !this.granted(action)) {
      throw new UdcError(
        "forbidden",
        `${action} changes ${this.collection.name} for every tenant: not allowed under a row scope`,
        { collection: this.collection.name, action },
      );
    }
  }

  schema(): Promise<SchemaDoc> {
    return this.source.describe(this.sctx);
  }

  async describe(): Promise<DescribeResponse> {
    const c = this.collection;
    const d = buildDescribe(c.name, this.capabilities(), await this.schema(), c.view, {
      source_kind: this.source.kind ?? "postgres_jsonb",
      docs: c.docs,
      source: this.source.info?.(this.sctx),
    });
    return describeWithout(d, this.hidden);
  }

  async list(req: SourceListRequest): Promise<ListResponse> {
    if (!this.rowScope) return this.source.list(req, this.sctx);
    this.refuseHidden(req.filter, req.sort);
    const filter = this.native ? req.filter : andFilters(this.rowScope, req.filter);
    const res = await this.source.list({ ...req, filter }, this.sctx);
    // A source that does not apply the scope itself is checked row by row as well: one
    // that drops a condition (the filesystem's `path` selector) cannot leak a row.
    const rows = this.native ? res.rows : await this.onlyInScope(res.rows);
    return { ...res, rows: rows.map((r) => this.strip(r)) };
  }

  async read(id: string): Promise<Row> {
    return this.strip(await this.readInScope(id));
  }

  async mutate(m: SourceMutation): Promise<Row> {
    if (!this.rowScope) return this.source.mutate(m, this.sctx);
    const scope = this.rowScope;
    const given = withoutMeta(m.row ?? {});
    if (Object.keys(given).some((f) => this.hidden.has(f))) {
      // Exactly the answer for a field the schema lacks: validated against the schema without them.
      const visible = withoutFields(await this.schema(), this.hidden);
      assertValidRow(visible, given, m.op === "insert" ? "insert" : "patch");
    }
    const pins = rowScopePins(scope);
    let op: SourceMutation = m;
    if (m.op === "insert") {
      const row = { ...given, ...pins };
      if (!(await this.inScope(row))) throw outOfScope(this.collection.name);
      op = { ...m, row };
    } else if (m.op === "update") {
      const patch = { ...given };
      for (const [field, value] of Object.entries(pins)) {
        if (Object.hasOwn(patch, field)) patch[field] = value;
      }
      op = { ...m, row: patch };
      if (!this.native && m.id !== undefined) {
        const current = await this.readInScope(m.id);
        if (!(await this.inScope({ ...current, ...patch }))) throw outOfScope(this.collection.name);
      }
    } else if (!this.native && m.id !== undefined) {
      await this.readInScope(m.id);
    }
    return this.strip(await this.source.mutate(op, this.sctx));
  }

  async reindex(req: SourceReindex): Promise<number> {
    const source = this.source as Source & Required<Pick<Source, "reindex">>;
    if (!this.rowScope) return source.reindex(req, this.sctx);
    for (const field of Object.keys(req.scope)) {
      if (this.hidden.has(field)) throw unknownField(field, "reindex scope");
    }
    if (!this.native && !(onlyPins(this.rowScope) && isScalarPins(this.rowScope))) {
      throw new UdcError(
        "forbidden",
        `reindex on ${this.collection.name}: its source cannot hold a reindex to a row scope ` +
          "that is not eq conditions",
        { collection: this.collection.name },
      );
    }
    // The pins join the request's own scope; one that disagrees with it leaves no row to renumber.
    const scope = { ...req.scope };
    for (const [field, value] of Object.entries(rowScopePins(this.rowScope))) {
      if (!isScalar(value)) continue;
      if (Object.hasOwn(scope, field) && scope[field] !== value) return 0;
      scope[field] = value;
    }
    return source.reindex({ ...req, scope }, this.sctx);
  }

  async reparent(req: SourceTreeReparent): Promise<TreeReparentResult> {
    const source = this.source as Source & Required<Pick<Source, "reparent">>;
    if (!this.rowScope) return source.reparent(req, this.sctx);
    for (const field of Object.values(req.fields)) {
      if (typeof field === "string" && this.hidden.has(field)) {
        throw unknownField(field, "tree.reparent fields");
      }
    }
    if (!this.native) {
      await this.readInScope(req.id);
      if (req.parent !== null) await this.readInScope(req.parent);
    }
    const res = await source.reparent(req, this.sctx);
    return { ...res, row: this.strip(res.row) };
  }

  /** The row, or exactly the `not_found` of a missing id when it is outside the scope. */
  private async readInScope(id: string): Promise<Row> {
    const row = await this.source.read(id, this.sctx);
    if (this.rowScope && !this.native && !(await this.inScope(row))) throw notFound(id);
    return row;
  }

  private async onlyInScope(rows: Row[]): Promise<Row[]> {
    const kept: Row[] = [];
    for (const row of rows) if (await this.inScope(row)) kept.push(row);
    return kept;
  }

  private async inScope(row: Record<string, unknown>): Promise<boolean> {
    const scope = this.rowScope;
    if (!scope) return true;
    // `id` in a scope is the row id when the schema stores no such field (as in a list filter).
    const meta = row.__meta as { id?: unknown } | undefined;
    const byId =
      meta?.id !== undefined &&
      filterFields(scope).includes(ROW_ID) &&
      isRowIdField(await this.schema(), ROW_ID);
    return evaluateFilter(scope, byId ? { ...row, [ROW_ID]: meta?.id } : row);
  }

  private refuseHidden(filter: FilterNode | undefined, sort: SortKey[] | undefined): void {
    for (const field of filterFields(filter)) {
      if (this.hidden.has(field)) throw unknownField(field, "filter");
    }
    for (const key of sort ?? []) {
      if (this.hidden.has(key.field)) throw unknownField(key.field, "sort");
    }
  }

  private strip(row: Row): Row {
    if (this.hidden.size === 0) return row;
    return Object.fromEntries(Object.entries(row).filter(([f]) => !this.hidden.has(f))) as Row;
  }
}

function isScalar(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

function isScalarPins(scope: FilterNode): boolean {
  return Object.values(rowScopePins(scope)).every(isScalar);
}

/**
 * The collection `name` as this request may reach it through `action`:
 * `not_found` (the answer for an unknown collection) when it is not served
 * or `access` answers `false`.
 */
export function openCollection(
  registry: CollectionRegistry,
  options: RowScopeOptions,
  action: string,
  name: string,
  ctx: unknown,
): ScopedCollection {
  const collection = registry.get(name);
  if (options.access?.(ctx, { action, collection: collection.name }) === false) {
    throw new UdcError("not_found", `unknown collection: ${name}`, { collection: name });
  }
  return new ScopedCollection(collection, ctx, options);
}
