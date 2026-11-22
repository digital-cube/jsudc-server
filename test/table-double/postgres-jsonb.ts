/**
 * The `postgres_table` double of `src/sources/postgres-jsonb.js`: the Vitest
 * project `postgres-table` aliases that module to this one, so the jsonb
 * suites (pg-filter, pg-paging, pg-parity, pg-array, pg-allowlist) run
 * unchanged against a `PostgresTableSource`.
 *
 * The suites keep writing their rows into the jsonb table (`insertRows`,
 * `seedCollection`, raw `insert into tasks`). Before every read and write this double
 * copies those rows into `<table>__t_<hash of the schema>`, a real relational table with one
 * typed column per live field of the schema in use (bigint, numeric, date,
 * timestamptz, boolean, text, text[], jsonb), and serves that table through
 * `PostgresTableSource`. The copy runs over a pool of its own, so a suite that
 * spies on its pool sees only the source's statements.
 *
 * `mutate` writes the typed table through `PostgresTableSource`; a trigger on
 * it mirrors every insert, update and delete back into the jsonb table (with
 * `updated_at = now()` on update), in the same transaction, so a suite that
 * reads the jsonb table with raw SQL (pg-mutate) sees the write.
 */
import { createHash } from "node:crypto";
import type { FieldDef, ListResponse, Row, SchemaDoc } from "@jsudc/core";
import { sql } from "drizzle-orm";
import { afterAll } from "vitest";
import { connect, type Db } from "../../src/db/client.js";
import { PostgresTableSource } from "../../src/sources/postgres-table.js";
import type { SourceContext, SourceListRequest, SourceMutation } from "../../src/sources/source.js";

// Not imported from ./helpers.js: helpers imports this module (through the alias).
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || "postgresql://jsudc:123@localhost/jsudc_test";

/** One copy at a time, across every double of the file. */
let chain: Promise<unknown> = Promise.resolve();
/** Typed table → the fingerprint of the jsonb rows it was last copied from. */
const copied = new Map<string, string>();

const own = connect(TEST_DATABASE_URL);
afterAll(async () => {
  for (const table of copied.keys()) {
    await own.db.execute(sql`DROP TABLE IF EXISTS ${sql.identifier(table)}`);
    await own.db.execute(sql`DROP FUNCTION IF EXISTS ${sql.identifier(`${table}_mirror`)}()`);
  }
  await own.close();
});

export interface PostgresJsonbSourceOptions {
  db: Db;
  table: string;
  initialSchema: SchemaDoc;
  pageSizeDefault?: number;
}

/** The column type and the expression that reads it out of `data`, per field type. */
function column(field: string, def: FieldDef): { type: string; read: string } {
  const text = `(data->>'${field}')`;
  switch (def.type) {
    case "integer":
    case "year":
      return { type: "bigint", read: `${text}::bigint` };
    case "decimal":
      return { type: "numeric", read: `${text}::numeric` };
    case "date":
      return { type: "date", read: `${text}::date` };
    case "datetime":
      return { type: "timestamptz", read: `${text}::timestamptz` };
    case "bool":
      return { type: "boolean", read: `${text}::boolean` };
    case "string_array":
    case "lookup_array":
      return {
        type: "text[]",
        read: `(CASE WHEN jsonb_typeof(data->'${field}') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(data->'${field}')) END)`,
      };
    case "json":
      return { type: "jsonb", read: `NULLIF(data->'${field}', 'null'::jsonb)` };
    default:
      return { type: "text", read: text };
  }
}

export class PostgresJsonbSource {
  readonly kind = "postgres_table";
  readonly enforcesRowScope = true;
  private readonly source: PostgresTableSource;
  private readonly origin: string;
  private readonly typed: string;
  private readonly schema: SchemaDoc;

