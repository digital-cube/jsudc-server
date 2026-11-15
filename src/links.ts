import {
  type FieldDef,
  lookupFieldProblems,
  lookupOf,
  lookupProblems,
  rowLinkProblems,
  type SchemaDoc,
  UdcError,
  type ViewConfig,
} from "@jsudc/core";
import type { CollectionRegistry } from "./registry.js";

/** What the cross-collection checks need of one served collection. */
export interface LinkedCollection {
  name: string;
  schema: Pick<SchemaDoc, "fields">;
  view: Pick<ViewConfig, "row_link">;
}

/**
 * Every lookup field and every `row_link` of `collections` checked against
 * the others: the target is served and has the named fields. One message
 * per problem (`<collection>.<field>: lookup target <x> has no field <y>`).
 */
export function registryLinkProblems(collections: readonly LinkedCollection[]): string[] {
  const byName = new Map(collections.map((c) => [c.name, c.schema]));
  const schemaOf = (name: string) => byName.get(name);
  return collections.flatMap((c) => [
    ...lookupProblems(c.name, c.schema, schemaOf),
    ...(c.view.row_link ? rowLinkProblems(c.name, c.view.row_link, c.schema, schemaOf) : []),
  ]);
}

/** `registryLinkProblems`, thrown as one Error that lists them all, so startup stops. */
export function assertRegistryLinks(collections: readonly LinkedCollection[], where: string): void {
  const problems = registryLinkProblems(collections);
  if (problems.length > 0) {
    throw new Error(`${where}: lookups and row links do not fit\n${problems.join("\n")}`);
  }
}

/**
 * The same check against each collection's ACTIVE schema (a revision may
 * have added or deleted fields since `schema.json`). `udcPlugin` runs it at
 * startup when it is given the registry; it throws like `assertRegistryLinks`.
 */
export async function checkRegistryLinks(registry: CollectionRegistry): Promise<void> {
  const collections = await Promise.all(
    registry
      .list()
      .map(async (c) => ({ name: c.name, schema: await c.source.describe(), view: c.view })),
  );
  assertRegistryLinks(collections, "active schemas");
}

/**
 * Before `schema.add_field` / `schema.update_field` writes a lookup field:
 * its target is served and has the named fields (in its active schema).
 * Anything else passes untouched. A problem is a `validation_error`.
 */
export async function assertLookupTarget(
  registry: CollectionRegistry,
  collection: string,
  name: string,
  def: FieldDef,
): Promise<void> {
  const lookup = lookupOf(def);
  const target = lookup ? registry.list().find((c) => c.name === lookup.collection) : undefined;
  const schema = target ? await target.source.describe() : undefined;
  const problems = lookupFieldProblems(collection, name, def, (n) =>
    schema && n === lookup?.collection ? schema : undefined,
  );
  if (problems.length > 0) {
    throw new UdcError("validation_error", problems.join("; "), { field: name, problems });
  }
}
