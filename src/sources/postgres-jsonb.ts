import {
  type Capabilities,
  FIELD_NAME_RE,
  type FilterNode,
  type ListResponse,
  ORDER_GAP,
  type Row,
  type SchemaDoc,
  UdcError,
} from "@jsudc/core";
import { type SQL, sql } from "drizzle-orm";
import type { Db, Executor } from "../db/client.js";
import { applySchemaEdit, type SchemaEdit } from "../schema-edit.js";
import { activeSchema, assertJsonbSchema, writeSchemaRevision } from "../schema-store.js";
import { andFilters } from "../scope.js";
import { idArray, missing, tooManyRows } from "./bulk.js";
import { type CursorValue, decodeCursor, encodeCursor, isUuid } from "./cursor.js";
import {
  assertQueryFields,
  assertValidRow,
  cycleError,
  notFound,
  type ReparentPlan,
  reindexPlan,
  reparentPlan,
  versionConflict,
  withoutMeta,
} from "./fields.js";
import { type OnMutateResult, type RowChange, runOnMutate } from "./on-mutate.js";
import {
  ALL_FILTER_OPS,
  DEFAULT_ORDER_FIELD,
  DEFAULT_PAGE_SIZE,
  type MutateManyResult,
  type Source,
  type SourceAddField,
  type SourceContext,
  type SourceListRequest,
  type SourceMutateMany,
  type SourceMutation,
  type SourceReindex,
  type SourceTreeReparent,
  type SourceUpdateField,
  type TreeReparentResult,
} from "./source.js";
import {
  compileFilter,
  compileSort,
  cursorPredicate,
  fieldExpr,
  orderBy,
  sortKeyColumns,
} from "./sql.js";

interface DbRow extends Record<string, unknown> {
  id: string;
  version: number;
  data: Record<string, unknown>;
}

/** A written row, with whether it is inside the row scope (absent when there is none). */
interface ScopedRow extends DbRow {
  __in_scope?: boolean;
}

export interface PostgresJsonbSourceOptions {
  db: Db;
  /** The collection's table; also its name in `udc_schema_revisions`. */
  table: string;
  /** `schema.json`: served until a revision is active. */
  initialSchema: SchemaDoc;
  pageSizeDefault?: number;
  /**
   * A host's own write on every mutation: with it, each mutation runs in a
   * transaction, and the hook runs after the source's statement and before
   * `COMMIT`; see `OnMutateHook`. Without it the statements are those of 0.3.0.
   */
  onMutate?(ctx: unknown, change: RowChange, tx: Executor): OnMutateResult;
}

/**
 * One table per collection, every field in `data jsonb`. Filters, sorts and
 * keyset cursors compile to SQL over `data->>'field'` with typed casts; the
 * schema comes from the collection's active revision on every call.
 */
export class PostgresJsonbSource implements Source {
  readonly kind = "postgres_jsonb";
  /** The row scope sits in the WHERE of every statement: the check and the write are one. */
  readonly enforcesRowScope = true;
  readonly capabilities: Capabilities = {
    mutate: true,
    subscribe: false,
    total_count: true,
    schema_edit: true,
    config_edit: false,
    reindex: true,
    tree_reparent: true,
    source_yaml: false,
    paging: ["cursor", "offset"],
    mutate_many: true,
    supported_filter_ops: ALL_FILTER_OPS,
  };

  private readonly db: Db;
  private readonly name: string;
  private readonly table: ReturnType<typeof sql.identifier>;
  private readonly initialSchema: SchemaDoc;
  private readonly pageSizeDefault: number;
  private readonly onMutate: PostgresJsonbSourceOptions["onMutate"];

  constructor(opts: PostgresJsonbSourceOptions) {
    if (!FIELD_NAME_RE.test(opts.table)) {
      throw new Error(
        `invalid table name ${JSON.stringify(opts.table)}: lowercase snake_case only`,
      );
    }
    assertJsonbSchema(opts.initialSchema, `collection ${opts.table}`);
    this.db = opts.db;
    this.name = opts.table;
    this.table = sql.identifier(opts.table);
    this.initialSchema = opts.initialSchema;
    this.pageSizeDefault = opts.pageSizeDefault ?? DEFAULT_PAGE_SIZE;
    this.onMutate = opts.onMutate;
  }

