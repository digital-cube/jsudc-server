/**
 * The SQLite double of `src/sources/postgres-jsonb.js`: the Vitest project
 * `sqlite` aliases that module to this one, so the jsonb read suites
 * (pg-filter, pg-paging, pg-parity, pg-array, pg-allowlist) run unchanged
 * against the SQL compiler's SQLite dialect, in a `node:sqlite` `:memory:`
 * database.
 *
 * The suites keep writing their rows into the Postgres jsonb table. Before
 * every `list` this double copies those rows into a SQLite table with one
 * typed column per live field, in the storage `sqliteColumnResolver` expects
 * (INTEGER, NUMERIC, 0/1, `YYYY-MM-DD`, UTC datetime text, JSON text), and
 * answers the `list` with SQL compiled by `compileFilter` / `compileSort` /
 * `orderBy` / `cursorPredicate` / `sortKeyColumns` through that resolver and
 * rendered by `sqliteQuery`: the paging the `postgres_table` source does,
 * minus search and writes (the SQLite source is the next ticket).
 *
 * The connection registers a Unicode `lower()` (`String#toLowerCase`), as the
 * dialect's notes tell a host to: SQLite's own folds ASCII only.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { FieldDef, ListResponse, Row, SchemaDoc } from "@jsudc/core";
import { type SQL, sql } from "drizzle-orm";
import { afterAll } from "vitest";
import { connect, type Db } from "../../src/db/client.js";
import { andFilters } from "../../src/scope.js";
import { type CursorValue, decodeCursor, encodeCursor } from "../../src/sources/cursor.js";
import { assertQueryFields } from "../../src/sources/fields.js";
import {
  DEFAULT_PAGE_SIZE,
  type SourceContext,
  type SourceListRequest,
} from "../../src/sources/source.js";
import {
  compileFilter,
  compileSort,
  cursorPredicate,
  type FieldResolver,
  orderBy,
  sortKeyColumns,
} from "../../src/sources/sql.js";
import { sqliteColumnResolver, sqliteDateTime, sqliteQuery } from "../../src/sources/sqlite-sql.js";

// Not imported from ./helpers.js: helpers imports this module (through the alias).
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || "postgresql://jsudc:123@localhost/jsudc_test";

const own = connect(TEST_DATABASE_URL);
afterAll(() => own.close());

export interface PostgresJsonbSourceOptions {
  db: Db;
  table: string;
  initialSchema: SchemaDoc;
  pageSizeDefault?: number;
}

type Kind = "integer" | "numeric" | "bool" | "datetime" | "json" | "text";

function kindOf(def: FieldDef): Kind {
  switch (def.type) {
    case "integer":
    case "year":
      return "integer";
    case "decimal":
      return "numeric";
    case "bool":
      return "bool";
    case "datetime":
      return "datetime";
    case "string_array":
    case "lookup_array":
    case "json":
      return "json";
    default:
      return "text";
  }
}

const COLUMN_TYPE: Record<Kind, string> = {
  integer: "INTEGER",
  numeric: "NUMERIC",
  bool: "INTEGER",
  datetime: "TEXT",
  json: "TEXT",
  text: "TEXT",
};

/** A jsonb value as the SQLite column stores it (SQL NULL for a missing one). */
function store(kind: Kind, def: FieldDef, v: unknown): SQLInputValue {
  if (v === null || v === undefined) return null;
  switch (kind) {
    case "integer":
    case "numeric":
      return Number(v);
    case "bool":
      return v === true ? 1 : 0;
    case "datetime":
      return sqliteDateTime(String(v));
    case "json":
      if (def.type !== "json" && !Array.isArray(v)) return null;
      return JSON.stringify(v);
    default:
      return typeof v === "string" ? v : JSON.stringify(v);
  }
}

/** A SQLite column value back into the row a client gets. */
function load(kind: Kind, v: unknown): unknown {
  if (v === null || v === undefined) return undefined;
  if (kind === "bool") return v === 1;
  if (kind === "json") return JSON.parse(String(v));
  return v;
}

export class PostgresJsonbSource {
  readonly kind = "sqlite_double";
  readonly enforcesRowScope = true;
  private readonly origin: string;
  private readonly schema: SchemaDoc;
  private readonly pageSizeDefault: number;
  private readonly db = new DatabaseSync(":memory:");
  private readonly live: { field: string; kind: Kind; def: FieldDef }[];
  private readonly resolver: FieldResolver;
  private copied: string | null = null;

