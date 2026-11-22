// The exported SQL compiler, used the way a host with its own source would: a hand-written
// FieldResolver over a table whose columns are named `c_<field>` with an integer key `pk`.
import { evaluateFilter, type FilterNode, SchemaDocSchema, type SortKey } from "@jsudc/core";
import { type SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeAll, describe, expect, it } from "vitest";
import {
  codePointOrder,
  compileFilter,
  compileSort,
  cursorPredicate,
  decodeCursor,
  encodeCursor,
  escapeLike,
  type FieldResolver,
  idParam,
  jsonbResolver,
  orderBy,
  sortKeyColumns,
  sqlCastFor,
} from "../src/index.js";
import { rejectsWith, useTestDb } from "./helpers.js";

const { db } = useTestDb();

const schema = SchemaDocSchema.parse({
  version: "v1",
  fields: {
    name: { type: "string" },
    age: { type: "integer" },
    born: { type: "date" },
    tags: { type: "string_array" },
  },
});

const col = (field: string): SQL => sql`${sql.identifier(`c_${field}`)}`;

/** What a host writes for its own storage: where each allowlisted field lives. */
const resolve: FieldResolver = {
  text: (field) => sql`(${col(field)}::text)`,
  typed: (field, _def, cast) =>
    cast === "text" ? codePointOrder(sql`${col(field)}::text`) : sql`(${col(field)})`,
  array: (field) => ({ expr: col(field), form: "text[]" }),
  id: sql`pk`,
  idType: "integer",
};

const ROWS = [
  { name: "Ana", age: 31, born: "1993-04-01", tags: ["a", "b"] },
  { name: "bojan", age: 25, born: "1999-12-31", tags: ["b"] },
  { name: "Ćira", age: null, born: null, tags: null },
  { name: "dejan", age: 40, born: "1984-01-15", tags: [] },
  { name: "Ema", age: 25, born: "1999-01-01", tags: ["c_d"] },
  { name: "100%", age: 7, born: "2017-06-06", tags: ["a"] },
];

beforeAll(async () => {
  await db.execute(sql`DROP TABLE IF EXISTS sc_people`);
  await db.execute(
    sql`CREATE TABLE sc_people (pk integer PRIMARY KEY, c_name text, c_age integer, c_born date, c_tags text[])`,
  );
  for (const [i, r] of ROWS.entries()) {
    await db.execute(sql`
      INSERT INTO sc_people VALUES (${(i + 1) * 10}, ${r.name}, ${r.age}, ${r.born}::date,
        ${r.tags === null ? null : sql.param(r.tags)}::text[])`);
  }
});

interface PeopleRow extends Record<string, unknown> {
  pk: number;
  c_name: string;
}

/** A host's own `list`: the compiler builds the WHERE, ORDER BY and the keyset predicate. */
async function list(
  filter: FilterNode | undefined,
  sort: SortKey[],
  limit: number,
  cursor?: string,
) {
  const terms = compileSort(sort, schema, resolve);
  const after = cursor ? decodeCursor(cursor, terms.length, resolve.idType) : null;
  const where = compileFilter(filter, schema, resolve);
  const page = after
    ? sql`${where} AND ${cursorPredicate(terms, after.values, after.id, resolve)}`
    : where;
  const keys = terms.length > 0 ? sql`, ${sortKeyColumns(terms)}` : sql``;
  const res = await db.execute<PeopleRow>(sql`
    SELECT pk, c_name${keys} FROM sc_people WHERE ${page} ORDER BY ${orderBy(terms, resolve)} LIMIT ${limit + 1}`);
  const rows = res.rows.slice(0, limit);
  const last = rows.at(-1);
  const next =
    res.rows.length > limit && last
      ? encodeCursor([
          ...terms.map((_, i) => (last[`__k${i}`] as string | null) ?? null),
          String(last.pk),
        ])
      : null;
  return { names: rows.map((r) => r.c_name), next };
}

