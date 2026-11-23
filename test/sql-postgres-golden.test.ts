// The Postgres text and parameters of the SQL compiler, pinned in a file snapshot: every op
// on every field type (case-sensitive and not), arrays in both storage forms, the row id
// conditions, ORDER BY, the sort-key columns and every shape of the keyset cursor, through
// the jsonb resolver and the column resolver. The snapshot was written before the compiler
// learnt dialects (TCK2FWFETY): the Postgres dialect must keep it byte-identical.
import { type FilterNode, type FilterOp, SchemaDocSchema, type SortKey } from "@jsudc/core";
import { type SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  codePointOrder,
  compileFilter,
  compileSort,
  cursorPredicate,
  type FieldResolver,
  idParam,
  orderBy,
  sortKeyColumns,
} from "../src/index.js";
import { columnResolver, jsonbResolver } from "../src/postgres.js";

const pg = new PgDialect();

function render(label: string, q: SQL): string {
  const { sql: text, params } = pg.sqlToQuery(q);
  return `${label}\n  ${text}\n  ${JSON.stringify(params)}\n`;
}

const schema = SchemaDocSchema.parse({
  version: "v1",
  fields: {
    s: { type: "string" },
    t: { type: "text" },
    n: { type: "integer" },
    d: { type: "decimal" },
    y: { type: "year" },
    dt: { type: "date" },
    ts: { type: "datetime" },
    b: { type: "bool" },
    j: { type: "json" },
    tags: { type: "string_array" },
    refs: { type: "lookup_array" },
  },
});

/** A value of each field type the comparisons accept. */
const SAMPLE: Record<string, [unknown, unknown]> = {
  s: ["Alfa", "beta"],
  t: ["dugačak", "tekst"],
  n: [9, 10],
  d: [1.5, 10.125],
  y: [1999, 2024],
  dt: ["2020-01-15", "2021-06-01"],
  ts: ["2020-01-15T10:00:00Z", "2021-06-01T00:00:00+02:00"],
  b: [false, true],
  j: ["x", "y"],
};

const SCALAR_OPS: FilterOp[] = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "in",
  "not_in",
  "contains",
  "starts_with",
  "ends_with",
  "is_null",
  "is_not_null",
];

function scalarCases(): [string, FilterNode][] {
  const out: [string, FilterNode][] = [];
  for (const [field, [a, b]] of Object.entries(SAMPLE)) {
    for (const op of SCALAR_OPS) {
      for (const ci of [false, true]) {
        const value =
          op === "between"
            ? [a, b]
            : op === "in" || op === "not_in"
              ? [a, null, b]
              : op === "contains" || op === "starts_with" || op === "ends_with"
                ? "a%_\\b"
                : op === "is_null" || op === "is_not_null"
                  ? undefined
                  : a;
        const cond = { field, op, value, ...(ci ? { case_insensitive: true } : {}) } as FilterNode;
        out.push([`${field} ${op}${ci ? " ci" : ""}`, cond]);
      }
    }
  }
  return out;
}

const ARRAY_OPS: FilterOp[] = [
  "in",
  "not_in",
  "contains",
  "starts_with",
  "ends_with",
  "is_null",
  "is_not_null",
];

function arrayCases(): [string, FilterNode][] {
  const out: [string, FilterNode][] = [];
  for (const field of ["tags", "refs"]) {
    for (const op of ARRAY_OPS) {
      for (const ci of [false, true]) {
        const value =
          op === "in" || op === "not_in"
            ? ["Ui", null, "x"]
            : op === "is_null" || op === "is_not_null"
              ? undefined
              : "5%_";
        const cond = { field, op, value, ...(ci ? { case_insensitive: true } : {}) } as FilterNode;
        out.push([`${field} ${op}${ci ? " ci" : ""}`, cond]);
      }
    }
  }
  return out;
}

const GROUPS: [string, FilterNode | null][] = [
  ["no filter", null],
  ["and []", { and: [] }],
  ["or []", { or: [] }],
  [
    "and/or/not",
    {
      and: [
        { field: "n", op: "gt", value: 0 },
        {
          or: [
            { field: "s", op: "eq", value: "x" },
            { not: { field: "b", op: "eq", value: true } },
          ],
        },
      ],
    },
  ],
  ["eq null", { field: "s", op: "eq", value: null }],
  ["between with a null", { field: "n", op: "between", value: [null, 3] }],
  ["contains null", { field: "s", op: "contains", value: null }],
  ["array contains null", { field: "tags", op: "contains", value: null }],
  ["in []", { field: "n", op: "in", value: [] }],
  ["not_in []", { field: "s", op: "not_in", value: [] }],
];