  constructor(opts: PostgresJsonbSourceOptions) {
    this.origin = opts.table;
    this.schema = opts.initialSchema;
    this.pageSizeDefault = opts.pageSizeDefault ?? DEFAULT_PAGE_SIZE;
    this.live = this.schema.field_order
      .filter((f) => this.schema.fields[f] && !this.schema.fields[f]?.deleted)
      .map((field) => {
        const def = this.schema.fields[field] as FieldDef;
        return { field, kind: kindOf(def), def };
      });
    this.resolver = sqliteColumnResolver({
      fields: Object.fromEntries(
        this.live.map(({ field }) => [field, sql`${sql.identifier(field)}`]),
      ),
      id: sql`"id"`,
      idType: "uuid",
    });
    this.db.function("lower", { deterministic: true }, (s) =>
      s === null ? null : String(s).toLowerCase(),
    );
    const cols = this.live.map(({ field, kind }) => `, "${field}" ${COLUMN_TYPE[kind]}`).join("");
    this.db.exec(`CREATE TABLE t ("id" TEXT PRIMARY KEY, "version" INTEGER NOT NULL${cols})`);
  }

  async describe(): Promise<SchemaDoc> {
    return this.schema;
  }

  async list(req: SourceListRequest, sctx?: SourceContext): Promise<ListResponse> {
    assertQueryFields(this.schema, req.filter, req.sort);
    await this.sync();
    const r = this.resolver;
    const where = compileFilter(andFilters(sctx?.rowScope, req.filter), this.schema, r);
    const terms = compileSort(req.sort, this.schema, r);
    const limit = req.page?.limit ?? this.pageSizeDefault;
    const cursor = req.page?.cursor;
    const offset = req.page?.offset ?? 0;
    const after = cursor != null ? decodeCursor(cursor, terms.length, r.idType) : null;
    const pageWhere = after
      ? sql`${where} AND ${cursorPredicate(terms, after.values, after.id, r)}`
      : where;
    const keyCols = terms.length > 0 ? sql`, ${sortKeyColumns(terms, r)}` : sql``;
    const rows = this.all(sql`
      SELECT *${keyCols} FROM t
      WHERE ${pageWhere}
      ORDER BY ${orderBy(terms, r)}
      LIMIT ${limit + 1} OFFSET ${after ? 0 : offset}`);
    const total = Number(this.all(sql`SELECT count(*) AS total FROM t WHERE ${where}`)[0]?.total);

    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const next_cursor =
      rows.length > limit && last
        ? encodeCursor([
            ...terms.map((_, i) => (last[`__k${i}`] ?? null) as CursorValue),
            String(last.id),
          ])
        : null;
    return { rows: page.map((row) => this.serialize(row)), next_cursor, total };
  }

  private all(query: SQL): Record<string, unknown>[] {
    const q = sqliteQuery(query);
    return this.db.prepare(q.sql).all(...(q.params as SQLInputValue[]));
  }

  private serialize(row: Record<string, unknown>): Row {
    const out: Row = { __meta: { id: String(row.id), version: Number(row.version) } };
    for (const { field, kind } of this.live) {
      const v = load(kind, row[field]);
      if (v !== undefined) out[field] = v;
    }
    return out;
  }

  /** Copy the jsonb rows into the SQLite table when they changed since the last copy. */
  private async sync(): Promise<void> {
    const res = await own.db.execute<{
      id: string;
      version: number;
      data: Record<string, unknown>;
    }>(sql`SELECT id::text AS id, version, data FROM ${sql.identifier(this.origin)} ORDER BY id`);
    const fingerprint = JSON.stringify(res.rows);
    if (fingerprint === this.copied) return;
    this.db.exec("DELETE FROM t");
    const names = this.live.map(({ field }) => `, "${field}"`).join("");
    const marks = this.live.map(() => ", ?").join("");
    const insert = this.db.prepare(`INSERT INTO t ("id", "version"${names}) VALUES (?, ?${marks})`);
    for (const row of res.rows) {
      insert.run(
        row.id,
        row.version,
        ...this.live.map(({ field, kind, def }) => store(kind, def, row.data[field])),
      );
    }
    this.copied = fingerprint;
  }
}
