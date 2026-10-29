import { UdcError } from "@jsudc/core";

/** A keyset position: the text form of each sort value (`null` for a missing one), then the row id. */
export type CursorValue = string | null;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** base64url JSON of `[sortValue1, …, id]`, as udc-py. */
export function encodeCursor(parts: CursorValue[]): string {
  return Buffer.from(JSON.stringify(parts)).toString("base64url");
}

function malformed(): UdcError {
  return new UdcError("validation_error", "malformed cursor", { field: "page.cursor" });
}

/** Decode a cursor made for `keys` sort keys; anything else is a `validation_error`. */
export function decodeCursor(cursor: string, keys: number): { values: CursorValue[]; id: string } {
  let parts: unknown;
  try {
    parts = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw malformed();
  }
  if (!Array.isArray(parts) || parts.length !== keys + 1) throw malformed();
  const values = parts.slice(0, keys);
  const id = parts[keys];
  if (!values.every((v) => v === null || typeof v === "string") || !isUuid(id)) throw malformed();
  return { values, id };
}