  async describe(_sctx?: SourceContext): Promise<SchemaDoc> {
    const schema = (await activeSchema(this.db, this.name)) ?? this.initialSchema;
    assertJsonbSchema(schema, `active schema of ${this.name}`);
    return schema;
  }

  async list(req: SourceListRequest, sctx?: SourceContext): Promise<ListResponse> {
    const schema = await this.describe();
    // Everything that can be refused is refused before any query runs.
    assertQueryFields(schema, req.filter, req.sort);
    // The row scope is ANDed in, so the total and both pagings count in-scope rows only.
    const where = compileFilter(andFilters(sctx?.rowScope, req.filter), schema);
    const terms = compileSort(req.sort, schema);
    const limit = req.page?.limit ?? this.pageSizeDefault;
    const cursor = req.page?.cursor;
    const offset = req.page?.offset ?? 0;
    const after = cursor != null ? decodeCursor(cursor, terms.length) : null;
    const pageWhere = after
      ? sql`${where} AND ${cursorPredicate(terms, after.values, after.id)}`
      : where;
    const keyCols = terms.length > 0 ? sql`, ${sortKeyColumns(terms)}` : sql``;

    // One extra row tells whether there is a next page.
    const [rows, count] = await Promise.all([
      this.db.execute<DbRow>(sql`
        SELECT id, version, data${keyCols}
        FROM ${this.table}
        WHERE ${pageWhere}
        ORDER BY ${orderBy(terms)}
        LIMIT ${limit + 1} OFFSET ${after ? 0 : offset}`),
      this.db.execute<{ total: number }>(
        sql`SELECT count(*)::int AS total FROM ${this.table} WHERE ${where}`,
      ),
    ]);

    const page = rows.rows.slice(0, limit);
    const last = page.at(-1);
    const next_cursor =
      rows.rows.length > limit && last
        ? encodeCursor([...terms.map((_, i) => (last[`__k${i}`] ?? null) as CursorValue), last.id])
        : null;
    return { rows: page.map(serialize), next_cursor, total: count.rows[0]?.total ?? 0 };
  }

  async read(id: string, sctx?: SourceContext): Promise<Row> {
    if (!isUuid(id)) throw notFound(id);
    const scope = await this.scopeSql(sctx);
    const res = await this.db.execute<DbRow>(
      sql`SELECT id, version, data FROM ${this.table} WHERE id = ${id}::uuid AND ${scope}`,
    );
    const row = res.rows[0];
    if (!row) throw notFound(id);
    return serialize(row);
  }

  async mutate(m: SourceMutation, sctx?: SourceContext): Promise<Row> {
    const schema = await this.describe();
    const rowScope = sctx?.rowScope;
    const hook = this.onMutate;
    if (hook) {
      const scope = rowScope ? compileFilter(rowScope, schema) : sql`TRUE`;
      return this.db.transaction(async (tx) => {
        // The row as it was, locked until COMMIT; the write below decides not_found / conflict.
        const before =
          m.op !== "insert" && m.id !== undefined && isUuid(m.id)
            ? await this.lockRow(tx, m.id, scope)
            : null;
        const written = await this.write(tx, schema, m, scope, rowScope);
        const change: RowChange = {
          op: m.op,
          collection: sctx?.collection ?? this.name,
          id: written.__meta.id,
          before: m.op === "insert" ? null : (before ?? written),
          after: m.op === "delete" ? null : written,
          patch: m.op === "delete" ? null : withoutMeta(m.row ?? {}),
        };
        return runOnMutate(hook, sctx, change, tx);
      });
    }
    // Under a row scope, the written row must still be inside it: checked on the
    // RETURNING row, in a transaction that rolls the write back when it is not.
    if (rowScope) {
      const scope = compileFilter(rowScope, schema);
      return this.db.transaction((tx) => this.write(tx, schema, m, scope, rowScope));
    }
    return this.write(this.db, schema, m, sql`TRUE`, undefined);
  }

