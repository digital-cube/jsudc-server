import { FIELD_NAME_RE } from "@jsudc/core";
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** The shape every jsonb-backed collection table has: all fields live in `data`. */
export function collectionTable(name: string) {
  return pgTable(name, {
    id: uuid("id").primaryKey().defaultRandom(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  });
}

/** `collectionTable(name)` as plain SQL, for a host without drizzle; idempotent. */
export function createCollectionTableSql(name: string): string {
  if (!FIELD_NAME_RE.test(name)) throw new Error(`invalid table name ${JSON.stringify(name)}`);
  return `CREATE TABLE IF NOT EXISTS "${name}" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "data" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);`;
}

/** Every schema revision of every postgres_jsonb collection; at most one active per collection. */
export const udcSchemaRevisions = pgTable(
  "udc_schema_revisions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    collection: text("collection").notNull(),
    version: integer("version").notNull(),
    schema: jsonb("schema").$type<Record<string, unknown>>().notNull(),
    active: boolean("active").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("udc_schema_revisions_collection_version_key").on(t.collection, t.version),
    uniqueIndex("udc_schema_revisions_one_active_idx").on(t.collection).where(sql`active`),
  ],
);
