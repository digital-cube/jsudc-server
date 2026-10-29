import {
  type Capabilities,
  FIELD_NAME_RE,
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
import {
  ALL_FILTER_OPS,
  DEFAULT_ORDER_FIELD,
  DEFAULT_PAGE_SIZE,
  type Source,
  type SourceAddField,
  type SourceListRequest,
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

export interface PostgresJsonbSourceOptions {
  db: Db;
  /** The collection's table; also its name in `udc_schema_revisions`. */
  table: string;
  /** `schema.json`: served until a revision is active. */
  initialSchema: SchemaDoc;
  pageSizeDefault?: number;
}

/**
 * One table per collection, every field in `data jsonb`. Filters, sorts and
 * keyset cursors compile to SQL over `data->>'field'` with typed casts; the
 * schema comes from the collection's active revision on every call.
 */
export class PostgresJsonbSource implements Source {
  readonly kind = "postgres_jsonb";
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
    supported_filter_ops: ALL_FILTER_OPS,
  };

  private readonly db: Db;
  private readonly name: string;
  private readonly table: ReturnType<typeof sql.identifier>;
  private readonly initialSchema: SchemaDoc;
  private readonly pageSizeDefault: number;

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
  }

  async describe(): Promise<SchemaDoc> {
    const schema = (await activeSchema(this.db, this.name)) ?? this.initialSchema;
    assertJsonbSchema(schema, `active schema of ${this.name}`);
    return schema;
  }

  async list(req: SourceListRequest): Promise<ListResponse> {
    const schema = await this.describe();
    // Everything that can be refused is refused before any query runs.
    assertQueryFields(schema, req.filter, req.sort);
    const where = compileFilter(req.filter, schema);
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

  async read(id: string): Promise<Row> {
    if (!isUuid(id)) throw notFound(id);
    const res = await this.db.execute<DbRow>(
      sql`SELECT id, version, data FROM ${this.table} WHERE id = ${id}::uuid`,
    );
    const row = res.rows[0];
    if (!row) throw notFound(id);
    return serialize(row);
  }

  async mutate(m: SourceMutation): Promise<Row> {
    const schema = await this.describe();
    if (m.op === "insert") {
      const data = withoutMeta(m.row ?? {});
      assertValidRow(schema, data, "insert");
      const res = await this.db.execute<DbRow>(sql`
        INSERT INTO ${this.table} (data) VALUES (${JSON.stringify(data)}::jsonb)
        RETURNING id, version, data`);
      return serialize(res.rows[0] as DbRow);
    }

    if (m.id === undefined) throw new UdcError("validation_error", `${m.op} needs an id`);
    const id = m.id;
    const patch = withoutMeta(m.row ?? {});
    if (m.op === "update") assertValidRow(schema, patch, "patch");
    if (!isUuid(id)) throw notFound(id);

    // The version check is part of the statement, so two concurrent edits cannot both win.
    const versionCheck =
      m.expected_version === undefined ? sql`` : sql` AND version = ${m.expected_version}`;
    const res =
      m.op === "update"
        ? await this.db.execute<DbRow>(sql`
            UPDATE ${this.table}
            SET data = data || ${JSON.stringify(patch)}::jsonb, version = version + 1, updated_at = now()
            WHERE id = ${id}::uuid${versionCheck}
            RETURNING id, version, data`)
        : await this.db.execute<DbRow>(sql`
            DELETE FROM ${this.table} WHERE id = ${id}::uuid${versionCheck}
            RETURNING id, version, data`);
    const row = res.rows[0];
    if (row) return serialize(row);

    const current = await this.db.execute<{ version: number }>(
      sql`SELECT version FROM ${this.table} WHERE id = ${id}::uuid`,
    );
    const version = current.rows[0]?.version;
    if (version === undefined || m.expected_version === undefined) throw notFound(id);
    throw versionConflict(id, m.expected_version, version);
  }

  /**
   * One statement: number the scope's rows by their current order (NULLS
   * LAST, ties by id) and write `n * gap` back, bumping each version. The
   * order and scope fields passed the allowlist, so they may sit in the SQL.
   */
  async reindex(req: SourceReindex): Promise<number> {
    const schema = await this.describe();
    const { filter, orderField, orderDef } = reindexPlan(
      schema,
      req.scope,
      req.order_field ?? DEFAULT_ORDER_FIELD,
    );
    const where = compileFilter(filter, schema);
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
  async reparent(req: SourceTreeReparent): Promise<TreeReparentResult> {
    const schema = await this.describe();
    const plan = reparentPlan(schema, req.fields, req);
    if (!isUuid(req.id)) throw notFound(req.id);
    if (req.parent !== null && !isUuid(req.parent)) throw notFound(req.parent);
    const parent = req.parent;
    const t = this.table;
    const pf = plan.parentField;

    return this.db.transaction(async (tx) => {
      const found = await tx.execute<{ version: number; parent: string | null }>(sql`
        SELECT version, ${parentOf(pf)} AS parent FROM ${t} WHERE id = ${req.id}::uuid FOR UPDATE`);
      const node = found.rows[0];
      if (!node) throw notFound(req.id);
      if (req.expected_version !== undefined && req.expected_version !== node.version) {
        throw versionConflict(req.id, req.expected_version, node.version);
      }
      const chain = parent === null ? [] : await this.chainUp(tx, pf, parent);
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
        updated += await this.restructureSubtree(tx, plan, req.id, ancestors);
        updated += await this.recountChildren(tx, plan, [node.parent, parent]);
      }
      return { row: serialize(res.rows[0] as DbRow), updated };
    });
  }

  /** The ids from `start` up to its root, nearest first; empty when `start` does not exist. */
  private async chainUp(tx: Executor, pf: string, start: string): Promise<string[]> {
    // `CYCLE` stops the walk on data that already loops instead of running forever.
    const res = await tx.execute<{ id: string }>(sql`
      WITH RECURSIVE up(id, parent, n) AS (
        SELECT id, ${parentOf(pf)}, 0 FROM ${this.table} WHERE id = ${start}::uuid
        UNION ALL
        SELECT t.id, ${parentOf(pf, "t")}, up.n + 1
        FROM ${this.table} t JOIN up ON t.id::text = up.parent
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
        FROM ${this.table} c WHERE ${parentOf(pf, "c")} = ${root}
        UNION ALL
        SELECT c.id, sub.anc || to_jsonb(sub.id::text)
        FROM ${this.table} c JOIN sub ON ${parentOf(pf, "c")} = sub.id::text
      ) CYCLE id SET looped USING path
      UPDATE ${this.table} AS t
      SET data = t.data || ${sql.join(set, sql` || `)}, version = t.version + 1, updated_at = now()
      FROM sub s
      WHERE t.id = s.id AND NOT s.looped`);
    return res.rowCount ?? 0;
  }

  /** Set the children count of each parent to what it is now (the old one loses, the new one gains). */
  private async recountChildren(
    tx: Executor,
    plan: ReparentPlan,
    parents: (string | null)[],
  ): Promise<number> {
    const field = plan.childrenCountField;
    const ids = parents.filter((p): p is string => p !== null && isUuid(p));
    if (!field || ids.length === 0) return 0;
    const pf = plan.parentField;
    const res = await tx.execute(sql`
      UPDATE ${this.table} AS t
      SET data = jsonb_set(t.data, ARRAY[${field}]::text[], to_jsonb((
            SELECT count(*)::int FROM ${this.table} c WHERE ${parentOf(pf, "c")} = t.id::text))),
          version = t.version + 1,
          updated_at = now()
      WHERE t.id = ANY(${`{${ids.join(",")}}`}::uuid[])`);
    return res.rowCount ?? 0;
  }

  addField(req: SourceAddField): Promise<SchemaDoc> {
    return this.editSchema({ op: "add", ...req });
  }

  updateField(req: SourceUpdateField): Promise<SchemaDoc> {
    return this.editSchema({ op: "update", ...req });
  }

  softDeleteField(field: string): Promise<SchemaDoc> {
    return this.editSchema({ op: "soft_delete", field });
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
