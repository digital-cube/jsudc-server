import {
  type Capabilities,
  type FieldDef,
  type ListResponse,
  type Row,
  type SchemaDoc,
  UdcError,
} from "@jsudc/core";
import { type SQL, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { type CursorValue, decodeCursor, encodeCursor, isIdOfType } from "./cursor.js";
import { assertQueryFields, notFound } from "./fields.js";
import {
  ALL_FILTER_OPS,
  DEFAULT_PAGE_SIZE,
  type Source,
  type SourceAddField,
  type SourceContext,
  type SourceListRequest,
  type SourceMutation,
  type SourceUpdateField,
} from "./source.js";
import {
  codePointOrder,
  compileFilter,
  compileSort,
  cursorPredicate,
  type FieldResolver,
  orderBy,
  type SqlArrayForm,
  type SqlIdType,
  sortKeyColumns,
} from "./sql.js";

const ARRAY_TYPES: ReadonlySet<FieldDef["type"]> = new Set(["string_array", "lookup_array"]);

export interface ColumnResolverOptions {
  /** Field → its SQL expression: a column, or any expression with one value per row. */
  fields: Readonly<Record<string, SQL>>;
  /** How each array field is stored; `text[]` when not named here. */
  arrayForms?: Readonly<Record<string, SqlArrayForm>> | undefined;
  /** The row id expression. */
  id: SQL;
  idType?: SqlIdType | undefined;
}

/**
 * A resolver over typed columns (what `PostgresTableSource` compiles with):
 * a number, date, datetime or bool column is compared as its own type, a
 * text form goes through `::text` under `COLLATE "C"` (code point order, as
 * `evaluateFilter`), an array field is a Postgres array unless `arrayForms`
 * says `jsonb`. A field it has no expression for is a programming error.
 */
export function columnResolver(opts: ColumnResolverOptions): FieldResolver {
  const expr = (field: string): SQL => {
    const e = Object.hasOwn(opts.fields, field) ? opts.fields[field] : undefined;
    if (!e) throw new Error(`columnResolver: no SQL expression for the field ${field}`);
    return e;
  };
  return {
    text: (field) => sql`((${expr(field)})::text)`,
    typed: (field, _def, cast) =>
      cast === "text" ? codePointOrder(sql`(${expr(field)})::text`) : sql`(${expr(field)})`,
    array: (field) => ({ expr: sql`(${expr(field)})`, form: opts.arrayForms?.[field] ?? "text[]" }),
    id: opts.id,
    idType: opts.idType ?? "uuid",
  };
}

/** One field of a `postgres_table` collection, when it is more than a column of its own name. */
export interface TableFieldSpec {
  /** A column (`subject`, or qualified `m.subject` under a `from` with joins). */
  column?: string | undefined;
  /**
   * An SQL expression given by the host in code (never from a request): a
   * count over a link table, an array aggregated from a join. Filterable and
   * sortable when it has one scalar value per row (a correlated subquery, a
   * column of a `LATERAL` join); an aggregate over a grouped `FROM` is not.
   */
  sql?: SQL | string | undefined;
  /** Computed: read, never written (the write side refuses it). Implied by `sql`. */
  computed?: boolean | undefined;
  /** `false`: refused in a filter like an unknown field and left out of `describe.filterable`. */
  filterable?: boolean | undefined;
  /** `false`: refused in a sort like an unknown field. */
  sortable?: boolean | undefined;
  /** An array field stored as a Postgres array (`text[]`, the default) or a jsonb array. */
  array?: SqlArrayForm | undefined;
}

export interface PostgresTableSourceOptions {
  db: Db;
  /** The collection's `schema.json`; there are no revisions. */
  schema: SchemaDoc;
  /** The table (`message`, or `inbox.message`). Exactly one of `table` and `from`. */
  table?: string | undefined;
  /** A `FROM` clause with joins, written by the host in code; never built from a request. */
  from?: SQL | string | undefined;
  /** Field → column name, or a `TableFieldSpec`. A field without an entry reads the column of its own name. */
  fields?: Readonly<Record<string, string | TableFieldSpec>> | undefined;
  /** The row id column (`id`); qualified under a `from` with joins. */
  idColumn?: string | undefined;
  /** `uuid` (default), `text` or `integer`; the cursor and `read` follow it. */
  idType?: SqlIdType | undefined;
  /** An integer column served as `__meta.version`; without one every row is version 1. */
  versionColumn?: string | undefined;
  /** A condition (SQL, from code) ANDed into every statement. */
  where?: SQL | string | undefined;
  /** `false`: no `count(*)` next to the page; `total` is `null`. Default `true`. */
  totalCount?: boolean | undefined;
  /** `true`: a NULL column is served as `null`; by default it is left out of the row. */
  keepNulls?: boolean | undefined;
  pageSizeDefault?: number | undefined;
}

const IDENT_PART = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

/** `message` or `inbox.message` as quoted identifiers; anything else is refused. */
function identifier(name: string, what: string): SQL {
  const parts = name.split(".");
  if (parts.length > 2 || !parts.every((p) => IDENT_PART.test(p))) {
    throw new Error(`invalid ${what} ${JSON.stringify(name)}: a name or schema.name`);
  }
  return sql.join(
    parts.map((p) => sql.identifier(p)),
    sql`.`,
  );
}

const raw = (s: SQL | string): SQL => (typeof s === "string" ? sql.raw(s) : s);

interface TableRow extends Record<string, unknown> {
  __id: string;
  __version: number;
}

/**
 * A collection served from an ordinary relational table (or a `FROM` with
 * joins) with typed columns: the filter operators, sort, keyset cursor and
 * offset paging of `postgres_jsonb`, through the same compiler with a column
 * resolver. Read-only for now; the schema is the collection's `schema.json`.
 */
export class PostgresTableSource implements Source {
  readonly kind = "postgres_table";
  /** The row scope sits in the WHERE of every statement. */
  readonly enforcesRowScope = true;
  readonly capabilities: Capabilities;
  /** The fields a client may not filter by (`filterable: false`); left out of `describe.filterable`. */
  readonly notFilterable: readonly string[];
  /** The fields that are computed (an SQL expression): read, never written. */
  readonly computedFields: readonly string[];

  private readonly db: Db;
  private readonly schema: SchemaDoc;
  /** The schema a client filter is checked against: the not-filterable fields read as unknown. */
  private readonly filterSchema: SchemaDoc;
  /** The schema a client sort is checked against: the not-sortable fields read as unknown. */
  private readonly sortSchema: SchemaDoc;
  private readonly resolver: FieldResolver;
  private readonly from: SQL;
  private readonly baseWhere: SQL;
  private readonly version: SQL;
  private readonly selected: { field: string; expr: SQL }[];
  private readonly totalCount: boolean;
  private readonly keepNulls: boolean;
  private readonly pageSizeDefault: number;
  private readonly label: string;

  constructor(opts: PostgresTableSourceOptions) {
    if ((opts.table === undefined) === (opts.from === undefined)) {
      throw new Error("PostgresTableSource: give exactly one of table and from");
    }
    const schema = opts.schema;
    const given = opts.fields ?? {};
    for (const field of Object.keys(given)) {
      const def = schema.fields[field];
      if (!def || def.deleted) {
        throw new Error(`PostgresTableSource: ${field} is not a field of the schema`);
      }
    }
    this.db = opts.db;
    this.schema = schema;
    this.label = opts.table ?? "postgres_table";
    this.from = opts.table !== undefined ? identifier(opts.table, "table") : raw(opts.from ?? "");
    this.baseWhere = opts.where === undefined ? sql`TRUE` : sql`(${raw(opts.where)})`;
    this.version =
      opts.versionColumn === undefined
        ? sql`1`
        : sql`(${identifier(opts.versionColumn, "version column")})::int`;
    this.totalCount = opts.totalCount ?? true;
    this.keepNulls = opts.keepNulls ?? false;
    this.pageSizeDefault = opts.pageSizeDefault ?? DEFAULT_PAGE_SIZE;

    const exprs: Record<string, SQL> = {};
    const arrayForms: Record<string, SqlArrayForm> = {};
    const notFilterable: string[] = [];
    const notSortable: string[] = [];
    const computed: string[] = [];
    const live = schema.field_order.filter((f) => schema.fields[f] && !schema.fields[f]?.deleted);
    for (const field of live) {
      const entry = Object.hasOwn(given, field) ? given[field] : undefined;
      const spec: TableFieldSpec = typeof entry === "string" ? { column: entry } : (entry ?? {});
      if (spec.sql !== undefined && spec.column !== undefined) {
        throw new Error(`PostgresTableSource: ${field} has both column and sql`);
      }
      exprs[field] =
        spec.sql !== undefined
          ? sql`(${raw(spec.sql)})`
          : identifier(spec.column ?? field, `column of ${field}`);
      if (spec.sql !== undefined || spec.computed) computed.push(field);
      if (spec.filterable === false) notFilterable.push(field);
      if (spec.sortable === false) notSortable.push(field);
      if (spec.array && ARRAY_TYPES.has((schema.fields[field] as FieldDef).type)) {
        arrayForms[field] = spec.array;
      }
    }
    this.selected = live.map((field) => ({ field, expr: exprs[field] as SQL }));
    this.notFilterable = notFilterable;
    this.computedFields = computed;
    this.filterSchema = withUnknown(schema, notFilterable);
    this.sortSchema = withUnknown(schema, notSortable);
    this.resolver = columnResolver({
      fields: exprs,
      arrayForms,
      id: identifier(opts.idColumn ?? "id", "id column"),
      idType: opts.idType ?? "uuid",
    });
    this.capabilities = {
      mutate: false,
      subscribe: false,
      total_count: this.totalCount,
      schema_edit: false,
      config_edit: false,
      reindex: false,
      tree_reparent: false,
      source_yaml: false,
      paging: ["cursor", "offset"],
      supported_filter_ops: ALL_FILTER_OPS,
    };
  }

  async describe(_sctx?: SourceContext): Promise<SchemaDoc> {
    return this.schema;
  }

  async list(req: SourceListRequest, sctx?: SourceContext): Promise<ListResponse> {
    // Everything that can be refused is refused before any query runs.
    assertQueryFields(this.filterSchema, req.filter, undefined);
    assertQueryFields(this.sortSchema, undefined, req.sort);
    const r = this.resolver;
    // The client filter against what a client may filter by; the host's row scope against the whole schema.
    const where = sql`${this.baseWhere} AND ${this.scopeSql(sctx)} AND ${compileFilter(
      req.filter,
      this.filterSchema,
      r,
    )}`;
    const terms = compileSort(req.sort, this.sortSchema, r);
    const limit = req.page?.limit ?? this.pageSizeDefault;
    const cursor = req.page?.cursor;
    const offset = req.page?.offset ?? 0;
    const after = cursor != null ? decodeCursor(cursor, terms.length, r.idType) : null;
    const pageWhere = after
      ? sql`${where} AND ${cursorPredicate(terms, after.values, after.id, r)}`
      : where;
    const keyCols = terms.length > 0 ? sql`, ${sortKeyColumns(terms)}` : sql``;

    // One extra row tells whether there is a next page.
    const rowsQuery = this.db.execute<TableRow>(sql`
      SELECT ${this.columns()}${keyCols}
      FROM ${this.from}
      WHERE ${pageWhere}
      ORDER BY ${orderBy(terms, r)}
      LIMIT ${limit + 1} OFFSET ${after ? 0 : offset}`);
    const countQuery = this.totalCount
      ? this.db.execute<{ total: number }>(
          sql`SELECT count(*)::int AS total FROM ${this.from} WHERE ${where}`,
        )
      : null;
    const [rows, count] = await Promise.all([rowsQuery, countQuery]);

    const page = rows.rows.slice(0, limit);
    const last = page.at(-1);
    const next_cursor =
      rows.rows.length > limit && last
        ? encodeCursor([
            ...terms.map((_, i) => (last[`__k${i}`] ?? null) as CursorValue),
            last.__id,
          ])
        : null;
    const total = count ? (count.rows[0]?.total ?? 0) : null;
    return { rows: page.map((row) => this.serialize(row)), next_cursor, total };
  }

  async read(id: string, sctx?: SourceContext): Promise<Row> {
    const r = this.resolver;
    if (!isIdOfType(id, r.idType)) throw notFound(id);
    const cast = sql.raw(r.idType === "integer" ? "bigint" : r.idType);
    const res = await this.db.execute<TableRow>(sql`
      SELECT ${this.columns()}
      FROM ${this.from}
      WHERE ${r.id} = ${id}::${cast} AND ${this.baseWhere} AND ${this.scopeSql(sctx)}`);
    const row = res.rows[0];
    if (!row) throw notFound(id);
    return this.serialize(row);
  }

  mutate(_m: SourceMutation, _sctx?: SourceContext): Promise<Row> {
    return Promise.reject(this.readOnly("mutate"));
  }

  addField(_req: SourceAddField, _sctx?: SourceContext): Promise<SchemaDoc> {
    return Promise.reject(this.readOnly("schema edits"));
  }

  updateField(_req: SourceUpdateField, _sctx?: SourceContext): Promise<SchemaDoc> {
    return Promise.reject(this.readOnly("schema edits"));
  }

  softDeleteField(_field: string, _sctx?: SourceContext): Promise<SchemaDoc> {
    return Promise.reject(this.readOnly("schema edits"));
  }

  private readOnly(what: string): UdcError {
    return new UdcError("unsupported_op", `postgres_table ${this.label} does not support ${what}`);
  }

  /** The row scope of `sctx` over the whole schema (scope fields need not be client-filterable). */
  private scopeSql(sctx: SourceContext | undefined): SQL {
    return sctx?.rowScope ? compileFilter(sctx.rowScope, this.schema, this.resolver) : sql`TRUE`;
  }

  /** The id as text, the version, and each field as jsonb (so numbers, dates and arrays arrive as JSON). */
  private columns(): SQL {
    return sql.join(
      [
        sql`(${this.resolver.id})::text AS __id`,
        sql`${this.version} AS __version`,
        ...this.selected.map(
          ({ expr }, i) => sql`to_jsonb(${expr}) AS ${sql.identifier(`__f${i}`)}`,
        ),
      ],
      sql`, `,
    );
  }

  private serialize(row: TableRow): Row {
    const out: Row = { __meta: { id: row.__id, version: row.__version } };
    this.selected.forEach(({ field }, i) => {
      const v = row[`__f${i}`];
      if (v !== null && v !== undefined) out[field] = v;
      else if (this.keepNulls) out[field] = null;
    });
    return out;
  }
}

/** `schema` with `fields` soft-deleted: the allowlist refuses them as unknown. */
function withUnknown(schema: SchemaDoc, fields: readonly string[]): SchemaDoc {
  if (fields.length === 0) return schema;
  const out: Record<string, FieldDef> = { ...schema.fields };
  for (const f of fields) out[f] = { ...(out[f] as FieldDef), deleted: true };
  return { ...schema, fields: out };
}
