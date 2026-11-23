import type { ColumnConfig, SchemaDoc } from "@jsudc/core";

type FieldOrder = Pick<SchemaDoc, "fields" | "field_order">;

const isLive = (schema: FieldOrder, field: string) =>
  Object.hasOwn(schema.fields, field) && schema.fields[field]?.deleted !== true;

/**
 * `listed` (a view's base layout, in file order) plus an entry made by `make`
 * for every live schema field it does not mention. Each one goes right after
 * the last entry of the nearest preceding field in `field_order` that has
 * one, or first when there is none, so `schema.add_field` with
 * `position: before|after` lands where asked.
 */
export function placeUnlisted<T extends { field: string }>(
  listed: readonly T[],
  schema: FieldOrder,
  make: (field: string) => T,
): T[] {
  const out = [...listed];
  const seen = new Set(out.map((e) => e.field));

  schema.field_order.forEach((field, i) => {
    if (seen.has(field) || !isLive(schema, field)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const neighbour = schema.field_order[j];
      const last = out.findLastIndex((e) => e.field === neighbour);
      if (last >= 0) {
        at = last + 1;
        break;
      }
    }
    out.splice(at, 0, make(field));
    seen.add(field);
  });

  return out;
}

/** `hidden: true` on a column config (core 0.6.0; read loosely so an older core parses it too). */
const isHidden = (c: ColumnConfig) => (c as { hidden?: unknown }).hidden === true;

/**
 * The table columns `describe` serves: `view.columns` in file order (the
 * styled base layout), minus columns of deleted fields, plus a default column
 * for every non-deleted schema field the view does not list, placed by
 * `placeUnlisted`. With `mode` `listed` no default column is added. A column
 * marked `hidden: true` is left out, and its field still counts as listed, so
 * it does not come back as a default column.
 */
export function deriveColumns(
  columns: readonly ColumnConfig[],
  schema: FieldOrder,
  defaultWidth: number,
  mode: "all" | "listed" = "all",
): ColumnConfig[] {
  const kept = columns.filter((c) => schema.fields[c.field]?.deleted !== true);
  const placed =
    mode === "listed"
      ? kept
      : placeUnlisted(kept, schema, (field) => ({ field, width: defaultWidth, editable: true }));
  return placed.filter((c) => !isHidden(c));
}
