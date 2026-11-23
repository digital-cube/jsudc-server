// The SQLite dialect of the SQL compiler, on `node:sqlite` `:memory:`: the choices the
// jsonb suites (run against SQLite by the `sqlite` Vitest project) do not pin down by
// themselves — GLOB for case-sensitive text ops, ASCII-only lower(), the one ordering
// difference with evaluateFilter, the datetime form, booleans, integer row ids, the JSON
// list parameter and JSON arrays.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { evaluateFilter, type FilterNode, SchemaDocSchema, type SortKey } from "@jsudc/core";
import { type SQL, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  compileFilter,
  compileSort,
  cursorPredicate,
  decodeCursor,
  encodeCursor,
  escapeGlob,
  idParam,
  orderBy,
  sortKeyColumns,
  sqliteColumnResolver,
  sqliteDateTime,
  sqliteDialect,
  sqliteQuery,
} from "../src/index.js";
import { useTestDb } from "./helpers.js";

const schema = SchemaDocSchema.parse({
  version: "v1",
  fields: {
    name: { type: "string" },
    n: { type: "integer" },
    ok: { type: "bool" },
    at: { type: "datetime" },
    tags: { type: "string_array" },
  },
});

const resolve = sqliteColumnResolver({
  fields: {
    name: sql`name`,
    n: sql`n`,
    ok: sql`ok`,
    at: sql`at`,
    tags: sql`tags`,
  },
  id: sql`pk`,
});

interface Person {
  pk: number;
  name: string | null;
  n: number | null;
  ok: boolean | null;
  at: string | null;
  tags: unknown[] | null;
}

const PEOPLE: Person[] = [
  { pk: 1, name: "Ana", n: 3, ok: true, at: "2026-01-01T10:00:00Z", tags: ["a", "B"] },
  { pk: 2, name: "ana*", n: null, ok: false, at: "2026-01-01T11:30:00+02:00", tags: [] },
  { pk: 3, name: "x?y[z]", n: 10, ok: null, at: null, tags: null },
  { pk: 4, name: "ČAK", n: 3, ok: true, at: "2025-12-31T23:59:59.999Z", tags: ["č", 5] },
  { pk: 5, name: null, n: -1, ok: false, at: "2026-01-01T09:00Z", tags: ["50%", "a_b"] },
  { pk: 6, name: "Ana", n: 3, ok: false, at: "2026-01-01T10:00:00.000Z", tags: ["a"] },
];

function open(opts: { unicodeLower?: boolean } = {}): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  if (opts.unicodeLower) {
    db.function("lower", { deterministic: true }, (s) =>
      s === null ? null : String(s).toLowerCase(),
    );
  }
  db.exec(
    "CREATE TABLE people (pk INTEGER PRIMARY KEY, name TEXT, n INTEGER, ok INTEGER, at TEXT, tags TEXT)",
  );
  const insert = db.prepare("INSERT INTO people VALUES (?, ?, ?, ?, ?, ?)");
  for (const p of PEOPLE) {
    insert.run(
      p.pk,
      p.name,
      p.n,
      p.ok === null ? null : p.ok ? 1 : 0,
      p.at === null ? null : sqliteDateTime(p.at),
      p.tags === null ? null : JSON.stringify(p.tags),
    );
  }
  return db;
}

function all(db: DatabaseSync, q: SQL): Record<string, unknown>[] {
  const { sql: text, params } = sqliteQuery(q);
  return db.prepare(text).all(...(params as SQLInputValue[]));
}

/** The pks a filter selects, in pk order. */
function pks(db: DatabaseSync, filter: FilterNode): number[] {
  const where = compileFilter(filter, schema, resolve);
  return all(db, sql`SELECT pk FROM people WHERE ${where} ORDER BY pk`).map((r) => Number(r.pk));
}

/** The pks evaluateFilter selects (with `id` as the row id, as the compiler reads it). */
function inMemory(filter: FilterNode): number[] {
  return PEOPLE.map((p) => {
    const row: Record<string, unknown> = { id: String(p.pk) };
    for (const [k, v] of Object.entries(p)) if (k !== "pk" && v !== null) row[k] = v;
    return { pk: p.pk, row };
  })
    .filter(({ row }) => evaluateFilter(filter, row))
    .map(({ pk }) => pk);
}

