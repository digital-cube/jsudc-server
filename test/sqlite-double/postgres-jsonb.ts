/**
 * The SQLite double of `src/sources/postgres-jsonb.js`: the Vitest project
 * `sqlite` aliases that module to this one, so the jsonb read suites
 * (pg-filter, pg-paging, pg-parity, pg-array, pg-allowlist) run unchanged
 * against `SqliteTableSource` (the SQL compiler's SQLite dialect), over a
 * `node:sqlite` `:memory:` `SqliteDatabase`.
 *
 * The suites keep writing their rows into the Postgres jsonb table. Before
 * every `list` this double copies those rows into a SQLite table with one
 * typed column per live field, in the storage `sqliteColumnResolver` expects
 * (INTEGER, NUMERIC, 0/1, `YYYY-MM-DD`, UTC datetime text, JSON text), and
 * answers the `list` with `SqliteTableSource` over that table (filter, sort,
 * keyset and offset paging, the row scope in its SQL).
 *
 * The connection registers a Unicode `lower()` (`String#toLowerCase`), as the
 * dialect's notes tell a host to: SQLite's own folds ASCII only.
 */
import type { FieldDef, ListResponse, SchemaDoc } from "@jsudc/core";
import { sql } from "drizzle-orm";
import { afterAll } from "vitest";
import { connect, type Db } from "../../src/db/client.js";
import { assertQueryFields } from "../../src/sources/fields.js";
import type { SourceContext, SourceListRequest } from "../../src/sources/source.js";
import { sqliteDateTime } from "../../src/sources/sqlite-sql.js";
import { SqliteTableSource } from "../../src/sources/sqlite-table.js";
import type { SqliteDatabase } from "../../src/sqlite-database.js";
import { openNodeSqlite } from "../../src/sqlite-node.js";

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
function store(kind: Kind, def: FieldDef, v: unknown): unknown {
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

export class PostgresJsonbSource {
  readonly kind = "sqlite_double";
  readonly enforcesRowScope = true;
  private readonly origin: string;
  private readonly schema: SchemaDoc;
  private readonly db: SqliteDatabase;
  private readonly live: { field: string; kind: Kind; def: FieldDef }[];
  private readonly source: SqliteTableSource;
  private readonly created: Promise<void>;
  private copied: string | null = null;

  constructor(opts: PostgresJsonbSourceOptions) {
    this.origin = opts.table;
    this.schema = opts.initialSchema;
    this.live = this.schema.field_order
      .filter((f) => this.schema.fields[f] && !this.schema.fields[f]?.deleted)
      .map((field) => {
        const def = this.schema.fields[field] as FieldDef;
        return { field, kind: kindOf(def), def };
      });
    this.db = openNodeSqlite(":memory:", { unicodeLower: true });
    afterAll(() => this.db.close());
    const cols = this.live.map(({ field, kind }) => `, "${field}" ${COLUMN_TYPE[kind]}`).join("");
    this.created = this.db.exec(
      `CREATE TABLE t ("id" TEXT PRIMARY KEY, "version" INTEGER NOT NULL${cols})`,
    );
    this.source = new SqliteTableSource({
      db: this.db,
      schema: this.schema,
      table: "t",
      versionColumn: "version",
      pageSizeDefault: opts.pageSizeDefault,
    });
  }

  async describe(): Promise<SchemaDoc> {
    return this.schema;
  }

  async list(req: SourceListRequest, sctx?: SourceContext): Promise<ListResponse> {
    // Refused before the copy reads the jsonb table (pg-allowlist watches for that).
    assertQueryFields(this.schema, req.filter, req.sort);
    await this.sync();
    return this.source.list(req, sctx);
  }

  /** Copy the jsonb rows into the SQLite table when they changed since the last copy. */
  private async sync(): Promise<void> {
    await this.created;
    const res = await own.db.execute<{
      id: string;
      version: number;
      data: Record<string, unknown>;
    }>(sql`SELECT id::text AS id, version, data FROM ${sql.identifier(this.origin)} ORDER BY id`);
    const fingerprint = JSON.stringify(res.rows);
    if (fingerprint === this.copied) return;
    const names = this.live.map(({ field }) => `, "${field}"`).join("");
    const marks = this.live.map(() => ", ?").join("");
    const insert = `INSERT INTO t ("id", "version"${names}) VALUES (?, ?${marks})`;
    await this.db.transaction((tx) => {
      tx.run("DELETE FROM t");
      for (const row of res.rows) {
        tx.run({
          sql: insert,
          params: [
            row.id,
            row.version,
            ...this.live.map(({ field, kind, def }) => store(kind, def, row.data[field])),
          ],
        });
      }
    });
    this.copied = fingerprint;
  }
}
