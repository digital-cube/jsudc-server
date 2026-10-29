import { evaluateFilter, type FilterNode, type SchemaDocInput, SchemaDocSchema } from "@jsudc/core";
import { beforeAll, describe, expect, it } from "vitest";
import { PostgresJsonbSource } from "../src/sources/postgres-jsonb.js";
import { activateSchema, insertRows, rejectsWith, resetTables, useTestDb } from "./helpers.js";

const { db } = useTestDb();

// Every field type the compiler casts, on the companies table: all fields live in `data`.
const mixed: SchemaDocInput = {
  version: "v1",
  fields: {
    tag: { type: "string" },
    s: { type: "string" },
    n: { type: "integer" },
    d: { type: "decimal" },
    dt: { type: "date" },
    b: { type: "bool" },
    ts: { type: "datetime" },
    y: { type: "year" },
    t: { type: "text" },
    j: { type: "json" },
  },
};

const ROWS = [
  {
    tag: "r1",
    s: "Alfa",
    n: 9,
    d: 1.5,
    dt: "2020-01-15",
    b: true,
    ts: "2020-01-15T10:00:00Z",
    y: 1999,
  },
  {
    tag: "r2",
    s: "beta",
    n: 10,
    d: 2.25,
    dt: "2021-06-01",
    b: false,
    ts: "2021-06-01T00:00:00+02:00",
  },
  {
    tag: "r3",
    s: "100% real_deal\\x",
    n: 100,
    d: -3,
    dt: "2019-12-31",
    b: true,
    t: "dugačak tekst",
  },
  { tag: "r4", s: "Gama", n: 0, d: 0, j: { a: 1 } },
  { tag: "r5" },
  { tag: "r6", s: "ALFA beta", n: -5, d: 10.125, dt: "2020-01-15", b: false, y: 2024 },
];

let source: PostgresJsonbSource;
beforeAll(async () => {
  await resetTables(db);
  await activateSchema(db, mixed);
  await insertRows(db, ROWS);
  source = new PostgresJsonbSource({
    db,
    table: "companies",
    initialSchema: SchemaDocSchema.parse(mixed),
  });
});

async function tags(filter: FilterNode): Promise<string[]> {
  const res = await source.list({ filter, sort: [{ field: "tag" }], page: { limit: 100 } });
  expect(res.total).toBe(res.rows.length);
  return res.rows.map((r) => r.tag as string);
}

const c = (field: string, op: string, value?: unknown, ci?: boolean): FilterNode =>
  ({ field, op, value, ...(ci ? { case_insensitive: true } : {}) }) as FilterNode;

type Case = [FilterNode, string[]];

