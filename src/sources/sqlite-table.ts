import { randomUUID } from "node:crypto";
import {
  type Capabilities,
  type FieldDef,
  type ListResponse,
  ORDER_GAP,
  type Row,
  type RowProblem,
  type SchemaDoc,
  type SortKey,
  UdcError,
  validateRow,
} from "@jsudc/core";
import { type SQL, sql } from "drizzle-orm";
import { rowScopePins, withoutFields } from "../scope.js";
import type { SqliteDatabase, SqliteExecutor } from "../sqlite-database.js";
import { missing, tooManyRows } from "./bulk.js";
import { type CursorValue, decodeCursor, encodeCursor, isIdOfType, isUuid } from "./cursor.js";
import {
  assertQueryFields,
  notFound,
  reindexPlan,
  versionConflict,
  withoutMeta,
} from "./fields.js";
import { type OnMutateResult, type RowChange, runOnMutate } from "./on-mutate.js";
import { assertSearchable, encodeSearchCursor, searchPage, searchText } from "./search.js";
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
  type SourceUpdateField,
} from "./source.js";
import {
  compileFilter,
  compileSort,
  cursorPredicate,
  type FieldResolver,
  idParam,
  orderBy,
  type SqlIdType,
  sortKeyColumns,
} from "./sql.js";
import { reindexColumn, reindexUpdate } from "./sql-reindex.js";
import { sqliteColumnResolver, sqliteDateTime, sqliteDialect } from "./sqlite-sql.js";

/** One field of a `sqlite_table` collection, when it is more than a column of its own name. */
export interface SqliteTableFieldSpec {
  /** The column. */
  column?: string | undefined;
  /**
   * An SQL expression given by the host in code (never from a request): a
   * count over a link table, a correlated subquery. Filterable and sortable
   * when it has one scalar value per row. Implies `computed`.
   */
  sql?: SQL | string | undefined;
  /** Computed: read, never written (the write side refuses it). Implied by `sql`. */
  computed?: boolean | undefined;
  /**
   * A column that is read but never written by a request (a creation time, a
   * column a trigger maintains): an insert or patch naming it is refused with
   * `validation_error`.
   */
  readOnly?: boolean | undefined;
  /** `false`: refused in a filter like an unknown field and left out of `describe.filterable`. */
  filterable?: boolean | undefined;
  /** `false`: refused in a sort like an unknown field and left out of `describe.sortable`. */
  sortable?: boolean | undefined;
}

/**
 * How a `sqlite_table` source matches the search box in SQL, written by the
 * host in code: the counterpart of `PostgresTableSearch`. `q` is the search
 * text as a bound parameter (never spliced into the statement); `text` is the
 * same text, for a host that binds a parameter of its own made from it — an
 * FTS5 `MATCH` expression, as `fts5MatchExpression` builds. `sqliteFts5Search`
 * returns both functions for an FTS5 table kept by `sqliteFts5Sql`'s triggers.
 */
export interface SqliteTableSearch {
  /** A condition true for a row that matches: `` sql`rowid IN (SELECT rowid FROM note_fts WHERE note_fts MATCH ${expr})` ``. */
  match(q: SQL, text: string): SQL;
  /**
   * The relevance of a row, higher first: `` sql`-bm25(…)` `` in a correlated
   * subquery. With it, a search without a `sort` comes by rank (ties by id),
   * paged by offset. Without it, a search is ordered like any list.
   */
  rank?(q: SQL, text: string): SQL;
}

export interface SqliteTableSourceOptions {
  /** The database file's shared object; every statement goes through it. */
  db: SqliteDatabase;
  /** The collection's `schema.json`; there are no revisions. */
  schema: SchemaDoc;
  /** The table (`note`, or `aux.note` in an attached database). */
  table: string;
  /** Field → column name, or a `SqliteTableFieldSpec`. A field without an entry reads the column of its own name. */
  fields?: Readonly<Record<string, string | SqliteTableFieldSpec>> | undefined;
  /** The row id column (`id`). */
  idColumn?: string | undefined;
  /**
   * `uuid` (default: a TEXT column holding the canonical lower-case
   * 36-character form, assigned with `crypto.randomUUID()` on insert), `text`,
   * or `integer` (an `INTEGER PRIMARY KEY`, assigned by SQLite).
   */
  idType?: SqlIdType | undefined;
  /**
   * An INTEGER column served as `__meta.version`: written `1` on insert,
   * incremented by every update the source makes, `expected_version` checked
   * inside the `UPDATE` / `DELETE` statement. For writers other than this
   * source, install the trigger of `sqliteVersionTriggerSql`. Without one
   * every row is version 1 and there is no optimistic locking.
   */
  versionColumn?: string | undefined;
  /** `true`: never written (`capabilities.mutate: false`). */
  readOnly?: boolean | undefined;
  /**
   * A host's own write on every mutation, in the same transaction, after the
   * source's statement and before `COMMIT`; see `SqliteOnMutateHook`.
   */
  onMutate?(ctx: unknown, change: RowChange, tx: SqliteExecutor): OnMutateResult;
  /** A condition (SQL, from code) ANDed into every statement. */
  where?: SQL | string | undefined;
  /**
   * The search box answered by this source (`capabilities.search: "source"`):
   * the text of a `list` with `search` is matched by `search.match`, ANDed
   * with the base `where`, the row scope and the client's filter, and ranked
   * by `search.rank` when there is no `sort`. Without it a `search` is
   * refused (`unsupported_op`) and the client composes `contains`.
   */
  search?: SqliteTableSearch | undefined;
  /** `false`: no `count(*)` next to the page; `total` is `null`. Default `true`. */
  totalCount?: boolean | undefined;
  /** `true`: a NULL column is served as `null`; by default it is left out of the row. */
  keepNulls?: boolean | undefined;
  pageSizeDefault?: number | undefined;
  /**
   * The order of a `list` that asks for none (an absent or empty `sort`):
   * `[{ field: "received_at", dir: "desc" }]`. A ranked search without a sort
   * still comes by rank. The fields must be sortable; the constructor refuses
   * others. Default: the id alone.
   */
  defaultSort?: readonly SortKey[] | undefined;
}