  private async write(
    db: Executor,
    schema: SchemaDoc,
    m: SourceMutation,
    scope: SQL,
    rowScope: FilterNode | undefined,
  ): Promise<Row> {
    const inScope = (row: ScopedRow) => {
      if (row.__in_scope === false) {
        throw new UdcError(
          "forbidden",
          `the row would fall outside the row scope of ${this.name}`,
          {
            collection: this.name,
            reason: "out_of_scope",
          },
        );
      }
      return serialize(row);
    };
    const check = rowScope ? sql`, (${scope}) AS __in_scope` : sql``;
    if (m.op === "insert") {
      const data = withoutMeta(m.row ?? {});
      assertValidRow(schema, data, "insert");
      const res = await db.execute<ScopedRow>(sql`
        INSERT INTO ${this.table} (data) VALUES (${JSON.stringify(data)}::jsonb)
        RETURNING id, version, data${check}`);
      return inScope(res.rows[0] as ScopedRow);
    }

    if (m.id === undefined) throw new UdcError("validation_error", `${m.op} needs an id`);
    const id = m.id;
    const patch = withoutMeta(m.row ?? {});
    if (m.op === "update") assertValidRow(schema, patch, "patch");
    if (!isUuid(id)) throw notFound(id);

    // The version check is part of the statement, so two concurrent edits cannot both win.
    const versionCheck =
      m.expected_version === undefined ? sql`` : sql` AND version = ${m.expected_version}`;
    // The row scope is in the WHERE (a row outside it is not found) and, for an
    // update, evaluated again on the new row in RETURNING.
    const res =
      m.op === "update"
        ? await db.execute<ScopedRow>(sql`
            UPDATE ${this.table}
            SET data = data || ${JSON.stringify(patch)}::jsonb, version = version + 1, updated_at = now()
            WHERE id = ${id}::uuid${versionCheck} AND ${scope}
            RETURNING id, version, data${check}`)
        : await db.execute<ScopedRow>(sql`
            DELETE FROM ${this.table} WHERE id = ${id}::uuid${versionCheck} AND ${scope}
            RETURNING id, version, data`);
    const row = res.rows[0];
    if (row) return inScope(row);

    // A row outside the scope does not exist for this request: no version conflict for it.
    const current = await db.execute<{ version: number }>(
      sql`SELECT version FROM ${this.table} WHERE id = ${id}::uuid AND ${scope}`,
    );
    const version = current.rows[0]?.version;
    if (version === undefined || m.expected_version === undefined) throw notFound(id);
    throw versionConflict(id, m.expected_version, version);
  }