  constructor(opts: PostgresJsonbSourceOptions) {
    this.origin = opts.table;
    const hash = createHash("sha256")
      .update(JSON.stringify([opts.initialSchema.field_order, opts.initialSchema.fields]))
      .digest("hex")
      .slice(0, 8);
    this.typed = `${opts.table}__t_${hash}`;
    this.schema = opts.initialSchema;
    this.source = new PostgresTableSource({
      db: opts.db,
      schema: opts.initialSchema,
      table: this.typed,
      versionColumn: "version",
      pageSizeDefault: opts.pageSizeDefault,
    });
  }

  get capabilities() {
    return this.source.capabilities;
  }

  async describe(sctx?: SourceContext): Promise<SchemaDoc> {
    return this.source.describe(sctx);
  }

  async list(req: SourceListRequest, sctx?: SourceContext): Promise<ListResponse> {
    await this.sync();
    return this.source.list(req, sctx);
  }

  async read(id: string, sctx?: SourceContext): Promise<Row> {
    await this.sync();
    return this.source.read(id, sctx);
  }

  async mutate(m: SourceMutation, sctx?: SourceContext): Promise<Row> {
    await this.sync();
    return this.source.mutate(m, sctx);
  }

  /** (Re)build the typed table from the jsonb rows when they changed since the last copy. */
  private sync(): Promise<void> {
    const run = chain.then(() => this.copy());
    chain = run.catch(() => undefined);
    return run;
  }

  private async copy(): Promise<void> {
    const origin = sql.identifier(this.origin);
    const fp = await own.db.execute<{ fp: string }>(
      sql`SELECT md5(coalesce(string_agg(id::text || version::text || data::text, ',' ORDER BY id), '')) AS fp FROM ${origin}`,
    );
    const fingerprint = fp.rows[0]?.fp ?? "";
    if (copied.get(this.typed) === fingerprint) return;
    const live = this.schema.field_order.filter(
      (f) => this.schema.fields[f] && !this.schema.fields[f]?.deleted,
    );
    const cols = live.map((f) => ({ f, ...column(f, this.schema.fields[f] as FieldDef) }));
    const typed = sql.identifier(this.typed);
    const defs = cols.map((c) => sql.raw(`, "${c.f}" ${c.type}`));
    const names = cols.map((c) => sql.raw(`, "${c.f}"`));
    const reads = cols.map((c) => sql.raw(`, ${c.read}`));
    await own.db.transaction(async (tx) => {
      await tx.execute(sql`DROP TABLE IF EXISTS ${typed}`);
      await tx.execute(
        sql`CREATE TABLE ${typed} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), version integer NOT NULL DEFAULT 1${sql.join(defs)})`,
      );
      await tx.execute(
        sql`INSERT INTO ${typed} (id, version${sql.join(names)}) SELECT id, version${sql.join(reads)} FROM ${origin}`,
      );
      // After the copy: the copy itself is not mirrored.
      const mirror = sql.identifier(`${this.typed}_mirror`);
      const data = sql.raw(`jsonb_strip_nulls(to_jsonb(NEW) - 'id' - 'version')`);
      await tx.execute(sql`
        CREATE OR REPLACE FUNCTION ${mirror}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF TG_OP = 'DELETE' THEN
            DELETE FROM ${origin} WHERE id = OLD.id;
            RETURN OLD;
          ELSIF TG_OP = 'INSERT' THEN
            INSERT INTO ${origin} (id, version, data) VALUES (NEW.id, NEW.version, ${data});
          ELSE
            UPDATE ${origin} SET version = NEW.version, data = ${data}, updated_at = now()
            WHERE id = NEW.id;
          END IF;
          RETURN NEW;
        END $$`);
      await tx.execute(sql`
        CREATE TRIGGER mirror AFTER INSERT OR UPDATE OR DELETE ON ${typed}
        FOR EACH ROW EXECUTE FUNCTION ${mirror}()`);
    });
    copied.set(this.typed, fingerprint);
  }
}
