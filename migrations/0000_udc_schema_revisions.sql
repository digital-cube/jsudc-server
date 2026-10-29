-- @jsudc/server: the schema revisions of every postgres_jsonb collection.
-- At most one revision per collection is active; the dispatcher serves it.
CREATE TABLE IF NOT EXISTS "udc_schema_revisions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"collection" text NOT NULL,
	"version" integer NOT NULL,
	"schema" jsonb NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "udc_schema_revisions_collection_version_key" UNIQUE("collection","version")
);

CREATE UNIQUE INDEX IF NOT EXISTS "udc_schema_revisions_one_active_idx" ON "udc_schema_revisions" USING btree ("collection") WHERE active;