  /**
   * `mutate_many` in one transaction. The patch and the filter are checked
   * first; then the target rows (the ids, or the filter minus `except_ids`,
   * always inside the row scope) are locked in id order, at most `limit + 1`
   * of them, so a filter reaching more is refused before anything is
   * written. Without `onMutate` one `UPDATE` / `DELETE` writes them all; with
   * it, row by row, the hook called for each, and a hook failure rolls the
   * whole request back. A patch taking a row out of the scope is refused
   * (`forbidden`) and rolls back as well.
   */
  async mutateMany(req: SourceMutateMany, sctx?: SourceContext): Promise<MutateManyResult> {
    const schema = await this.describe();
    const patch = withoutMeta(req.row ?? {});
    if (req.op === "update") assertValidRow(schema, patch, "patch");
    assertQueryFields(schema, req.filter, undefined);
    const rowScope = sctx?.rowScope;
    const scope = rowScope ? compileFilter(rowScope, schema) : sql`TRUE`;
    const requested = req.ids ?? [];
    let target: SQL;
    if (req.ids) {
      const ids = req.ids.filter(isUuid);
      if (ids.length === 0) return { updated: 0, failed: missing(requested, new Set()) };
      target = sql`id = ANY(${idArray(ids, "uuid")})`;
    } else {
      const except = (req.except_ids ?? []).filter(isUuid);
      const filter = compileFilter(req.filter, schema);
      target =
        except.length === 0
          ? filter
          : sql`${filter} AND NOT (id = ANY(${idArray(except, "uuid")}))`;
    }
    const hook = this.onMutate;
    const collection = sctx?.collection ?? this.name;

    return this.db.transaction(async (tx) => {
      const locked = await tx.execute<DbRow>(sql`
        SELECT id::text AS id, version, ${hook ? sql`data` : sql`NULL::jsonb AS data`}
        FROM ${this.table}
        WHERE ${target} AND ${scope}
        ORDER BY id
        LIMIT ${req.limit + 1}
        FOR UPDATE`);
      if (locked.rows.length > req.limit) {
        throw tooManyRows(collection, req.limit, req.ids ? "ids" : "filter");
      }
      const found = locked.rows.map((r) => r.id);
      const failed = req.ids ? missing(requested, new Set(found)) : [];
      if (found.length === 0) return { updated: 0, failed };
      const outOfScope = () =>
        new UdcError("forbidden", `the row would fall outside the row scope of ${this.name}`, {
          collection: this.name,
          reason: "out_of_scope",
        });

      if (!hook) {
        const these = idArray(found, "uuid");
        if (req.op === "delete") {
          const res = await tx.execute(sql`DELETE FROM ${this.table} WHERE id = ANY(${these})`);
          return { updated: res.rowCount ?? 0, failed };
        }
        const res = await tx.execute<{ in_scope: boolean }>(sql`
          UPDATE ${this.table}
          SET data = data || ${JSON.stringify(patch)}::jsonb, version = version + 1, updated_at = now()
          WHERE id = ANY(${these})
          RETURNING (${scope}) AS in_scope`);
        if (rowScope && res.rows.some((r) => r.in_scope !== true)) throw outOfScope();
        return { updated: res.rowCount ?? 0, failed };
      }

      const check = rowScope ? sql`, (${scope}) AS __in_scope` : sql``;
      for (const current of locked.rows) {
        const before = serialize(current);
        let after: Row | null = null;
        if (req.op === "update") {
          const res = await tx.execute<ScopedRow>(sql`
            UPDATE ${this.table}
            SET data = data || ${JSON.stringify(patch)}::jsonb, version = version + 1, updated_at = now()
            WHERE id = ${current.id}::uuid
            RETURNING id::text AS id, version, data${check}`);
          const row = res.rows[0] as ScopedRow;
          if (row.__in_scope === false) throw outOfScope();
          after = serialize(row);
        } else {
          await tx.execute(sql`DELETE FROM ${this.table} WHERE id = ${current.id}::uuid`);
        }
        await runOnMutate(
          hook,
          sctx,
          {
            op: req.op,
            collection,
            id: current.id,
            before,
            after,
            patch: req.op === "update" ? patch : null,
          },
          tx,
        );
      }
      return { updated: found.length, failed };
    });
  }

  /** The row `id` in scope, locked `FOR UPDATE`; `null` when there is none. */
  private async lockRow(tx: Executor, id: string, scope: SQL): Promise<Row | null> {
    const res = await tx.execute<DbRow>(
      sql`SELECT id, version, data FROM ${this.table} WHERE id = ${id}::uuid AND ${scope} FOR UPDATE`,
    );
    const row = res.rows[0];
    return row ? serialize(row) : null;
  }

  /**
   * One statement: number the scope's rows by their current order (NULLS
   * LAST, ties by id) and write `n * gap` back, bumping each version. The
   * order and scope fields passed the allowlist, so they may sit in the SQL.
   */
  async reindex(req: SourceReindex, sctx?: SourceContext): Promise<number> {
    const schema = await this.describe();
    const { filter, orderField, orderDef } = reindexPlan(
      schema,
      req.scope,
      req.order_field ?? DEFAULT_ORDER_FIELD,
    );
    // The request's scope (a kanban column) AND the host's row scope.
    const where = compileFilter(andFilters(filter, sctx?.rowScope), schema);
    const order = fieldExpr(orderField, orderDef);
    const gap = req.gap ?? ORDER_GAP;
    const res = await this.db.execute(sql`
      UPDATE ${this.table} AS t
      SET data = jsonb_set(t.data, ARRAY[${orderField}]::text[], to_jsonb(r.n * ${gap}::int)),
          version = t.version + 1,
          updated_at = now()
      FROM (
        SELECT id, ROW_NUMBER() OVER (ORDER BY ${order} NULLS LAST, id) AS n
        FROM ${this.table}
        WHERE ${where}
      ) AS r
      WHERE t.id = r.id`);
    return res.rowCount ?? 0;
  }

