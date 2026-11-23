// Schema rules that need no database: the root entry (`registry.ts`) checks a
// postgres_jsonb collection's schema.json with them, without importing the
// Postgres schema store.
import { type SchemaDoc, UdcError } from "@jsudc/core";

/** The integer revision in the table is `"v<n>"` on the wire. */
export const wireVersion = (version: number) => `v${version}`;

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