describe("the SQL text", () => {
  it('has no Postgres in it: no casts, no ILIKE, no ANY, no COLLATE "C", no unnest or jsonb', () => {
    const filter: FilterNode = {
      and: [
        { field: "name", op: "contains", value: "a", case_insensitive: true },
        { field: "name", op: "starts_with", value: "A" },
        { field: "n", op: "in", value: [1, 2] },
        { field: "n", op: "not_in", value: [3] },
        { field: "ok", op: "eq", value: true },
        { field: "at", op: "gt", value: "2026-01-01T00:00:00+01:00" },
        { field: "tags", op: "in", value: ["a"] },
        { field: "id", op: "in", value: ["1"] },
        { field: "name", op: "eq", value: null },
      ],
    };
    const terms = compileSort([{ field: "name" }, { field: "n", dir: "desc" }], schema, resolve);
    const q = sqliteQuery(
      sql`SELECT ${sortKeyColumns(terms, resolve)} FROM people WHERE ${compileFilter(filter, schema, resolve)} AND ${cursorPredicate(terms, ["Ana", null], "7", resolve)} ORDER BY ${orderBy(terms, resolve)}`,
    );
    expect(q.sql).not.toMatch(/::|ILIKE|ANY\(|ALL\(|COLLATE "C"|unnest|jsonb|\$\d/);
    expect(q.sql).toContain("GLOB ?");
    expect(q.sql).toContain("lower(?) ESCAPE '\\'");
    expect(q.sql).toContain("IN (SELECT value FROM json_each(?))");
    expect(q.sql).toContain('CAST((name COLLATE BINARY) AS TEXT) AS "__k0"');
    expect(q.sql).toContain("NULLS LAST");
    // Values bound in JS form: a boolean as 1, a datetime normalised to UTC, a list as JSON, the id as a number.
    expect(q.params).toContain(1);
    expect(q.params).toContain("2025-12-31T23:00:00.000Z");
    expect(q.params).toContain("[1,2]");
    expect(q.params).toContain('["a"]');
    expect(q.params).toContain(7);
  });

  it("renders with drizzle's SQLite renderer: ? placeholders, no database object", () => {
    expect(sqliteQuery(sql`SELECT ${sql.identifier("a b")} WHERE x = ${"v"} AND y = ${2}`)).toEqual(
      {
        sql: 'SELECT "a b" WHERE x = ? AND y = ?',
        params: ["v", 2],
      },
    );
  });

  it("binds a row id by its type", () => {
    expect(sqliteQuery(idParam("42", "integer", sqliteDialect)).params).toEqual([42]);
    expect(sqliteQuery(idParam("9223372036854775807", "integer", sqliteDialect)).params).toEqual([
      9223372036854775807n,
    ]);
    expect(sqliteQuery(idParam("a-b", "uuid", sqliteDialect)).params).toEqual(["a-b"]);
  });
});

describe("filters agree with evaluateFilter", () => {
  const db = open({ unicodeLower: true });
  it.each<FilterNode>([
    { field: "name", op: "eq", value: "Ana" },
    { field: "name", op: "eq", value: "ana", case_insensitive: true },
    { field: "name", op: "gt", value: "B" },
    { field: "name", op: "lt", value: "b", case_insensitive: true },
    { field: "n", op: "between", value: [0, 5] },
    { field: "n", op: "in", value: [3, null, 10] },
    { field: "n", op: "not_in", value: [3] },
    { not: { field: "n", op: "not_in", value: [] } },
    { field: "n", op: "contains", value: "-" },
    { field: "ok", op: "eq", value: true },
    { field: "ok", op: "neq", value: true },
    { field: "ok", op: "in", value: [false] },
    { field: "ok", op: "contains", value: "ru" },
    { field: "ok", op: "gt", value: false },
    { field: "tags", op: "in", value: ["b"], case_insensitive: true },
    { field: "tags", op: "in", value: ["5"] },
    { field: "tags", op: "not_in", value: ["a"] },
    { not: { field: "tags", op: "not_in", value: ["a"] } },
    { field: "tags", op: "contains", value: "%" },
    { field: "tags", op: "ends_with", value: "_B", case_insensitive: true },
    { field: "tags", op: "is_null" },
    { field: "id", op: "in", value: ["2", "4", null] },
    { field: "id", op: "not_in", value: ["1"] },
    { field: "id", op: "eq", value: 3 },
  ])("%j", (filter) => {
    expect(pks(db, filter)).toEqual(inMemory(filter));
  });
});

describe("text ops", () => {
  const db = open({ unicodeLower: true });

  it("a case-sensitive one is GLOB: SQLite's LIKE would ignore ASCII case", () => {
    expect(pks(db, { field: "name", op: "starts_with", value: "an" })).toEqual([2]);
    expect(pks(db, { field: "name", op: "starts_with", value: "An" })).toEqual([1, 6]);
    // The same pattern through LIKE: both cases.
    expect(all(db, sql`SELECT pk FROM people WHERE name LIKE 'an%' ORDER BY pk`)).toHaveLength(3);
  });

  it.each([
    ["*", [2]],
    ["?", [3]],
    ["[z]", [3]],
    ["[", [3]],
    ["y[", [3]],
  ])("GLOB metacharacters match literally: contains %j", (value, expected) => {
    const filter: FilterNode = { field: "name", op: "contains", value };
    expect(pks(db, filter)).toEqual(expected);
    expect(inMemory(filter)).toEqual(expected);
  });

  it("escapeGlob brackets * ? and [", () => {
    expect(escapeGlob("a*b?c[d]e")).toBe("a[*]b[?]c[[]d]e");
  });

  it("a case-insensitive one is lower(x) LIKE lower(?) ESCAPE '\\', LIKE metacharacters literal", () => {
    const filter: FilterNode = {
      field: "name",
      op: "contains",
      value: "A*",
      case_insensitive: true,
    };
    expect(pks(db, filter)).toEqual([2]);
    const tags: FilterNode = { field: "tags", op: "contains", value: "0%", case_insensitive: true };
    expect(pks(db, tags)).toEqual([5]);
  });
});

describe("case folding is SQL lower()", () => {
  const filter: FilterNode = {
    field: "name",
    op: "contains",
    value: "čak",
    case_insensitive: true,
  };

  it("SQLite's built-in lower() folds ASCII only: 'ČAK' is missed where evaluateFilter finds it", () => {
    expect(inMemory(filter)).toEqual([4]);
    expect(pks(open(), filter)).toEqual([]);
    expect(pks(open(), { ...filter, value: "ana" })).toEqual([1, 2, 6]);
  });

  it("a host that registers a Unicode lower() (or loads ICU) gets evaluateFilter's answer", () => {
    expect(pks(open({ unicodeLower: true }), filter)).toEqual([4]);
  });
});

describe("text order is code point order", () => {
  // U+FF01 (！) and U+1F600 (😀): by code point ！ comes first; JavaScript's `<` compares
  // UTF-16 code units and puts 😀's high surrogate (U+D83D) first.
  const values = ["\u{1F600}", "！", "z", "Z", "é"];
  const codePoint = ["Z", "z", "é", "！", "\u{1F600}"];
  const { db: pg } = useTestDb();

  it("SQLite's BINARY collation sorts UTF-8 text by code point", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE s (v TEXT)");
    for (const v of values) db.prepare("INSERT INTO s VALUES (?)").run(v);
    const order = all(db, sql`SELECT v FROM s ORDER BY ${sqliteDialect.codePointOrder(sql`v`)}`);
    expect(order.map((r) => r.v)).toEqual(codePoint);
  });

  it('the one known difference with evaluateFilter: a character above U+FFFF against U+E000–U+FFFF — Postgres\'s COLLATE "C" has it too', async () => {
    const byJs = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(byJs).toEqual(["Z", "z", "é", "\u{1F600}", "！"]);
    expect(byJs).not.toEqual(codePoint);
    const res = await pg.execute<{ v: string }>(
      sql`SELECT v FROM unnest(${sql.param(values)}::text[]) AS u(v) ORDER BY v COLLATE "C"`,
    );
    expect(res.rows.map((r) => r.v)).toEqual(codePoint);
  });
});

describe("datetimes", () => {
  it.each([
    ["2021-06-01T00:00:00+02:00", "2021-05-31T22:00:00.000Z"],
    ["2021-06-01T00:00:00-0130", "2021-06-01T01:30:00.000Z"],
    ["2021-06-01T00:00Z", "2021-06-01T00:00:00.000Z"],
    ["2021-06-01T00:00:00", "2021-06-01T00:00:00.000Z"],
    ["2021-06-01T00:00:00.1Z", "2021-06-01T00:00:00.100Z"],
    ["2021-06-01T00:00:00.123456789Z", "2021-06-01T00:00:00.123Z"],
    ["0050-03-01T00:00:00Z", "0050-03-01T00:00:00.000Z"],
    ["not a datetime", "not a datetime"],
  ])("sqliteDateTime(%j) = %j", (input, expected) => {
    expect(sqliteDateTime(input)).toBe(expected);
  });

  it("compare as instants: a filter value in another offset is normalised before it is bound", () => {
    const db = open();
    // pk 2 is 2026-01-01T09:30Z; 10:00+01:00 is 09:00Z.
    expect(pks(db, { field: "at", op: "lt", value: "2026-01-01T10:00:00+01:00" })).toEqual([4]);
    expect(pks(db, { field: "at", op: "eq", value: "2026-01-01T10:00:00+01:00" })).toEqual([5]);
    expect(pks(db, { field: "at", op: "eq", value: "2026-01-01T09:30Z" })).toEqual([2]);
    expect(pks(db, { field: "at", op: "in", value: ["2026-01-01T12:00:00+02:00"] })).toEqual([
      1, 6,
    ]);
  });
});

describe("keyset paging over an integer row id", () => {
  const db = open();

  function list(sort: SortKey[], limit: number, cursor?: string | null) {
    const terms = compileSort(sort, schema, resolve);
    const after = cursor ? decodeCursor(cursor, terms.length, resolve.idType) : null;
    const where = after ? cursorPredicate(terms, after.values, after.id, resolve) : sql`TRUE`;
    const keys = terms.length > 0 ? sql`, ${sortKeyColumns(terms, resolve)}` : sql``;
    const rows = all(
      db,
      sql`SELECT pk${keys} FROM people WHERE ${where} ORDER BY ${orderBy(terms, resolve)} LIMIT ${limit + 1}`,
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const next =
      rows.length > limit && last
        ? encodeCursor([
            ...terms.map((_, i) => (last[`__k${i}`] as string | null) ?? null),
            String(last.pk),
          ])
        : null;
    return { pks: page.map((r) => Number(r.pk)), next };
  }

  it.each<[string, SortKey[]]>([
    ["id", []],
    ["n asc", [{ field: "n" }]],
    ["n desc", [{ field: "n", dir: "desc" }]],
    ["ok desc, n asc (mixed)", [{ field: "ok", dir: "desc" }, { field: "n" }]],
    ["name asc, at desc (mixed)", [{ field: "name" }, { field: "at", dir: "desc" }]],
    [
      "at desc, name desc",
      [
        { field: "at", dir: "desc" },
        { field: "name", dir: "desc" },
      ],
    ],
  ])("a one-row walk equals the whole list, through the NULL tails: %s", (_, sort) => {
    const whole = list(sort, 100).pks;
    expect(whole).toHaveLength(PEOPLE.length);
    const walked: number[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
      const page = list(sort, 1, cursor);
      walked.push(...page.pks);
      cursor = page.next;
      if (!cursor) break;
    }
    expect(walked).toEqual(whole);
  });

  it("orders NULLS LAST both ways, ties by id", () => {
    expect(list([{ field: "n" }], 100).pks).toEqual([5, 1, 4, 6, 3, 2]);
    expect(list([{ field: "n", dir: "desc" }], 100).pks).toEqual([3, 1, 4, 6, 5, 2]);
  });
});
