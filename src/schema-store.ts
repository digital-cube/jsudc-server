import { type SchemaDoc, SchemaDocSchema, UdcError } from "@jsudc/core";
import { and, eq, sql } from "drizzle-orm";
import type { Db, Executor } from "./db/client.js";
import { udcSchemaRevisions } from "./db/schema.js";
import { syncFieldIndexes } from "./sources/indexes.js";

/** The integer revision in the table is `"v<n>"` on the wire. */
export const wireVersion = (version: number) => `v${version}`;

/** The active schema revision of a collection, in its wire form; `null` when none is active. */
export async function activeSchema(db: Db, collection: string): Promise<SchemaDoc | null> {
  const [rev] = await db
    .select({ version: udcSchemaRevisions.version, schema: udcSchemaRevisions.schema })
    .from(udcSchemaRevisions)
    .where(and(eq(udcSchemaRevisions.collection, collection), eq(udcSchemaRevisions.active, true)))
    .limit(1);
  if (!rev) return null;
  return parseRevision(collection, rev.version, rev.schema);
}

function parseRevision(collection: string, version: number, schema: unknown): SchemaDoc {
  const parsed = SchemaDocSchema.safeParse({
    ...(schema as Record<string, unknown>),
    version: wireVersion(version),
  });
  if (!parsed.success) {
    throw new Error(
      `schema revision ${version} of ${collection} is invalid: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/** What a `schema.*` edit produced: the next document and the fields it changed. */
export interface RevisionEdit {
  schema: SchemaDoc;
  /** Fields whose index may have to go (index switched off, soft-deleted). */
  touched: string[];
}

export interface WriteRevisionOptions {
  /** The collection, which is also its table. */
  collection: string;
  /** `schema.json`: the base when the collection has no active revision. */
  initial: SchemaDoc;
  /** The edit, applied to the active schema as read inside the transaction. */
  edit: (current: SchemaDoc) => RevisionEdit | Promise<RevisionEdit>;
}

const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  // drizzle wraps the driver's error and keeps it as `cause`.
  for (let e = err; e instanceof Error; e = e.cause) {
    if ((e as { code?: unknown }).code === UNIQUE_VIOLATION) return true;
  }
  return false;
}

async function writeOnce(db: Db, opts: WriteRevisionOptions): Promise<SchemaDoc> {
  const { collection } = opts;
  return db.transaction(async (tx) => {
    // Edits of one collection queue up here, so each one builds on the last.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('udc_schema_revisions'), hashtext(${collection}))`,
    );
    const revs = await tx.execute<{ version: number; schema: unknown; active: boolean }>(sql`
      SELECT version, schema, active FROM udc_schema_revisions
      WHERE collection = ${collection} ORDER BY version DESC`);
    const active = revs.rows.find((r) => r.active);
    const current = active
      ? parseRevision(collection, active.version, active.schema)
      : opts.initial;
    let latest = revs.rows[0]?.version ?? 0;
    if (latest === 0) {
      // Keep schema.json in the history as v1, as seeding would have.
      await insertRevision(tx, collection, 1, opts.initial, false);
      latest = 1;
    }

    const { schema, touched } = await opts.edit(current);
    const version = latest + 1;
    await tx.execute(sql`
      UPDATE udc_schema_revisions SET active = false
      WHERE collection = ${collection} AND active`);
    await insertRevision(tx, collection, version, schema, true);
    await syncFieldIndexes(tx, collection, schema, touched);
    return { ...schema, version: wireVersion(version) };
  });
}

async function insertRevision(
  db: Executor,
  collection: string,
  version: number,
  schema: SchemaDoc,
  active: boolean,
): Promise<void> {
  const stored = { ...schema, version: wireVersion(version) };
  await db.execute(sql`
    INSERT INTO udc_schema_revisions (collection, version, schema, active)
    VALUES (${collection}, ${version}, ${JSON.stringify(stored)}::jsonb, ${active})`);
}

/**
 * One `schema.*` edit as a new active revision, in one transaction: read the
 * active schema, apply the edit, insert revision `max + 1`, move `active` to
 * it, and sync the field indexes. Writers of a collection serialise on an
 * advisory lock; one that does not take it (and so wins a version number or
 * the active slot first) makes the unique indexes refuse, and the whole edit
 * is retried once on top of what it wrote. Returns the new document, `version`
 * in its wire form.
 */
export async function writeSchemaRevision(db: Db, opts: WriteRevisionOptions): Promise<SchemaDoc> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await writeOnce(db, opts);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      if (attempt >= 2) {
        throw new UdcError(
          "version_conflict",
          `the schema of ${opts.collection} changed concurrently; reload and try again`,
          { collection: opts.collection },
        );
      }
    }
  }
}

/** Phase 1 keeps every field in `data`: a schema with core fields cannot be served. */
export function assertJsonbSchema(schema: Pick<SchemaDoc, "core_fields">, where: string): void {
  if (schema.core_fields.length > 0) {
    throw new UdcError(
      "unsupported_op",
      `${where}: core_fields must be empty, the jsonb source stores every field in data ` +
        `(got ${schema.core_fields.join(", ")})`,
      { core_fields: schema.core_fields },
    );
  }
}