  /**
   * One transaction: lock the node, check its version and the new parent's
   * chain (a cycle is refused), write parent and order, then — when the
   * parent changed — recompute depth and ancestor ids of the whole subtree
   * with a recursive CTE over `data->>parent_field`, and recount both
   * parents' children. Every row written gets its version bumped once.
   */
  async reparent(req: SourceTreeReparent, sctx?: SourceContext): Promise<TreeReparentResult> {
    const schema = await this.describe();
    const plan = reparentPlan(schema, req.fields, req);
    // Every statement below stays inside the row scope: the node, the new
    // parent's chain, the subtree and the children counts.
    const scope = sctx?.rowScope ? compileFilter(sctx.rowScope, schema) : sql`TRUE`;
    if (!isUuid(req.id)) throw notFound(req.id);
    if (req.parent !== null && !isUuid(req.parent)) throw notFound(req.parent);
    const parent = req.parent;
    const t = this.table;
    const pf = plan.parentField;

    return this.db.transaction(async (tx) => {
      const found = await tx.execute<{ version: number; parent: string | null }>(sql`
        SELECT version, ${parentOf(pf)} AS parent FROM ${t}
        WHERE id = ${req.id}::uuid AND ${scope} FOR UPDATE`);
      const node = found.rows[0];
      if (!node) throw notFound(req.id);
      if (req.expected_version !== undefined && req.expected_version !== node.version) {
        throw versionConflict(req.id, req.expected_version, node.version);
      }
      const chain = parent === null ? [] : await this.chainUp(tx, pf, parent, scope);
      if (parent !== null && chain.length === 0) throw notFound(parent);
      if (chain.includes(req.id)) throw cycleError(req.id, parent as string);

      const moved = node.parent !== parent;
      const ancestors = [...chain].reverse();
      const patch: Record<string, unknown> = { [pf]: parent, [plan.orderField]: req.order };
      if (moved && plan.depthField) patch[plan.depthField] = ancestors.length;
      if (moved && plan.ancestorIdsField) patch[plan.ancestorIdsField] = ancestors;
      const res = await tx.execute<DbRow>(sql`
        UPDATE ${t}
        SET data = data || ${JSON.stringify(patch)}::jsonb, version = version + 1, updated_at = now()
        WHERE id = ${req.id}::uuid
        RETURNING id, version, data`);
      let updated = 1;
      if (moved) {
        updated += await this.restructureSubtree(tx, plan, req.id, ancestors, scope);
        updated += await this.recountChildren(tx, plan, [node.parent, parent], scope);
      }
      return { row: serialize(res.rows[0] as DbRow), updated };
    });
  }

  /** The ids from `start` up to its root, nearest first; empty when `start` does not exist. */
  private async chainUp(tx: Executor, pf: string, start: string, scope: SQL): Promise<string[]> {
    // `CYCLE` stops the walk on data that already loops instead of running forever.
    const res = await tx.execute<{ id: string }>(sql`
      WITH RECURSIVE up(id, parent, n) AS (
        SELECT id, ${parentOf(pf)}, 0 FROM ${this.table} WHERE id = ${start}::uuid AND ${scope}
        UNION ALL
        SELECT t.id, ${parentOf(pf, "t")}, up.n + 1
        FROM ${this.table} t JOIN up ON t.id::text = up.parent
        WHERE ${scope}
      ) CYCLE id SET looped USING path
      SELECT id::text FROM up WHERE NOT looped ORDER BY n`);
    return res.rows.map((r) => r.id);
  }