/**
 * A host's own write, hung on every mutation of a `sqlite_table` source
 * (`mutate`, and each row of `mutate_many`). It runs inside the source's
 * transaction, after the source's statement and before `COMMIT`: the
 * database has accepted the change (constraints, the version check, the row
 * scope). `tx` runs statements on the write connection, in that transaction;
 * so does anything the hook awaits through the same `SqliteDatabase` (its
 * `run`, `transaction` — a `SAVEPOINT` — or `proxy`). Throwing rolls
 * everything back: a `UdcError` is answered as it is, anything else as
 * `internal` (and logged). A returned row is what the caller receives; the
 * source does not write it.
 *
 * The hook may be async, but the file has one writer: while it awaits, the
 * write queue and the file's write lock are held, so every other writer of
 * the file — in this process and in others — waits (and is answered `busy`
 * after `busyTimeoutMs`). Keep it short; do slow work after the response.
 */
export type SqliteOnMutateHook<Ctx = unknown> = (
  ctx: Ctx,
  change: RowChange,
  tx: SqliteExecutor,
) => OnMutateResult;

const IDENT_PART = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

/** `note` or `aux.note` as quoted identifiers; anything else is refused. */
export function identifier(name: string, what: string): SQL {
  const parts = name.split(".");
  if (parts.length > 2 || !parts.every((p) => IDENT_PART.test(p))) {
    throw new Error(`invalid ${what} ${JSON.stringify(name)}: a name or schema.name`);
  }
  return sql.join(
    parts.map((p) => sql.identifier(p)),
    sql`.`,
  );
}

/** A bare column name (no schema qualifier): what the version trigger and a write name. */
export function columnName(name: string, what: string): string {
  if (!IDENT_PART.test(name)) throw new Error(`invalid ${what} ${JSON.stringify(name)}`);
  return name;
}

/** A bare, already checked column name as a quoted identifier. */
const col = (name: string): SQL => sql`${sql.identifier(name)}`;

const raw = (s: SQL | string): SQL => (typeof s === "string" ? sql.raw(s) : s);

interface TableRow extends Record<string, unknown> {
  __id: string;
  __version: number;
}

interface CheckedRow extends TableRow {
  __in_scope: number | null;
}

/** How a field's value is stored and served. */
type Storage = "bool" | "datetime" | "json" | "plain";

function storageOf(def: FieldDef): Storage {
  switch (def.type) {
    case "bool":
      return "bool";
    case "datetime":
      return "datetime";
    case "string_array":
    case "lookup_array":
    case "json":
      return "json";
    default:
      return "plain";
  }
}

/** `2021-06-01 10:00:00` (SQLite's own `datetime()` text) read as ISO too. */
const SPACE_DATETIME = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/;

/** A stored value as the wire protocol carries it. */
function served(v: unknown, storage: Storage): unknown {
  switch (storage) {
    case "bool":
      if (typeof v === "number" || typeof v === "bigint") return Number(v) !== 0;
      if (v === "true" || v === "1") return true;
      if (v === "false" || v === "0") return false;
      return v;
    case "datetime":
      return typeof v === "string" ? sqliteDateTime(v.replace(SPACE_DATETIME, "$1T$2")) : v;
    case "json":
      if (typeof v !== "string") return v;
      try {
        return JSON.parse(v);
      } catch {
        return v;
      }
    default:
      return typeof v === "bigint" ? Number(v) : v;
  }
}

/** A written value as SQLite stores it. */
function stored(v: unknown, storage: Storage): unknown {
  if (v === null || v === undefined) return null;
  switch (storage) {
    case "bool":
      return v ? 1 : 0;
    case "datetime":
      return typeof v === "string" ? sqliteDateTime(v) : v;
    case "json":
      return JSON.stringify(v);
    default:
      return typeof v === "object" ? JSON.stringify(v) : v;
  }
}