describe("a hand-written resolver", () => {
  it.each<FilterNode>([
    { field: "name", op: "gt", value: "B" },
    { field: "name", op: "contains", value: "%" },
    { field: "name", op: "starts_with", value: "ć", case_insensitive: true },
    { field: "age", op: "between", value: [20, 35] },
    { field: "age", op: "not_in", value: [25] },
    { field: "born", op: "lt", value: "1999-06-01" },
    { field: "tags", op: "in", value: ["b", "c_d"] },
    { field: "tags", op: "not_in", value: ["a"] },
    { field: "tags", op: "contains", value: "_" },
    { field: "id", op: "in", value: ["20", "40"] },
    { or: [{ field: "age", op: "is_null" }, { not: { field: "name", op: "lt", value: "b" } }] },
  ])("filters as evaluateFilter does: %j", async (filter) => {
    const { names } = await list(filter, [{ field: "name" }], 100);
    // The row id as evaluateFilter reads it when the schema has no `id` field.
    const memory = ROWS.map((r, i) => ({ ...r, id: String((i + 1) * 10) }))
      .filter((r) => evaluateFilter(filter, r))
      .map((r) => r.name)
      .sort((a, b) => (a < b ? -1 : 1));
    expect(names).toEqual(memory);
  });

  it("pages by keyset with an integer id, NULLs last", async () => {
    const sort: SortKey[] = [{ field: "age", dir: "desc" }];
    const all = (await list(undefined, sort, 100)).names;
    expect(all).toEqual(["dejan", "Ana", "bojan", "Ema", "100%", "Ćira"]);
    const walked: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const res = await list(undefined, sort, 2, cursor);
      walked.push(...res.names);
      if (!res.next) break;
      cursor = res.next;
    }
    expect(walked).toEqual(all);
  });

  it("refuses an unknown field and a value of the wrong type before any SQL runs", async () => {
    expect(() => compileFilter({ field: "nope", op: "eq", value: 1 }, schema, resolve)).toThrow(
      /unknown field in filter/,
    );
    expect(() => compileSort([{ field: "nope" }], schema, resolve)).toThrow(
      /unknown field in sort/,
    );
    expect(() => compileFilter({ field: "age", op: "eq", value: "x" }, schema, resolve)).toThrow(
      /a number/,
    );
    await rejectsWith(
      Promise.resolve().then(() => decodeCursor(encodeCursor(["1", "abc"]), 1, "integer")),
      "validation_error",
    );
    expect(decodeCursor(encodeCursor(["1", "abc"]), 1, "text")).toEqual({
      values: ["1"],
      id: "abc",
    });
  });

  it("exposes the helpers a resolver needs", () => {
    expect(escapeLike("50%_a\\b")).toBe("50\\%\\_a\\\\b");
    expect(sqlCastFor({ type: "integer" })).toBe("numeric");
    expect(sqlCastFor({ type: "datetime" })).toBe("timestamptz");
    expect(sqlCastFor({ type: "enum", values: ["a"] })).toBe("text");
    const d = new PgDialect();
    expect(d.sqlToQuery(idParam("7", "integer")).sql).toBe("$1::bigint");
  });
});

describe("the jsonb resolver", () => {
  const d = new PgDialect();
  const text = (x: SQL) => d.sqlToQuery(x).sql;

  // The SQL text the expression indexes of postgres_jsonb and their query plans depend on.
  it("writes the same SQL as before the resolver existed", () => {
    expect(text(compileFilter({ field: "age", op: "gt", value: 1 }, schema))).toBe(
      "(((data->>'age')::numeric) > $1::numeric)",
    );
    expect(text(compileFilter({ field: "born", op: "eq", value: "2020-01-01" }, schema))).toBe(
      "(udc_date(data->>'born') = $1::date)",
    );
    expect(text(compileFilter({ field: "name", op: "lt", value: "x" }, schema))).toBe(
      "(((data->>'name') COLLATE \"C\") < $1::text)",
    );
    expect(text(compileFilter({ field: "id", op: "eq", value: "x" }, schema))).toBe(
      "((id::text) = $1::text)",
    );
    expect(
      text(compileFilter({ field: "tags", op: "in", value: ["a"] }, schema, jsonbResolver)),
    ).toBe(
      "(CASE WHEN jsonb_typeof((data->'tags')) = 'array' THEN EXISTS (SELECT 1 FROM jsonb_array_elements_text((data->'tags')) AS e(el) WHERE e.el = ANY($1::text[])) ELSE NULL END)",
    );
    const terms = compileSort([{ field: "age", dir: "desc" }], schema);
    expect(text(orderBy(terms))).toBe("((data->>'age')::numeric) DESC NULLS LAST, id ASC");
    expect(text(cursorPredicate(terms, ["5"], "00000000-0000-0000-0000-000000000000"))).toBe(
      "(((((data->>'age')::numeric), $1::uuid) < ($2::numeric, id)) OR ((((data->>'age')::numeric) IS NULL)))",
    );
  });
});