const CASES: Record<string, Case[]> = {
  string: [
    [c("s", "eq", "Alfa"), ["r1"]],
    [c("s", "eq", "alfa", true), ["r1"]],
    [c("s", "neq", "Alfa"), ["r2", "r3", "r4", "r6"]],
    [c("s", "neq", "ALFA", true), ["r2", "r3", "r4", "r6"]],
    [c("s", "in", ["Alfa", "Gama"]), ["r1", "r4"]],
    [c("s", "in", ["ALFA", "GAMA"], true), ["r1", "r4"]],
    [c("s", "in", []), []],
    [c("s", "not_in", ["Alfa"]), ["r2", "r3", "r4", "r6"]],
    [c("s", "not_in", []), ["r1", "r2", "r3", "r4", "r6"]],
    [c("s", "contains", "eta"), ["r2", "r6"]],
    [c("s", "contains", "ALFA"), ["r6"]],
    [c("s", "contains", "ALFA", true), ["r1", "r6"]],
    [c("s", "contains", "%"), ["r3"]],
    [c("s", "contains", "_"), ["r3"]],
    [c("s", "contains", "\\"), ["r3"]],
    [c("s", "contains", "1%l"), []],
    [c("s", "contains", "r_al"), []],
    [c("s", "contains", "0% r"), ["r3"]],
    [c("s", "starts_with", "Al"), ["r1"]],
    [c("s", "starts_with", "al", true), ["r1", "r6"]],
    [c("s", "starts_with", "_"), []],
    [c("s", "ends_with", "beta"), ["r2", "r6"]],
    [c("s", "ends_with", "\\x"), ["r3"]],
    [c("s", "gt", "a"), ["r2"]],
    [c("s", "gte", "Gama"), ["r2", "r4"]],
    [c("s", "lt", "B"), ["r1", "r3", "r6"]],
    [c("s", "lte", "Alfa"), ["r1", "r3", "r6"]],
    [c("s", "between", ["A", "H"]), ["r1", "r4", "r6"]],
    [c("s", "between", ["Alfa", "Gama"]), ["r1", "r4"]],
    [c("s", "is_null"), ["r5"]],
    [c("s", "is_not_null"), ["r1", "r2", "r3", "r4", "r6"]],
  ],
  integer: [
    [c("n", "eq", 10), ["r2"]],
    [c("n", "neq", 10), ["r1", "r3", "r4", "r6"]],
    [c("n", "gt", 9), ["r2", "r3"]],
    [c("n", "gte", 10), ["r2", "r3"]],
    [c("n", "lt", 10), ["r1", "r4", "r6"]],
    [c("n", "lte", 0), ["r4", "r6"]],
    [c("n", "between", [0, 10]), ["r1", "r2", "r4"]],
    [c("n", "in", [9, 100]), ["r1", "r3"]],
    [c("n", "in", []), []],
    [c("n", "not_in", [9]), ["r2", "r3", "r4", "r6"]],
    [c("n", "contains", "0"), ["r2", "r3", "r4"]],
    [c("n", "starts_with", "1"), ["r2", "r3"]],
    [c("n", "ends_with", "5"), ["r6"]],
    [c("n", "is_null"), ["r5"]],
    [c("n", "is_not_null"), ["r1", "r2", "r3", "r4", "r6"]],
  ],
  decimal: [
    [c("d", "eq", 2.25), ["r2"]],
    [c("d", "neq", 0), ["r1", "r2", "r3", "r6"]],
    [c("d", "gt", 2), ["r2", "r6"]],
    [c("d", "gte", 1.5), ["r1", "r2", "r6"]],
    [c("d", "lt", 0), ["r3"]],
    [c("d", "lte", 1.5), ["r1", "r3", "r4"]],
    [c("d", "between", [-3, 1.5]), ["r1", "r3", "r4"]],
    [c("d", "in", [1.5, 10.125]), ["r1", "r6"]],
    [c("d", "not_in", [0]), ["r1", "r2", "r3", "r6"]],
    [c("d", "contains", ".1"), ["r6"]],
    [c("d", "starts_with", "-"), ["r3"]],
    [c("d", "ends_with", "5"), ["r1", "r2", "r6"]],
    [c("d", "is_null"), ["r5"]],
    [c("d", "is_not_null"), ["r1", "r2", "r3", "r4", "r6"]],
  ],
  date: [
    [c("dt", "eq", "2020-01-15"), ["r1", "r6"]],
    [c("dt", "neq", "2020-01-15"), ["r2", "r3"]],
    [c("dt", "gt", "2020-01-15"), ["r2"]],
    [c("dt", "gte", "2020-01-15"), ["r1", "r2", "r6"]],
    [c("dt", "lt", "2020-01-01"), ["r3"]],
    [c("dt", "lte", "2020-01-15"), ["r1", "r3", "r6"]],
    [c("dt", "between", ["2019-12-31", "2020-01-15"]), ["r1", "r3", "r6"]],
    [c("dt", "in", ["2019-12-31", "2021-06-01"]), ["r2", "r3"]],
    [c("dt", "not_in", ["2020-01-15"]), ["r2", "r3"]],
    [c("dt", "contains", "-01-"), ["r1", "r6"]],
    [c("dt", "starts_with", "2020"), ["r1", "r6"]],
    [c("dt", "ends_with", "31"), ["r3"]],
    [c("dt", "is_null"), ["r4", "r5"]],
    [c("dt", "is_not_null"), ["r1", "r2", "r3", "r6"]],
  ],
  bool: [
    [c("b", "eq", true), ["r1", "r3"]],
    [c("b", "neq", true), ["r2", "r6"]],
    [c("b", "gt", false), ["r1", "r3"]],
    [c("b", "gte", false), ["r1", "r2", "r3", "r6"]],
    [c("b", "lt", true), ["r2", "r6"]],
    [c("b", "lte", false), ["r2", "r6"]],
    [c("b", "between", [false, true]), ["r1", "r2", "r3", "r6"]],
    [c("b", "in", [true]), ["r1", "r3"]],
    [c("b", "not_in", [true]), ["r2", "r6"]],
    [c("b", "contains", "ru"), ["r1", "r3"]],
    [c("b", "starts_with", "f"), ["r2", "r6"]],
    [c("b", "ends_with", "e"), ["r1", "r2", "r3", "r6"]],
    [c("b", "is_null"), ["r4", "r5"]],
    [c("b", "is_not_null"), ["r1", "r2", "r3", "r6"]],
  ],
  "datetime, year, text, json": [
    [c("ts", "gt", "2020-01-01T00:00:00Z"), ["r1", "r2"]],
    [c("ts", "lt", "2021-01-01T00:00:00Z"), ["r1"]],
    [c("y", "gte", 2000), ["r6"]],
    [c("t", "contains", "ČAK", true), ["r3"]],
    [c("j", "is_not_null"), ["r4"]],
  ],
  groups: [
    [{ and: [c("n", "gt", 0), c("b", "eq", true)] }, ["r1", "r3"]],
    [{ or: [c("s", "eq", "Gama"), c("d", "lt", 0)] }, ["r3", "r4"]],
    [{ not: c("s", "eq", "Alfa") }, ["r2", "r3", "r4", "r6"]],
    [{ not: c("n", "not_in", []) }, []],
    [{ not: { or: [c("b", "eq", true), c("n", "lt", 0)] } }, ["r2"]],
    [{ and: [] }, ["r1", "r2", "r3", "r4", "r5", "r6"]],
    [{ or: [] }, []],
    [c("s", "eq", null), []],
    [c("n", "between", [null, 10]), []],
  ],
};

