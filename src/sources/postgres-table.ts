import {
  type Capabilities,
  type FieldDef,
  type ListResponse,
  type Row,
  type RowProblem,
  type SchemaDoc,
  UdcError,
  validateRow,
} from "@jsudc/core";
import { type SQL, sql } from "drizzle-orm";
import type { Db, Executor } from "../db/client.js";
import { rowScopePins, withoutFields } from "../scope.js";
import { idArray, missing, tooManyRows } from "./bulk.js";
import { type CursorValue, decodeCursor, encodeCursor, isIdOfType } from "./cursor.js";
import { assertQueryFields, notFound, versionConflict, withoutMeta } from "./fields.js";
import { type OnMutateResult, type RowChange, runOnMutate } from "./on-mutate.js";
import { assertSearchable, encodeSearchCursor, searchPage, searchText } from "./search.js";
import {
  ALL_FILTER_OPS,
  DEFAULT_PAGE_SIZE,
  type MutateManyResult,
  type Source,
  type SourceAddField,
  type SourceContext,
  type SourceListRequest,
  type SourceMutateMany,
  type SourceMutation,
  type SourceUpdateField,
} from "./source.js";
import {
  codePointOrder,
  compileFilter,
  compileSort,
  cursorPredicate,
  type FieldResolver,
  idParam,
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
  /**
   * A column that is read but never written by a request (a creation time, a
   * column a trigger maintains): an insert or patch naming it is refused with
   * `validation_error`. Implied for a column of another table of a `from`.
   */
  readOnly?: boolean | undefined;
  /** `false`: refused in a filter like an unknown field and left out of `describe.filterable`. */
  filterable?: boolean | undefined;
  /** `false`: refused in a sort like an unknown field. */
  sortable?: boolean | undefined;
  /** An array field stored as a Postgres array (`text[]`, the default) or a jsonb array. */
  array?: SqlArrayForm | undefined;
}

/**
 * How a `postgres_table` source matches the search box in SQL, written by
 * the host in code. `q` is the search text as a bound parameter (never
 * spliced into the statement); `text` is the same text, for a host that
 * builds its own parameter from it (a prefix pattern, for instance).
 */