/** Where and what a writable source writes. */
interface WritePlan {
  table: SQL;
  id: SQL;
  /** The id column's bare name (a field mapped to it carries the id of an insert). */
  idName: string;
  version: SQL | null;
  /** Writable field → its column's bare name. */
  columns: ReadonlyMap<string, string>;
}

/**
 * The trigger that bumps `versionColumn` for a writer that does not (a
 * customer's tool, the `sqlite3` shell): after an `UPDATE` that left the
 * version as it was, it adds 1. `SqliteTableSource` bumps the version in its
 * own `UPDATE`, so the trigger stays quiet for it — no double bump. That is
 * the one supported arrangement: the source bumps, the trigger covers
 * everyone else. A writer that sets the version itself (to anything but the
 * old value) is left alone. Needs a rowid table (not `WITHOUT ROWID`) and
 * `recursive_triggers` off (SQLite's default; the `WHEN` also stops a
 * recursion). Run the text once, e.g. in a migration.
 */
export function sqliteVersionTriggerSql(opts: {
  table: string;
  versionColumn: string;
  /** Default `<table>_<versionColumn>_bump`. */
  name?: string | undefined;
}): string {
  const table = columnName(opts.table, "table");
  const col = columnName(opts.versionColumn, "version column");
  const name = columnName(opts.name ?? `${table}_${col}_bump`, "trigger name");
  return [
    `CREATE TRIGGER IF NOT EXISTS "${name}" AFTER UPDATE ON "${table}"`,
    `FOR EACH ROW WHEN NEW."${col}" IS OLD."${col}"`,
    "BEGIN",
    `  UPDATE "${table}" SET "${col}" = coalesce(OLD."${col}", 0) + 1 WHERE rowid = NEW.rowid;`,
    "END;",
  ].join("\n");
}

/**
 * A collection served from one table of a SQLite database file, with typed
 * columns: the filter operators, sort, keyset cursor and offset paging of
 * `postgres_table`, through the same compiler with the SQLite dialect. It
 * writes the plain columns of its table: insert, partial update and delete,
 * and `mutate_many`, each in a `BEGIN IMMEDIATE` transaction of the shared
 * `SqliteDatabase`, with the row scope and the version check in the `WHERE`
 * of the statement; computed and read-only fields are refused. A host's
 * `onMutate` takes part in every write. The schema is the collection's
 * `schema.json`.
 *
 * The storage per field type is `sqliteColumnResolver`'s (INTEGER, NUMERIC,
 * 0/1, `YYYY-MM-DD`, UTC ISO datetime text, JSON text); rows are served as
 * the wire protocol's JSON types. Nothing about rows is cached: other
 * processes may write the file.
 */
export class SqliteTableSource implements Source {
  readonly kind = "sqlite_table";
  /** The row scope sits in the WHERE of every statement. */
  readonly enforcesRowScope = true;
  readonly capabilities: Capabilities;
  readonly notFilterable: readonly string[];
  readonly notSortable: readonly string[];
  readonly computedFields: readonly string[];
  readonly readOnlyFields: readonly string[];

  private readonly db: SqliteDatabase;
  private readonly schema: SchemaDoc;
  private readonly filterSchema: SchemaDoc;
  private readonly sortSchema: SchemaDoc;
  private readonly resolver: FieldResolver;
  private readonly from: SQL;
  private readonly baseWhere: SQL;
  private readonly search: SqliteTableSearch | undefined;
  private readonly version: SQL;
  private readonly selected: { field: string; expr: SQL; storage: Storage }[];
  private readonly storage: Readonly<Record<string, Storage>>;
  private readonly totalCount: boolean;
  private readonly keepNulls: boolean;
  private readonly pageSizeDefault: number;
  private readonly label: string;
  private readonly writes: WritePlan | null;
  private readonly writeSchema: SchemaDoc;
  private readonly defaultSort: SortKey[] | undefined;
  private readonly onMutate: SqliteTableSourceOptions["onMutate"];

  /**
   * Commits other connections made to the database file, as the
   * `SqliteDatabase` notices them (only with its `watch` option).
   */
  onExternalWrite(listener: () => void): () => void {
    return this.db.onExternalWrite(listener);
  }