describe("filter compilation", () => {
  for (const [group, cases] of Object.entries(CASES)) {
    describe(group, () => {
      it.each(cases)("%j", async (filter, expected) => {
        expect(await tags(filter)).toEqual(expected);
        // The SQL compiler and the in-memory evaluator agree on every case.
        const inMemory = ROWS.filter((r) => evaluateFilter(filter, r)).map((r) => r.tag);
        expect(inMemory).toEqual(expected);
      });
    });
  }

  it("covers all 14 ops for string, integer, decimal, date and bool", () => {
    for (const group of ["string", "integer", "decimal", "date", "bool"]) {
      const ops = new Set((CASES[group] ?? []).map(([f]) => (f as { op: string }).op));
      expect(ops.size, group).toBe(14);
    }
  });

  it.each([
    [c("n", "gt", "abc"), "number"],
    [c("n", "eq", true), "number"],
    [c("dt", "eq", "15.01.2020"), "date"],
    [c("ts", "gt", "yesterday"), "datetime"],
    [c("b", "eq", "yes"), "true or false"],
    [c("s", "eq", { x: 1 }), "scalar"],
    [c("s", "in", "Alfa"), "array"],
    [c("n", "between", [1]), "[lo, hi]"],
    [c("s", "contains", ["a"]), "scalar"],
  ])("refuses a value of the wrong type: %j", async (filter, hint) => {
    const err = await rejectsWith(source.list({ filter }), "validation_error");
    expect(err.message).toContain(hint);
  });
});

it("compares datetimes as instants, whatever the offset they were written with", async () => {
  // r2 is 2021-06-01T00:00+02:00 = 2021-05-31T22:00Z.
  expect(await tags(c("ts", "lt", "2021-05-31T23:00:00Z"))).toEqual(["r1", "r2"]);
});

describe("typed ordering", () => {
  const order = async (field: string, dir: "asc" | "desc") =>
    (await source.list({ sort: [{ field, dir }], page: { limit: 100 } })).rows.map((r) => r.tag);

  it("orders integers numerically (10 after 9), nulls last both ways", async () => {
    expect(await order("n", "asc")).toEqual(["r6", "r4", "r1", "r2", "r3", "r5"]);
    expect(await order("n", "desc")).toEqual(["r3", "r2", "r1", "r4", "r6", "r5"]);
  });

  it("orders decimals, dates and bools by their type", async () => {
    expect(await order("d", "asc")).toEqual(["r3", "r4", "r1", "r2", "r6", "r5"]);
    // r1 and r6 share a date, r2 and r6 a bool: ties go by (random) id, so compare them as sets.
    const byDate = await order("dt", "desc");
    expect(byDate[0]).toBe("r2");
    expect(byDate.slice(1, 3).sort()).toEqual(["r1", "r6"]);
    expect(byDate.slice(-2).sort()).toEqual(["r4", "r5"]);
    const byBool = await order("b", "asc");
    expect(byBool.slice(0, 2).sort()).toEqual(["r2", "r6"]);
    expect(byBool.slice(2, 4).sort()).toEqual(["r1", "r3"]);
  });
});