export interface PostgresTableSearch {
  /** A condition true for a row that matches: `` sql`m.tsv @@ websearch_to_tsquery('simple', ${q})` ``. */
  match(q: SQL, text: string): SQL;
  /**
   * The relevance of a row, higher first: `` sql`ts_rank(m.tsv, websearch_to_tsquery('simple', ${q}))` ``.
   * With it, a search without a `sort` comes by rank (ties by id), paged by
   * offset. Without it, a search is ordered like any list.
   */
  rank?(q: SQL, text: string): SQL;
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
  /**
   * An integer column served as `__meta.version`: written `1` on insert,
   * incremented on every update, `expected_version` checked against it.
   * Without one every row is version 1 and there is no optimistic locking
   * (an `expected_version` is accepted and not checked).
   */
  versionColumn?: string | undefined;
  /**
   * The table the rows of a `from` with joins live in (`inbox.message`):
   * insert, update and delete go there. A `from` without it is read-only. A
   * `table` source writes its table.
   */
  writeTable?: string | undefined;
  /**
   * The alias of `writeTable` inside `from` (`m`); default: the last part of
   * `writeTable`. A column qualified by it (or not qualified) is written into
   * `writeTable`; a column of any other table of the `from` is read-only.
   */
  writeAlias?: string | undefined;
  /** `true`: never written (`capabilities.mutate: false`), even with a `table`. */
  readOnly?: boolean | undefined;
  /**
   * A host's own write on every mutation, in the same transaction, after the
   * source's statement and before `COMMIT`; see `OnMutateHook`.
   */
  onMutate?(ctx: unknown, change: RowChange, tx: Executor): OnMutateResult;
  /** A condition (SQL, from code) ANDed into every statement. */
  where?: SQL | string | undefined;
  /**
   * The search box answered by this source (`capabilities.search: "source"`):
   * the text of a `list` with `search` is matched by `search.match`, ANDed
   * with the base `where`, the row scope and the client's filter, and ranked
   * by `search.rank` when there is no `sort`. Without it, the client composes
   * `contains` as before.
   */
  search?: PostgresTableSearch | undefined;
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

/** A row read back after a write, with whether it is inside the row scope and the base `where`. */
interface CheckedRow extends TableRow {
  __in_scope: boolean;
}

/** Where and what a writable source writes: unqualified identifiers of `writeTable`. */
interface WritePlan {
  table: SQL;
  id: SQL;
  version: SQL | null;
  /** Writable field → its column. */
  columns: ReadonlyMap<string, SQL>;
  /** Fields whose value goes to the column as JSON text (`json`, an array stored as jsonb). */
  json: ReadonlySet<string>;
}

/** The parts of `a.b` (`[qualifier, column]`) or `b` (`[undefined, column]`). */
function splitColumn(name: string): [string | undefined, string] {
  const parts = name.split(".");
  return parts.length === 2 ? [parts[0], parts[1] as string] : [undefined, name];
}

/**
 * A collection served from an ordinary relational table (or a `FROM` with
 * joins) with typed columns: the filter operators, sort, keyset cursor and
 * offset paging of `postgres_jsonb`, through the same compiler with a column
 * resolver. It writes the plain columns of its `table` (or `writeTable`):
 * insert, partial update and delete, with the version column checked inside
 * the statement and the row scope in its `WHERE`; computed and read-only
 * fields are refused. Every write runs in a transaction, where a host's
 * `onMutate` takes part. The schema is the collection's `schema.json`.
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
  /** Every field a request may not write: computed, `readOnly`, or a column of another table of a `from`. */
  readonly readOnlyFields: readonly string[];

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
  /** Present when the source writes. */
  private readonly writes: WritePlan | null;
  /** The schema an insert or patch is validated against: the read-only fields are not in it. */
  private readonly writeSchema: SchemaDoc;
  private readonly onMutate: PostgresTableSourceOptions["onMutate"];
  private readonly search: PostgresTableSearch | undefined;

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
    const readOnly: string[] = [];
    const columnOf: Record<string, string> = {};
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
      if (spec.sql !== undefined || spec.computed || spec.readOnly) readOnly.push(field);
      else columnOf[field] = spec.column ?? field;
      if (spec.filterable === false) notFilterable.push(field);
      if (spec.sortable === false) notSortable.push(field);
      if (spec.array && ARRAY_TYPES.has((schema.fields[field] as FieldDef).type)) {
        arrayForms[field] = spec.array;
      }
    }
    this.selected = live.map((field) => ({ field, expr: exprs[field] as SQL }));
    this.notFilterable = notFilterable;
    this.computedFields = computed;
    this.onMutate = opts.onMutate;
    this.search = opts.search;
    this.writes = opts.readOnly ? null : writePlan(opts, schema, columnOf, readOnly, arrayForms);
    this.readOnlyFields = readOnly;
    this.writeSchema = withoutFields(schema, new Set(readOnly));
    this.filterSchema = withUnknown(schema, notFilterable);
    this.sortSchema = withUnknown(schema, notSortable);
    this.resolver = columnResolver({
      fields: exprs,
      arrayForms,
      id: identifier(opts.idColumn ?? "id", "id column"),
      idType: opts.idType ?? "uuid",
    });
    this.capabilities = {
      mutate: this.writes !== null,
      mutate_many: this.writes !== null,
      subscribe: false,
      total_count: this.totalCount,
      schema_edit: false,
      config_edit: false,
      reindex: false,
      tree_reparent: false,
      source_yaml: false,
      paging: ["cursor", "offset"],
      ...(this.search ? { search: "source" as const } : {}),
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
    const text = searchText(req.search);
    if (text !== undefined && !this.search) {
      assertSearchable(this.capabilities, this.label, text);
    }
    const q = sql`${text}`;
    const match = text !== undefined && this.search ? this.search.match(q, text) : sql`TRUE`;
    // The client filter against what a client may filter by; the host's row scope against the whole schema.
    const where = sql`${this.baseWhere} AND ${this.scopeSql(sctx)} AND ${compileFilter(
      req.filter,
      this.filterSchema,
      r,
    )} AND (${match})`;
    if (text !== undefined && this.search?.rank && !req.sort?.length) {
      return this.listByRank(where, this.search.rank(q, text), req);
    }
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

  /** One page of a search in relevance order (ties by id), by offset or the cursor of the previous page. */
  private async listByRank(where: SQL, rank: SQL, req: SourceListRequest): Promise<ListResponse> {
    const { limit, offset } = searchPage(req, this.pageSizeDefault);
    const rowsQuery = this.db.execute<TableRow>(sql`
      SELECT ${this.columns()}
      FROM ${this.from}
      WHERE ${where}
      ORDER BY (${rank}) DESC NULLS LAST, ${this.resolver.id} ASC
      LIMIT ${limit + 1} OFFSET ${offset}`);
    const countQuery = this.totalCount
      ? this.db.execute<{ total: number }>(
          sql`SELECT count(*)::int AS total FROM ${this.from} WHERE ${where}`,
        )
      : null;
    const [rows, count] = await Promise.all([rowsQuery, countQuery]);
    const page = rows.rows.slice(0, limit);
    return {
      rows: page.map((row) => this.serialize(row)),
      next_cursor: rows.rows.length > limit ? encodeSearchCursor(offset + limit) : null,
      total: count ? (count.rows[0]?.total ?? 0) : null,
    };
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

  /**
   * One transaction: insert, or lock the row, read it as it is (in scope),
   * check the version, write; read the row back through the `from` (still in
   * scope), then run `onMutate`. A failure anywhere rolls all of it back.
   */
  async mutate(m: SourceMutation, sctx?: SourceContext): Promise<Row> {
    const w = this.writes;
    if (!w) throw this.readOnly("mutate");
    const pins = rowScopePins(sctx?.rowScope);
    if (m.op === "insert") {
      const row = this.writable({ ...withoutMeta(m.row ?? {}), ...pins }, pins, "insert");
      return this.db.transaction(async (tx) => {
        const cols = Object.keys(row);
        const names = [
          ...cols.map((f) => w.columns.get(f) as SQL),
          ...(w.version ? [w.version] : []),
        ];
        const values = [...cols.map((f) => this.value(f, row[f])), ...(w.version ? [sql`1`] : [])];
        const res = await tx.execute<{ __id: string }>(
          names.length === 0
            ? sql`INSERT INTO ${w.table} DEFAULT VALUES RETURNING (${w.id})::text AS __id`
            : sql`INSERT INTO ${w.table} (${sql.join(names, sql`, `)})
                VALUES (${sql.join(values, sql`, `)}) RETURNING (${w.id})::text AS __id`,
        );
        const id = (res.rows[0] as { __id: string }).__id;
        const after = await this.readBack(tx, id, sctx);
        return this.finish(tx, sctx, { op: "insert", id, before: null, after, patch: row });
      });
    }

    if (m.id === undefined) throw new UdcError("validation_error", `${m.op} needs an id`);
    const id = m.id;
    const patch =
      m.op === "update"
        ? this.writable(pinned(withoutMeta(m.row ?? {}), pins), pins, "patch")
        : null;
    if (!isIdOfType(id, this.resolver.idType)) throw notFound(id);
    const idValue = idParam(id, this.resolver.idType);

    return this.db.transaction(async (tx) => {
      // Lock the row first: the version read below cannot change until COMMIT,
      // and the row stays locked while `onMutate` runs.
      const locked = await tx.execute(
        sql`SELECT 1 FROM ${w.table} WHERE ${w.id} = ${idValue} FOR UPDATE`,
      );
      if (locked.rows.length === 0) throw notFound(id);
      // Outside the scope (or the base `where`) the row does not exist for this request.
      const found = await tx.execute<TableRow>(sql`
        SELECT ${this.columns()} FROM ${this.from}
        WHERE ${this.resolver.id} = ${idValue} AND ${this.baseWhere} AND ${this.scopeSql(sctx)}`);
      const current = found.rows[0];
      if (!current) throw notFound(id);
      const before = this.serialize(current);
      const expected = w.version ? m.expected_version : undefined;
      if (expected !== undefined && current.__version !== expected) {
        throw versionConflict(id, expected, current.__version);
      }
      const versionCheck =
        expected === undefined || !w.version ? sql`` : sql` AND ${w.version} = ${expected}`;

      if (m.op === "delete") {
        await tx.execute(sql`DELETE FROM ${w.table} WHERE ${w.id} = ${idValue}${versionCheck}`);
        return this.finish(tx, sctx, { op: "delete", id, before, after: null, patch: null });
      }
      const fields = Object.keys(patch ?? {});
      const set = [
        ...fields.map((f) => sql`${w.columns.get(f) as SQL} = ${this.value(f, patch?.[f])}`),
        ...(w.version ? [sql`${w.version} = ${w.version} + 1`] : []),
      ];
      if (set.length > 0) {
        await tx.execute(sql`
          UPDATE ${w.table} SET ${sql.join(set, sql`, `)}
          WHERE ${w.id} = ${idValue}${versionCheck}`);
      }
      const after = await this.readBack(tx, id, sctx);
      return this.finish(tx, sctx, { op: "update", id, before, after, patch: patch ?? {} });
    });
  }

  /**
   * `mutate_many` in one transaction. The patch (read-only fields refused, as
   * in `mutate`) and the filter are checked first. The target rows — the ids,
   * or the filter minus `except_ids`, inside the base `where` and the row
   * scope, at most `limit + 1` so a filter reaching more is refused before
   * anything is written — are locked in the write table in id order and
   * checked in scope again. Without `onMutate` one `UPDATE` / `DELETE` of the
   * write table writes them all, the version column bumped, and the rows are
   * read back through the `from` to check they are still in scope. With it,
   * row by row, the hook called for each; a hook failure, like a row leaving
   * the scope, rolls the whole request back.
   */
  async mutateMany(req: SourceMutateMany, sctx?: SourceContext): Promise<MutateManyResult> {
    const w = this.writes;
    if (!w) throw this.readOnly("mutate_many");
    const pins = rowScopePins(sctx?.rowScope);
    const patch =
      req.op === "update"
        ? this.writable(pinned(withoutMeta(req.row ?? {}), pins), pins, "patch")
        : null;
    assertQueryFields(this.filterSchema, req.filter, undefined);
    const r = this.resolver;
    const inScope = sql`${this.baseWhere} AND ${this.scopeSql(sctx)}`;
    const requested = req.ids ?? [];
    let target: SQL;
    if (req.ids) {
      const ids = req.ids.filter((id) => isIdOfType(id, r.idType));
      if (ids.length === 0) return { updated: 0, failed: missing(requested, new Set()) };
      target = sql`${r.id} = ANY(${idArray(ids, r.idType)})`;
    } else {
      const except = (req.except_ids ?? []).filter((id) => isIdOfType(id, r.idType));
      const filter = compileFilter(req.filter, this.filterSchema, r);
      target =
        except.length === 0
          ? filter
          : sql`${filter} AND NOT (${r.id} = ANY(${idArray(except, r.idType)}))`;
    }
    const collection = sctx?.collection ?? this.label;

    return this.db.transaction(async (tx) => {
      const matched = await tx.execute<{ __id: string }>(sql`
        SELECT (${r.id})::text AS __id FROM ${this.from}
        WHERE ${target} AND ${inScope}
        ORDER BY ${r.id}
        LIMIT ${req.limit + 1}`);
      if (matched.rows.length > req.limit) {
        throw tooManyRows(collection, req.limit, req.ids ? "ids" : "filter");
      }
      const candidates = matched.rows.map((row) => row.__id);
      if (candidates.length === 0) return { updated: 0, failed: missing(requested, new Set()) };
      await tx.execute(sql`
        SELECT 1 FROM ${w.table} WHERE ${w.id} = ANY(${idArray(candidates, r.idType)})
        ORDER BY ${w.id} FOR UPDATE`);
      // Locked: what is in scope now stays so until COMMIT.
      const current = await tx.execute<TableRow>(sql`
        SELECT ${this.columns()} FROM ${this.from}
        WHERE ${r.id} = ANY(${idArray(candidates, r.idType)}) AND ${inScope}
        ORDER BY ${r.id}`);
      const found = current.rows.map((row) => row.__id);
      const failed = req.ids ? missing(requested, new Set(found)) : [];
      if (found.length === 0) return { updated: 0, failed };
      const set = patch
        ? [
            ...Object.keys(patch).map(
              (f) => sql`${w.columns.get(f) as SQL} = ${this.value(f, patch[f])}`,
            ),
            ...(w.version ? [sql`${w.version} = ${w.version} + 1`] : []),
          ]
        : [];

      const hook = this.onMutate;
      const report = sctx?.changedRows;
      const before = report ? current.rows.map((row) => this.serialize(row)) : [];
      if (!hook) {
        const these = idArray(found, r.idType);
        if (req.op === "delete") {
          const res = await tx.execute(sql`DELETE FROM ${w.table} WHERE ${w.id} = ANY(${these})`);
          report?.(before);
          return { updated: res.rowCount ?? 0, failed };
        }
        if (set.length > 0) {
          await tx.execute(
            sql`UPDATE ${w.table} SET ${sql.join(set, sql`, `)} WHERE ${w.id} = ANY(${these})`,
          );
        }
        const back = await tx.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM ${this.from}
          WHERE ${r.id} = ANY(${these}) AND ${inScope}`);
        if ((back.rows[0]?.n ?? 0) !== found.length) {
          throw new UdcError(
            "forbidden",
            `the row would fall outside the row scope of ${collection}`,
            {
              collection,
              reason: "out_of_scope",
            },
          );
        }
        if (report) {
          const after = await tx.execute<TableRow>(sql`
            SELECT ${this.columns()} FROM ${this.from} WHERE ${r.id} = ANY(${these})`);
          report([...before, ...after.rows.map((row) => this.serialize(row))]);
        }
        return { updated: found.length, failed };
      }

      const written: Row[] = [];
      for (const row of current.rows) {
        const id = row.__id;
        const prior = this.serialize(row);
        const idValue = idParam(id, r.idType);
        if (req.op === "delete") {
          await tx.execute(sql`DELETE FROM ${w.table} WHERE ${w.id} = ${idValue}`);
          await this.finish(tx, sctx, {
            op: "delete",
            id,
            before: prior,
            after: null,
            patch: null,
          });
          continue;
        }
        if (set.length > 0) {
          await tx.execute(
            sql`UPDATE ${w.table} SET ${sql.join(set, sql`, `)} WHERE ${w.id} = ${idValue}`,
          );
        }
        const after = await this.readBack(tx, id, sctx);
        written.push(after);
        await this.finish(tx, sctx, {
          op: "update",
          id,
          before: prior,
          after,
          patch: patch ?? {},
        });
      }
      report?.([...current.rows.map((row) => this.serialize(row)), ...written]);
      return { updated: found.length, failed };
    });
  }

  /**
   * The fields of an insert or patch, checked: a read-only field is refused
   * by name, the rest validated against the schema. A pinned scope value on a
   * read-only field is left to the scope check of the written row.
   */
  private writable(
    row: Record<string, unknown>,
    pins: Record<string, unknown>,
    mode: "insert" | "patch",
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const problems: RowProblem[] = [];
    for (const [field, value] of Object.entries(row)) {
      if (!this.readOnlyFields.includes(field)) out[field] = value;
      else if (!(Object.hasOwn(pins, field) && pins[field] === value)) {
        problems.push({ field, message: "is read-only" });
      }
    }
    problems.push(...validateRow(this.writeSchema, out, { mode }));
    if (problems.length > 0) {
      const summary = problems.map((p) => `${p.field} ${p.message}`).join("; ");
      throw new UdcError("validation_error", `invalid row: ${summary}`, { problems });
    }
    return out;
  }

  /** A field's value as a statement parameter, typed by the column it goes to. */
  private value(field: string, v: unknown): SQL {
    if (v === null || v === undefined) return sql`NULL`;
    return sql`${sql.param(this.writes?.json.has(field) ? JSON.stringify(v) : v)}`;
  }

  /** The row as written, read through the `from`; `forbidden` when it left the row scope. */
  private async readBack(tx: Executor, id: string, sctx: SourceContext | undefined): Promise<Row> {
    const res = await tx.execute<CheckedRow>(sql`
      SELECT ${this.columns()}, (${this.baseWhere} AND ${this.scopeSql(sctx)}) AS __in_scope
      FROM ${this.from}
      WHERE ${this.resolver.id} = ${idParam(id, this.resolver.idType)}`);
    const row = res.rows[0];
    if (!row?.__in_scope) {
      const collection = sctx?.collection ?? this.label;
      throw new UdcError("forbidden", `the row would fall outside the row scope of ${collection}`, {
        collection,
        reason: "out_of_scope",
      });
    }
    return this.serialize(row);
  }

  /** Run `onMutate` (when given) on the change; answer the row the caller receives. */
  private finish(
    tx: Executor,
    sctx: SourceContext | undefined,
    change: Omit<RowChange, "collection">,
  ): Promise<Row> {
    const full: RowChange = { ...change, collection: sctx?.collection ?? this.label };
    const hook = this.onMutate;
    if (!hook) return Promise.resolve((full.after ?? full.before) as Row);
    return runOnMutate(hook, sctx, full, tx);
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

/** A patch with the row scope's pinned values written over the fields it names. */
function pinned(
  patch: Record<string, unknown>,
  pins: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...patch };
  for (const [field, value] of Object.entries(pins)) {
    if (Object.hasOwn(out, field)) out[field] = value;
  }
  return out;
}

/**
 * What a source writes, or `null` when it is read-only (a `from` without a
 * `writeTable`). A field whose column is qualified by another table of the
 * `from` joins `readOnly`. The id and version columns must be columns of the
 * write table.
 */
function writePlan(
  opts: PostgresTableSourceOptions,
  schema: SchemaDoc,
  columnOf: Record<string, string>,
  readOnly: string[],
  arrayForms: Record<string, SqlArrayForm>,
): WritePlan | null {
  if (opts.table !== undefined && opts.writeTable !== undefined) {
    throw new Error(
      "PostgresTableSource: writeTable goes with from; a table source writes its table",
    );
  }
  const target = opts.table ?? opts.writeTable;
  if (target === undefined) return null;
  const alias = opts.writeAlias ?? target.split(".").at(-1);
  /** The unqualified column, or `null` when it belongs to another table. */
  const own = (name: string): string | null => {
    const [q, col] = splitColumn(name);
    return q === undefined || q === alias ? col : null;
  };
  const ownOrThrow = (name: string, what: string): SQL => {
    const col = own(name);
    if (col === null)
      throw new Error(`PostgresTableSource: ${what} ${name} is not a column of ${target}`);
    return identifier(col, what);
  };
  const columns = new Map<string, SQL>();
  const json = new Set<string>();
  for (const [field, name] of Object.entries(columnOf)) {
    const col = own(name);
    if (col === null) {
      readOnly.push(field);
      continue;
    }
    columns.set(field, identifier(col, `column of ${field}`));
    const type = (schema.fields[field] as FieldDef).type;
    if (type === "json" || arrayForms[field] === "jsonb") json.add(field);
  }
  return {
    table: identifier(target, "write table"),
    id: ownOrThrow(opts.idColumn ?? "id", "id column"),
    version:
      opts.versionColumn === undefined ? null : ownOrThrow(opts.versionColumn, "version column"),
    columns,
    json,
  };
}

/** `schema` with `fields` soft-deleted: the allowlist refuses them as unknown. */
function withUnknown(schema: SchemaDoc, fields: readonly string[]): SchemaDoc {
  if (fields.length === 0) return schema;
  const out: Record<string, FieldDef> = { ...schema.fields };
  for (const f of fields) out[f] = { ...(out[f] as FieldDef), deleted: true };
  return { ...schema, fields: out };
}