/** No `id` field: a condition on `id` is on the row id. */
const ID_CASES: [string, FilterNode][] = [
  ["id eq", { field: "id", op: "eq", value: "7" }],
  ["id neq", { field: "id", op: "neq", value: 7 }],
  ["id eq null", { field: "id", op: "eq", value: null }],
  ["id in", { field: "id", op: "in", value: ["1", null, "2"] }],
  ["id not_in", { field: "id", op: "not_in", value: ["1"] }],
  ["id is_null", { field: "id", op: "is_null" }],
  ["id is_not_null", { field: "id", op: "is_not_null" }],
];

const SORTS: [string, SortKey[]][] = [
  ["none", []],
  ["s", [{ field: "s" }]],
  ["n desc", [{ field: "n", dir: "desc" }]],
  [
    "dt, ts, b asc",
    [
      { field: "dt", dir: "asc" },
      { field: "ts", dir: "asc" },
      { field: "b", dir: "asc" },
    ],
  ],
  [
    "d desc, y desc",
    [
      { field: "d", dir: "desc" },
      { field: "y", dir: "desc" },
    ],
  ],
  ["s asc, n desc (mixed)", [{ field: "s" }, { field: "n", dir: "desc" }]],
];

/** Cursor values for a sort: all set, then each one missing in turn. */
function cursorValueSets(n: number): (string | null)[][] {
  const full = Array.from({ length: n }, (_, i) => `v${i}`);
  return [full, ...full.map((_, i) => full.map((v, j) => (j === i ? null : v)))];
}

const RESOLVERS: [string, FieldResolver][] = [
  ["jsonb", jsonbResolver],
  [
    "columns (text[] arrays, integer id)",
    columnResolver({
      fields: Object.fromEntries(schema.field_order.map((f) => [f, sql.identifier(`c_${f}`)])),
      id: sql`pk`,
      idType: "integer",
    }),
  ],
  [
    "columns (jsonb arrays, text id)",
    columnResolver({
      fields: Object.fromEntries(schema.field_order.map((f) => [f, sql.raw(`m.${f}`)])),
      arrayForms: { tags: "jsonb", refs: "jsonb" },
      id: sql`m.id`,
      idType: "text",
    }),
  ],
];

function corpus(resolve: FieldResolver): string {
  let out = "";
  for (const [label, f] of [...scalarCases(), ...arrayCases(), ...GROUPS, ...ID_CASES]) {
    try {
      out += render(`filter ${label}`, compileFilter(f, schema, resolve));
    } catch (e) {
      // A refused op (lookup_array takes fewer) is pinned too.
      out += `filter ${label}\n  refused: ${(e as { code?: string }).code}\n`;
    }
  }
  for (const [label, sort] of SORTS) {
    const terms = compileSort(sort, schema, resolve);
    out += render(`order by ${label}`, orderBy(terms, resolve));
    if (terms.length > 0) out += render(`sort keys ${label}`, sortKeyColumns(terms));
    for (const values of cursorValueSets(terms.length)) {
      const id = resolve.idType === "uuid" ? "00000000-0000-4000-8000-000000000001" : "42";
      out += render(
        `cursor ${label} ${JSON.stringify(values)}`,
        cursorPredicate(terms, values, id, resolve),
      );
    }
  }
  return out;
}

describe("the Postgres SQL of the compiler, byte for byte", () => {
  it.each(RESOLVERS)("%s resolver", async (name, resolve) => {
    const file = `./__snapshots__/sql-postgres-golden.${name.split(" ")[0]}${
      name.includes("jsonb arrays") ? "-jsonb-arrays" : ""
    }.txt`;
    await expect(corpus(resolve)).toMatchFileSnapshot(file);
  });

  it("idParam and codePointOrder", async () => {
    const out = [
      render("idParam uuid", idParam("00000000-0000-4000-8000-000000000001", "uuid")),
      render("idParam integer", idParam("42", "integer")),
      render("idParam text", idParam("a'b", "text")),
      render("codePointOrder", codePointOrder(sql`x`)),
    ].join("");
    await expect(out).toMatchFileSnapshot("./__snapshots__/sql-postgres-golden.helpers.txt");
  });
});