  /** Depth and ancestor ids of every descendant of `root`, whose own ancestors are `ancestors`. */
  private async restructureSubtree(
    tx: Executor,
    plan: ReparentPlan,
    root: string,
    ancestors: string[],
    scope: SQL,
  ): Promise<number> {
    if (!plan.depthField && !plan.ancestorIdsField) return 0;
    const pf = plan.parentField;
    const set = [
      plan.depthField
        ? sql`jsonb_build_object(${plan.depthField}::text, jsonb_array_length(s.anc))`
        : null,
      plan.ancestorIdsField ? sql`jsonb_build_object(${plan.ancestorIdsField}::text, s.anc)` : null,
    ].filter((x) => x !== null);
    const res = await tx.execute(sql`
      WITH RECURSIVE sub(id, anc) AS (
        SELECT c.id, ${JSON.stringify([...ancestors, root])}::jsonb
        FROM ${this.table} c WHERE ${parentOf(pf, "c")} = ${root} AND ${scope}
        UNION ALL
        SELECT c.id, sub.anc || to_jsonb(sub.id::text)
        FROM ${this.table} c JOIN sub ON ${parentOf(pf, "c")} = sub.id::text
        WHERE ${scope}
      ) CYCLE id SET looped USING path
      UPDATE ${this.table} AS t
      SET data = t.data || ${sql.join(set, sql` || `)}, version = t.version + 1, updated_at = now()
      FROM sub s
      WHERE t.id = s.id AND NOT s.looped AND ${scope}`);
    return res.rowCount ?? 0;
  }

  /** Set the children count of each parent to what it is now (the old one loses, the new one gains). */
  private async recountChildren(
    tx: Executor,
    plan: ReparentPlan,
    parents: (string | null)[],
    scope: SQL,
  ): Promise<number> {
    const field = plan.childrenCountField;
    const ids = parents.filter((p): p is string => p !== null && isUuid(p));
    if (!field || ids.length === 0) return 0;
    const pf = plan.parentField;
    const res = await tx.execute(sql`
      UPDATE ${this.table} AS t
      SET data = jsonb_set(t.data, ARRAY[${field}]::text[], to_jsonb((
            SELECT count(*)::int FROM ${this.table} c
            WHERE ${parentOf(pf, "c")} = t.id::text AND ${scope}))),
          version = t.version + 1,
          updated_at = now()
      WHERE t.id = ANY(${`{${ids.join(",")}}`}::uuid[]) AND ${scope}`);
    return res.rowCount ?? 0;
  }

  addField(req: SourceAddField, _sctx?: SourceContext): Promise<SchemaDoc> {
    return this.editSchema({ op: "add", ...req });
  }

  updateField(req: SourceUpdateField, _sctx?: SourceContext): Promise<SchemaDoc> {
    return this.editSchema({ op: "update", ...req });
  }

  softDeleteField(field: string, _sctx?: SourceContext): Promise<SchemaDoc> {
    return this.editSchema({ op: "soft_delete", field });
  }

  /** The row scope of `sctx` as SQL over the active schema; `TRUE` without one. */
  private async scopeSql(sctx: SourceContext | undefined): Promise<SQL> {
    if (!sctx?.rowScope) return sql`TRUE`;
    return compileFilter(sctx.rowScope, await this.describe());
  }

  private editSchema(edit: SchemaEdit): Promise<SchemaDoc> {
    return writeSchemaRevision(this.db, {
      collection: this.name,
      initial: this.initialSchema,
      edit: (current) => {
        assertJsonbSchema(current, `active schema of ${this.name}`);
        return {
          schema: applySchemaEdit(current, edit),
          touched: [edit.op === "soft_delete" ? edit.field : edit.name],
        };
      },
    });
  }
}

/**
 * `data->>'<parent field>'` written into the SQL text, the form the field's
 * expression index is built on; the name passed the allowlist (`reparentPlan`).
 */
function parentOf(field: string, alias?: string): SQL {
  return sql.raw(`(${alias ? `${alias}.` : ""}data->>'${field}')`);
}

function serialize(row: DbRow): Row {
  const { __meta: _, ...data } = row.data;
  return { __meta: { id: row.id, version: row.version }, ...data };
}
