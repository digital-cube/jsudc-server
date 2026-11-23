import {
  type Capabilities,
  type CollectionDocs,
  type DescribeResponse,
  type FilterableField,
  filterableForType,
  type SchemaDoc,
  type SourceInfo,
  type SourceKind,
  type ViewConfig,
} from "@jsudc/core";
import { deriveColumns, placeUnlisted } from "./columns.js";
import { presentedSchema } from "./schema-edit.js";

type FieldEntry = Exclude<NonNullable<ViewConfig["filterable"]>["fields"][number], string>;

/**
 * The filter-builder fields: `view.filterable.fields` (bare names or override
 * blocks) in file order, plus every other non-deleted schema field placed by
 * `field_order` as derived columns are (so a field added at runtime is
 * filterable at once), each merged with the defaults of its type. Deleted and
 * unknown fields drop out.
 */
export function filterableFields(view: ViewConfig, schema: SchemaDoc): FilterableField[] {
  const declared: FieldEntry[] = (view.filterable?.fields ?? []).map((f) =>
    typeof f === "string" ? { field: f } : f,
  );
  const entries = placeUnlisted(declared, schema, (field): FieldEntry => ({ field }));
  const perType = view.filterable?.default_op ?? {};

  const out: FilterableField[] = [];
  for (const { field, ops, default_op, widget, label, values, ...rest } of entries) {
    const def = schema.fields[field];
    if (!def || def.deleted) continue;
    const defaults = filterableForType(def.type);
    const entry: FilterableField = {
      ...rest,
      field,
      type: def.type,
      ops: [...(ops ?? defaults.ops)],
      default_op: default_op ?? perType[def.type] ?? defaults.default_op,
      widget: widget ?? defaults.widget,
    };
    if (label !== undefined) entry.label = label;
    const choices = values ?? def.values;
    if (choices !== undefined) entry.values = choices;
    out.push(entry);
  }
  return out;
}

/**
 * `describe.sortable` (core 0.5.2): the fields a client may sort by. Typed
 * here rather than taken from `@jsudc/core`, so the server builds against a
 * core that does not have it yet; such a core passes the key through.
 */
export interface SortableFields {
  fields: string[];
}

/** The `describe` payload with `sortable` (core 0.5.2). */
export type Described = DescribeResponse & { sortable?: SortableFields };

/** The live schema fields in `field_order`, without those the source does not sort by. */
export function sortableFields(
  schema: SchemaDoc,
  notSortable: Iterable<string> = [],
): SortableFields {
  const refused = new Set(notSortable);
  return {
    fields: schema.field_order.filter((f) => {
      const def = schema.fields[f];
      return def !== undefined && !def.deleted && !refused.has(f);
    }),
  };
}

/**
 * The `describe` payload: the source's active schema without its soft-deleted
 * fields, the view with its derived columns, and the README when there is one.
 */
export function buildDescribe(
  collection: string,
  capabilities: Capabilities,
  active: SchemaDoc,
  view: ViewConfig,
  about: {
    source_kind: SourceKind;
    docs?: CollectionDocs | undefined;
    source?: SourceInfo | undefined;
    /** The fields the source refuses in a sort (`Source.notSortable`). */
    notSortable?: readonly string[] | undefined;
  } = {
    source_kind: "postgres_jsonb",
  },
): Described {
  return {
    collection,
    capabilities,
    source_kind: about.source_kind,
    ...(about.source ? { source: about.source } : {}),
    ...(about.docs ? { docs: about.docs } : {}),
    schema: presentedSchema(active),
    view: {
      ...view,
      columns: deriveColumns(
        view.columns,
        active,
        view.default_column_width,
        // `columns_mode` is core 0.5.2's; read loosely so an older core parses it too.
        (view as { columns_mode?: unknown }).columns_mode === "listed" ? "listed" : "all",
      ),
    },
    filterable: { fields: filterableFields(view, active) },
    sortable: sortableFields(active, about.notSortable),
  };
}