  constructor(opts: SqliteTableSourceOptions) {
    const schema = opts.schema;
    const given = opts.fields ?? {};
    for (const field of Object.keys(given)) {
      const def = schema.fields[field];
      if (!def || def.deleted) {
        throw new Error(`SqliteTableSource: ${field} is not a field of the schema`);
      }
    }
    this.db = opts.db;
    this.schema = schema;
    this.label = opts.table;
    this.from = identifier(opts.table, "table");
    this.baseWhere = opts.where === undefined ? sql`1` : sql`(${raw(opts.where)})`;
    this.search = opts.search;
    const versionName =
      opts.versionColumn === undefined
        ? undefined
        : columnName(opts.versionColumn, "version column");
    this.version = versionName === undefined ? sql`1` : sql`CAST(${col(versionName)} AS INTEGER)`;
    this.totalCount = opts.totalCount ?? true;
    this.keepNulls = opts.keepNulls ?? false;
    this.pageSizeDefault = opts.pageSizeDefault ?? DEFAULT_PAGE_SIZE;

    const exprs: Record<string, SQL> = {};
    const storage: Record<string, Storage> = {};
    const notFilterable: string[] = [];
    const notSortable: string[] = [];
    const computed: string[] = [];
    const readOnly: string[] = [];
    const columns = new Map<string, string>();
    const live = schema.field_order.filter((f) => schema.fields[f] && !schema.fields[f]?.deleted);
    for (const field of live) {
      const entry = Object.hasOwn(given, field) ? given[field] : undefined;
      const spec: SqliteTableFieldSpec =
        typeof entry === "string" ? { column: entry } : (entry ?? {});
      if (spec.sql !== undefined && spec.column !== undefined) {
        throw new Error(`SqliteTableSource: ${field} has both column and sql`);
      }
      const name =
        spec.sql === undefined ? columnName(spec.column ?? field, `column of ${field}`) : "";
      exprs[field] = spec.sql !== undefined ? sql`(${raw(spec.sql)})` : col(name);
      storage[field] = storageOf(schema.fields[field] as FieldDef);
      if (spec.sql !== undefined || spec.computed) computed.push(field);
      if (spec.sql !== undefined || spec.computed || spec.readOnly) readOnly.push(field);
      else columns.set(field, name);
      if (spec.filterable === false) notFilterable.push(field);
      if (spec.sortable === false) notSortable.push(field);
    }
    this.selected = live.map((field) => ({
      field,
      expr: exprs[field] as SQL,
      storage: storage[field] as Storage,
    }));
    this.storage = storage;
    this.notFilterable = notFilterable;
    this.notSortable = notSortable;
    this.computedFields = computed;
    this.readOnlyFields = readOnly;
    const idName = columnName(opts.idColumn ?? "id", "id column");
    this.writes = opts.readOnly
      ? null
      : {
          table: this.from,
          id: col(idName),
          idName,
          version: versionName === undefined ? null : col(versionName),
          columns,
        };
    if (this.writes && versionName !== undefined) {
      for (const [field, col] of columns) {
        if (col === versionName) {
          throw new Error(
            `SqliteTableSource: ${field} writes the version column ${versionName}; make it readOnly`,
          );
        }
      }
    }
    this.onMutate = opts.onMutate;
    this.writeSchema = withoutFields(schema, new Set(readOnly));
    this.filterSchema = withUnknown(schema, notFilterable);
    this.sortSchema = withUnknown(schema, notSortable);
    if (opts.defaultSort?.length) {
      for (const { field } of opts.defaultSort) {
        const def = this.sortSchema.fields[field];
        if (!def || def.deleted) {
          throw new Error(`SqliteTableSource: defaultSort names ${field}, not a sortable field`);
        }
      }
      this.defaultSort = [...opts.defaultSort];
    }
    this.resolver = sqliteColumnResolver({
      fields: exprs,
      id: col(idName),
      idType: opts.idType ?? "uuid",
    });
    this.capabilities = {
      mutate: this.writes !== null,
      mutate_many: this.writes !== null,
      subscribe: false,
      total_count: this.totalCount,
      schema_edit: false,
      config_edit: false,
      reindex: this.writes !== null,
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
    const text = searchText(req.search);
    if (text !== undefined && !this.search) {
      assertSearchable(this.capabilities, this.label, text);
    }
    const r = this.resolver;
    const q = sql`${text}`;
    const match = text !== undefined && this.search ? this.search.match(q, text) : sql`1`;
    // The client filter against what a client may filter by; the host's row scope against the whole schema.
    const where = sql`${this.baseWhere} AND ${this.scopeSql(sctx)} AND ${compileFilter(
      req.filter,
      this.filterSchema,
      r,
    )} AND (${match})`;
    if (text !== undefined && this.search?.rank && !req.sort?.length) {
      return this.listByRank(where, this.search.rank(q, text), req);
    }
    const terms = compileSort(req.sort?.length ? req.sort : this.defaultSort, this.sortSchema, r);
    const limit = req.page?.limit ?? this.pageSizeDefault;
    const cursor = req.page?.cursor;
    const offset = req.page?.offset ?? 0;
    const after = cursor != null ? decodeCursor(cursor, terms.length, r.idType) : null;
    if (after && r.idType === "uuid") after.id = after.id.toLowerCase();
    const pageWhere = after
      ? sql`${where} AND ${cursorPredicate(terms, after.values, after.id, r)}`
      : where;
    const keyCols = terms.length > 0 ? sql`, ${sortKeyColumns(terms, r)}` : sql``;

    // The page and the count on one snapshot; one extra row tells whether there is a next page.
    const { rows, total } = await this.db.read((q) => ({
      rows: q.all<TableRow>(sql`
        SELECT ${this.columns()}${keyCols}
        FROM ${this.from}
        WHERE ${pageWhere}
        ORDER BY ${orderBy(terms, r)}
        LIMIT ${limit + 1} OFFSET ${after ? 0 : offset}`),
      total: this.totalCount
        ? (q.get<{ total: number }>(sql`SELECT count(*) AS total FROM ${this.from} WHERE ${where}`)
            ?.total ?? 0)
        : null,
    }));
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const next_cursor =
      rows.length > limit && last
        ? encodeCursor([
            ...terms.map((_, i) => (last[`__k${i}`] ?? null) as CursorValue),
            last.__id,
          ])
        : null;
    return { rows: page.map((row) => this.serialize(row)), next_cursor, total };
  }

  /**
   * One page of a search in relevance order (ties by id), by offset or the
   * cursor of the previous page. The rank is cast to REAL: a constant integer
   * in `ORDER BY` would be read as a column number.
   */
  private async listByRank(where: SQL, rank: SQL, req: SourceListRequest): Promise<ListResponse> {
    const { limit, offset } = searchPage(req, this.pageSizeDefault);
    const { rows, total } = await this.db.read((q) => ({
      rows: q.all<TableRow>(sql`
        SELECT ${this.columns()}
        FROM ${this.from}
        WHERE ${where}
        ORDER BY CAST((${rank}) AS REAL) DESC NULLS LAST, ${this.resolver.id} ASC
        LIMIT ${limit + 1} OFFSET ${offset}`),
      total: this.totalCount
        ? (q.get<{ total: number }>(sql`SELECT count(*) AS total FROM ${this.from} WHERE ${where}`)
            ?.total ?? 0)
        : null,
    }));
    return {
      rows: rows.slice(0, limit).map((row) => this.serialize(row)),
      next_cursor: rows.length > limit ? encodeSearchCursor(offset + limit) : null,
      total,
    };
  }

  async read(id: string, sctx?: SourceContext): Promise<Row> {
    const key = this.idOf(id);
    if (key === null) throw notFound(id);
    const row = await this.db.read((q) =>
      q.get<TableRow>(sql`
        SELECT ${this.columns()}
        FROM ${this.from}
        WHERE ${this.resolver.id} = ${key} AND ${this.inScope(sctx)}`),
    );
    if (!row) throw notFound(id);
    return this.serialize(row);
  }

  /**
   * One `BEGIN IMMEDIATE` transaction: insert; or read the row as it is (in
   * scope), check the version, and update / delete with the id, the version,
   * the base `where` and the row scope in the statement's `WHERE`. The row
   * written is read back in scope; a row that left it rolls everything back.
   * Then `onMutate`, before `COMMIT`; its failure rolls back too.
   */
  async mutate(m: SourceMutation, sctx?: SourceContext): Promise<Row> {
    const w = this.writes;
    if (!w) throw this.readOnly("mutate");
    const pins = rowScopePins(sctx?.rowScope);
    if (m.op === "insert") {
      const row = this.writable({ ...withoutMeta(m.row ?? {}), ...pins }, pins, "insert");
      return this.db.transaction(async (tx) => {
        const names: SQL[] = [];
        const values: SQL[] = [];
        let idAt = -1;
        for (const [field, value] of Object.entries(row)) {
          if (this.isIdField(field)) idAt = names.length;
          names.push(col(w.columns.get(field) as string));
          values.push(this.writeValue(field, value));
        }
        // A uuid id the row does not carry is assigned here (a TEXT column has no default).
        if (
          this.resolver.idType === "uuid" &&
          (idAt < 0 || row[Object.keys(row)[idAt] as string] == null)
        ) {
          if (idAt >= 0) values[idAt] = sql`${randomUUID()}`;
          else {
            names.push(w.id);
            values.push(sql`${randomUUID()}`);
          }
        }
        if (w.version) {
          names.push(w.version);
          values.push(sql`1`);
        }
        const inserted = tx.get<{ __id: string }>(
          names.length === 0
            ? sql`INSERT INTO ${w.table} DEFAULT VALUES RETURNING CAST(${w.id} AS TEXT) AS __id`
            : sql`INSERT INTO ${w.table} (${sql.join(names, sql`, `)})
                VALUES (${sql.join(values, sql`, `)}) RETURNING CAST(${w.id} AS TEXT) AS __id`,
        );
        const after = this.readBack(tx, (inserted as { __id: string }).__id, sctx);
        const id = after.__meta.id;
        return this.finish(tx, sctx, { op: "insert", id, before: null, after, patch: row });
      });
    }

    if (m.id === undefined) throw new UdcError("validation_error", `${m.op} needs an id`);
    const id = m.id;
    const patch =
      m.op === "update"
        ? this.writable(pinned(withoutMeta(m.row ?? {}), pins), pins, "patch")
        : null;
    const key = this.idOf(id);
    if (key === null) throw notFound(id);
    const keyText = this.resolver.idType === "uuid" ? id.toLowerCase() : id;

    return this.db.transaction(async (tx) => {
      // The write lock is held since BEGIN IMMEDIATE: no other writer changes the row until COMMIT.
      // Outside the scope (or the base `where`) the row does not exist for this request.
      const current = tx.get<TableRow>(sql`
        SELECT ${this.columns()} FROM ${this.from}
        WHERE ${this.resolver.id} = ${key} AND ${this.inScope(sctx)}`);
      if (!current) throw notFound(id);
      const before = this.serialize(current);
      const expected = w.version ? m.expected_version : undefined;
      if (expected !== undefined && current.__version !== expected) {
        throw versionConflict(id, expected, current.__version);
      }
      // The same checks again inside the statement itself.
      const target = sql`${w.id} = ${key} AND ${this.inScope(sctx)}${
        expected === undefined || !w.version ? sql`` : sql` AND ${w.version} = ${expected}`
      }`;

      if (m.op === "delete") {
        const res = tx.run(sql`DELETE FROM ${w.table} WHERE ${target}`);
        if (res.changes !== 1) throw this.lost(tx, id, key, expected);
        const rowId = before.__meta.id;
        return this.finish(tx, sctx, { op: "delete", id: rowId, before, after: null, patch: null });
      }
      const set = [
        ...Object.keys(patch ?? {}).map(
          (f) => sql`${col(w.columns.get(f) as string)} = ${this.writeValue(f, patch?.[f])}`,
        ),
        ...(w.version ? [sql`${w.version} = coalesce(${w.version}, 0) + 1`] : []),
      ];
      if (set.length > 0) {
        const res = tx.run(sql`UPDATE ${w.table} SET ${sql.join(set, sql`, `)} WHERE ${target}`);
        if (res.changes !== 1) throw this.lost(tx, id, key, expected);
      }
      // A patch that changes the id column moves the row: read it back under its new id.
      const moved = this.newIdIn(patch);
      const after = this.readBack(tx, moved ?? keyText, sctx);
      return this.finish(tx, sctx, {
        op: "update",
        id: after.__meta.id,
        before,
        after,
        patch: patch ?? {},
      });
    });
  }

  /**
   * `mutate_many` in one `BEGIN IMMEDIATE` transaction: the file's write lock
   * is held from the first statement to `COMMIT`, so the rows read are the
   * rows written. The patch (read-only fields refused, as in `mutate`; the id
   * column refused) and the filter are checked first. The target rows — the
   * ids, or the filter minus `except_ids`, inside the base `where` and the
   * row scope, at most `limit + 1` so a filter reaching more is refused before
   * anything is written — are read in id order. Without `onMutate` one
   * `UPDATE` / `DELETE` writes them all, the version bumped, and a count
   * checks they are all still in scope. With it, row by row, each read back in
   * scope and then handed to the hook. A row leaving the scope, or a hook
   * failure, rolls the whole request back. With `changedRows` the rows as they
   * were and as they are now are handed over, so the change feed names them.
   */
  async mutateMany(req: SourceMutateMany, sctx?: SourceContext): Promise<MutateManyResult> {
    const w = this.writes;
    if (!w) throw this.readOnly("mutate_many");
    const pins = rowScopePins(sctx?.rowScope);
    const patch =
      req.op === "update"
        ? this.writable(pinned(withoutMeta(req.row ?? {}), pins), pins, "patch")
        : null;
    for (const field of Object.keys(patch ?? {})) {
      if (this.isIdField(field)) {
        throw new UdcError(
          "validation_error",
          `invalid row: ${field} is the row id; mutate_many does not change it`,
          { problems: [{ field, message: "is the row id; mutate_many does not change it" }] },
        );
      }
    }
    assertQueryFields(this.filterSchema, req.filter, undefined);
    const r = this.resolver;
    const cast = r.idType === "integer" ? "numeric" : "text";
    const canonical = (id: string) => (r.idType === "uuid" ? id.toLowerCase() : id);
    const requested = req.ids ?? [];
    let target: SQL;
    if (req.ids) {
      const ids = req.ids.filter((id) => isIdOfType(id, r.idType)).map(canonical);
      if (ids.length === 0) return { updated: 0, failed: missing(requested, new Set()) };
      target = sqliteDialect.anyOf(r.id, ids, cast);
    } else {
      const except = (req.except_ids ?? []).filter((id) => isIdOfType(id, r.idType));
      const filter = compileFilter(req.filter, this.filterSchema, r);
      target =
        except.length === 0
          ? filter
          : sql`${filter} AND NOT (${sqliteDialect.anyOf(r.id, except.map(canonical), cast)})`;
    }
    const where = sql`(${target}) AND ${this.inScope(sctx)}`;
    const collection = sctx?.collection ?? this.label;
    const set = patch
      ? [
          ...Object.keys(patch).map(
            (f) => sql`${col(w.columns.get(f) as string)} = ${this.writeValue(f, patch[f])}`,
          ),
          ...(w.version ? [sql`${w.version} = coalesce(${w.version}, 0) + 1`] : []),
        ]
      : [];
    const hook = this.onMutate;
    const report = sctx?.changedRows;

    return this.db.transaction(async (tx) => {
      // Under the write lock since BEGIN IMMEDIATE: what is read here stays so until COMMIT.
      const current = tx.all<TableRow>(sql`
        SELECT ${this.columns()} FROM ${this.from}
        WHERE ${where}
        ORDER BY ${r.id}
        LIMIT ${req.limit + 1}`);
      if (current.length > req.limit) {
        throw tooManyRows(collection, req.limit, req.ids ? "ids" : "filter");
      }
      const found = new Set(current.map((row) => row.__id));
      const failed = req.ids
        ? missing(requested, new Set(requested.filter((id) => found.has(canonical(id)))))
        : [];
      if (current.length === 0) return { updated: 0, failed };
      const before = current.map((row) => this.serialize(row));

      if (!hook) {
        const these = sqliteDialect.anyOf(w.id, [...found], cast);
        if (req.op === "delete") {
          tx.run(sql`DELETE FROM ${w.table} WHERE ${these}`);
          report?.(before);
          return { updated: current.length, failed };
        }
        if (set.length > 0)
          tx.run(sql`UPDATE ${w.table} SET ${sql.join(set, sql`, `)} WHERE ${these}`);
        const back = tx.get<{ n: number }>(sql`
          SELECT count(*) AS n FROM ${this.from} WHERE ${these} AND ${this.inScope(sctx)}`);
        if (Number(back?.n ?? 0) !== current.length) throw this.outOfScope(sctx);
        if (report) {
          const after = tx.all<TableRow>(
            sql`SELECT ${this.columns()} FROM ${this.from} WHERE ${these}`,
          );
          report([...before, ...after.map((row) => this.serialize(row))]);
        }
        return { updated: current.length, failed };
      }

      const written: Row[] = [];
      for (const prior of before) {
        const id = prior.__meta.id;
        const key = idParam(id, r.idType, sqliteDialect);
        if (req.op === "delete") {
          tx.run(sql`DELETE FROM ${w.table} WHERE ${w.id} = ${key}`);
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
          tx.run(sql`UPDATE ${w.table} SET ${sql.join(set, sql`, `)} WHERE ${w.id} = ${key}`);
        }
        const after = this.readBack(tx, id, sctx);
        written.push(after);
        await this.finish(tx, sctx, { op: "update", id, before: prior, after, patch: patch ?? {} });
      }
      report?.([...before, ...written]);
      return { updated: current.length, failed };
    });
  }

  /** Run `onMutate` (when given) on the change; answer the row the caller receives. */
  private finish(
    tx: SqliteExecutor,
    sctx: SourceContext | undefined,
    change: Omit<RowChange, "collection">,
  ): Promise<Row> {
    const full: RowChange = { ...change, collection: sctx?.collection ?? this.label };
    const hook = this.onMutate;
    if (!hook) return Promise.resolve((full.after ?? full.before) as Row);
    return runOnMutate(hook, sctx, full, tx);
  }

  /**
   * One `BEGIN IMMEDIATE` transaction, one `UPDATE … FROM`: number the rows
   * of the request's `scope` AND the base `where` AND the row scope by their
   * current order (NULLS LAST, ties by id) and write `n * gap` back, bumping
   * each version. The order field and every scope field must be writable
   * columns of the table (`validation_error` otherwise). With `changedRows`
   * the rows as they were and as they are now are handed over, so the change
   * feed names them.
   */
  async reindex(req: SourceReindex, sctx?: SourceContext): Promise<number> {
    const w = this.writes;
    if (!w) throw this.readOnly("reindex");
    const { filter, orderField } = reindexPlan(
      this.schema,
      req.scope,
      req.order_field ?? DEFAULT_ORDER_FIELD,
    );
    const column = (field: string, what: "order_field" | "scope") =>
      reindexColumn(w.columns, field, what, (f) => this.isIdField(f), `sqlite_table ${this.label}`);
    const order = col(column(orderField, "order_field"));
    for (const field of Object.keys(req.scope)) column(field, "scope");
    const where = sql`${this.inScope(sctx)} AND ${compileFilter(filter, this.schema, this.resolver)}`;
    const report = sctx?.changedRows;

    return this.db.transaction((tx) => {
      const before = report
        ? tx.all<TableRow>(sql`SELECT ${this.columns()} FROM ${this.from} WHERE ${where}`)
        : [];
      // No joins here: the table's own columns on both sides of the statement.
      const written = tx.all<{ __id: string }>(
        reindexUpdate({
          table: w.table,
          id: w.id,
          order,
          version: w.version,
          from: this.from,
          fromId: w.id,
          fromOrder: order,
          where,
          gap: req.gap ?? ORDER_GAP,
          dialect: sqliteDialect,
        }),
      );
      if (report && written.length > 0) {
        const cast = this.resolver.idType === "integer" ? "numeric" : "text";
        const ids = written.map((r) => r.__id);
        const after = tx.all<TableRow>(sql`
          SELECT ${this.columns()} FROM ${this.from}
          WHERE ${sqliteDialect.anyOf(w.id, ids, cast)}`);
        report([...before, ...after].map((row) => this.serialize(row)));
      }
      return written.length;
    });
  }

  /**
   * Why an `UPDATE` / `DELETE` whose row was just read in scope changed
   * nothing (it cannot happen under the write lock unless the base `where`
   * or the scope is not a pure function of the row): the version, else gone.
   */
  private lost(
    tx: SqliteExecutor,
    id: string,
    key: unknown,
    expected: number | undefined,
  ): UdcError {
    const now = tx.get<{ v: number }>(
      sql`SELECT ${this.version} AS v FROM ${this.from} WHERE ${this.resolver.id} = ${key}`,
    );
    if (now && expected !== undefined && now.v !== expected) {
      return versionConflict(id, expected, now.v);
    }
    return notFound(id);
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
    for (const [field, value] of Object.entries(out)) {
      if (this.isIdField(field) && value !== null && value !== undefined) {
        if (this.resolver.idType === "uuid" && !isUuid(value)) {
          problems.push({ field, message: "is not a uuid" });
        }
      }
    }
    if (problems.length > 0) {
      const summary = problems.map((p) => `${p.field} ${p.message}`).join("; ");
      throw new UdcError("validation_error", `invalid row: ${summary}`, { problems });
    }
    return out;
  }

  /** A field's value as a statement parameter, in the column's storage. */
  private value(field: string, v: unknown): SQL {
    if (v === null || v === undefined) return sql`NULL`;
    return sql`${stored(v, this.storage[field] ?? "plain")}`;
  }

  /** The value a patch writes: an id-column field in the id's canonical form. */
  private writeValue(field: string, v: unknown): SQL {
    return this.isIdField(field) ? sql`${this.idValue(v)}` : this.value(field, v);
  }

  /** An id written into the id column: a uuid lower-cased. */
  private idValue(v: unknown): unknown {
    if (v === null || v === undefined) return null;
    return this.resolver.idType === "uuid" && typeof v === "string" ? v.toLowerCase() : v;
  }

  /** Whether `field` is written into the id column (it then carries the row's id). */
  private isIdField(field: string): boolean {
    return this.writes !== null && this.writes.columns.get(field) === this.writes.idName;
  }

  /** The new id of a patch that writes the id column, else `undefined`. */
  private newIdIn(patch: Record<string, unknown> | null): string | undefined {
    if (!patch) return undefined;
    for (const [field, v] of Object.entries(patch)) {
      if (this.isIdField(field) && v !== null && v !== undefined) return String(this.idValue(v));
    }
    return undefined;
  }

  /** A row id from a request as the statement parameter, or `null` when it cannot be an id of the table. */
  private idOf(id: string): SQL | null {
    const type = this.resolver.idType;
    if (!isIdOfType(id, type)) return null;
    return idParam(type === "uuid" ? id.toLowerCase() : id, type, sqliteDialect);
  }

  /** The row as written, read back; `forbidden` when it left the row scope (or the base `where`). */
  private readBack(tx: SqliteExecutor, id: string, sctx: SourceContext | undefined): Row {
    const key = idParam(id, this.resolver.idType, sqliteDialect);
    const row = tx.get<CheckedRow>(sql`
      SELECT ${this.columns()}, (${this.inScope(sctx)}) AS __in_scope
      FROM ${this.from}
      WHERE ${this.resolver.id} = ${key}`);
    if (!row?.__in_scope) throw this.outOfScope(sctx);
    return this.serialize(row);
  }

  /** The refusal of a write that would take a row out of the row scope (or the base `where`). */
  private outOfScope(sctx: SourceContext | undefined): UdcError {
    const collection = sctx?.collection ?? this.label;
    return new UdcError("forbidden", `the row would fall outside the row scope of ${collection}`, {
      collection,
      reason: "out_of_scope",
    });
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
    return new UdcError("unsupported_op", `sqlite_table ${this.label} does not support ${what}`);
  }

  /** The base `where` AND the row scope of `sctx`, over the whole schema. */
  private inScope(sctx: SourceContext | undefined): SQL {
    return sql`${this.baseWhere} AND ${this.scopeSql(sctx)}`;
  }

  private scopeSql(sctx: SourceContext | undefined): SQL {
    return sctx?.rowScope ? compileFilter(sctx.rowScope, this.schema, this.resolver) : sql`1`;
  }

  /** The id as text, the version, and each field as stored. */
  private columns(): SQL {
    return sql.join(
      [
        sql`CAST(${this.resolver.id} AS TEXT) AS __id`,
        sql`${this.version} AS __version`,
        ...this.selected.map(({ expr }, i) => sql`${expr} AS ${sql.identifier(`__f${i}`)}`),
      ],
      sql`, `,
    );
  }

  private serialize(row: TableRow): Row {
    const out: Row = { __meta: { id: row.__id, version: Number(row.__version ?? 1) } };
    this.selected.forEach(({ field, storage }, i) => {
      const v = row[`__f${i}`];
      if (v !== null && v !== undefined) out[field] = served(v, storage);
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

/** `schema` with `fields` soft-deleted: the allowlist refuses them as unknown. */
function withUnknown(schema: SchemaDoc, fields: readonly string[]): SchemaDoc {
  if (fields.length === 0) return schema;
  const out: Record<string, FieldDef> = { ...schema.fields };
  for (const f of fields) out[f] = { ...(out[f] as FieldDef), deleted: true };
  return { ...schema, fields: out };
}
