import {
  evaluateFilter,
  type FilterNode,
  type Row,
  SchemaDocSchema,
  type SortKey,
} from "@jsudc/core";
import { beforeAll, describe, expect, it } from "vitest";
import { seedCollection } from "../src/seed.js";
import { compareByType, queryRows, sortRows } from "../src/sources/array.js";
import { MemorySource } from "../src/sources/memory.js";
import {
  companiesSchema,
  companiesSchemaJson,
  companiesSeed,
  companiesSource,
  ids,
  rejectsWith,
  resetTables,
  useTestDb,
} from "./helpers.js";

// The books of the registry fixture, grown to exercise every comparison.
const booksSchema = SchemaDocSchema.parse({
  version: "v1",
  fields: {
    title: { type: "string", required: true },
    pages: { type: "integer" },
    rating: { type: "decimal" },
    published: { type: "datetime" },
    in_print: { type: "bool" },
  },
});

const BOOKS = [
  {
    __meta: { id: "b1" },
    title: "Zlatno runo",
    pages: 9,
    rating: 4.5,
    published: "2001-05-01T10:00:00+02:00",
    in_print: true,
  },
  {
    __meta: { id: "b2" },
    title: "Čovek",
    pages: 10,
    rating: null,
    published: "2001-05-01T07:30:00Z",
    in_print: false,
  },
  {
    __meta: { id: "b3" },
    title: "Anima",
    pages: 100,
    rating: 3,
    published: "1999-12-31T23:00:00Z",
    in_print: true,
  },
  {
    __meta: { id: "b4" },
    title: "beograd",
    pages: null,
    rating: 4.5,
    published: null,
    in_print: null,
  },
  {
    __meta: { id: "b5" },
    title: "Derviš",
    pages: 10,
    rating: 2.25,
    published: "2010-01-01T00:00:00Z",
    in_print: false,
  },
];

const books = new MemorySource({ schema: booksSchema, rows: BOOKS, pageSizeDefault: 2 });
const titles = (rows: Row[]) => rows.map((r) => r.title);

describe("ArraySource over the books", () => {
  it("compares by schema type", () => {
    expect(compareByType("integer", 9, 10)).toBeLessThan(0);
    expect(compareByType("decimal", "9.5", "10")).toBeLessThan(0);
    // One instant, two spellings; then by instant, not by text.
    expect(compareByType("datetime", "2001-05-01T10:00:00+02:00", "2001-05-01T08:00:00Z")).toBe(0);
    expect(
      compareByType("datetime", "2001-05-01T10:00:00+02:00", "2001-05-01T07:30:00Z"),
    ).toBeGreaterThan(0);
    expect(compareByType("bool", false, true)).toBeLessThan(0);
    expect(compareByType("string", "Čovek", "Derviš")).toBeLessThan(0);
  });

  it("sorts numbers numerically, nulls last both ways, ties by id", async () => {
    const asc = await books.list({ sort: [{ field: "pages" }], page: { limit: 10 } });
    expect(ids(asc.rows)).toEqual(["b1", "b2", "b5", "b3", "b4"]);
    const desc = await books.list({ sort: [{ field: "pages", dir: "desc" }], page: { limit: 10 } });
    expect(ids(desc.rows)).toEqual(["b3", "b2", "b5", "b1", "b4"]);
  });

  it("sorts datetimes by instant and strings with localeCompare", async () => {
    const byDate = await books.list({ sort: [{ field: "published" }], page: { limit: 10 } });
    expect(ids(byDate.rows)).toEqual(["b3", "b2", "b1", "b5", "b4"]);
    const byTitle = await books.list({ sort: [{ field: "title" }], page: { limit: 10 } });
    expect(titles(byTitle.rows)).toEqual(["Anima", "beograd", "Čovek", "Derviš", "Zlatno runo"]);
  });

  it("sorts by several keys", async () => {
    const res = await books.list({
      sort: [{ field: "rating", dir: "desc" }, { field: "title" }],
      page: { limit: 10 },
    });
    expect(ids(res.rows)).toEqual(["b4", "b1", "b3", "b5", "b2"]);
  });

  it("honours limit and offset with the default page size, total of the filter", async () => {
    const first = await books.list({ sort: [{ field: "title" }] });
    expect(first.rows).toHaveLength(2);
    expect(first.total).toBe(5);
    expect(first.next_cursor).toBeNull();
    const walked: Row[] = [];
    for (let offset = 0; offset < 5; offset += 2) {
      walked.push(
        ...(await books.list({ sort: [{ field: "title" }], page: { limit: 2, offset } })).rows,
      );
    }
    const all = await books.list({ sort: [{ field: "title" }], page: { limit: 100 } });
    expect(ids(walked)).toEqual(ids(all.rows));
    const filtered = await books.list({
      filter: { field: "in_print", op: "eq", value: false },
      page: { limit: 1 },
    });
    expect(filtered.rows).toHaveLength(1);
    expect(filtered.total).toBe(2);
  });

  it("refuses a cursor, as capabilities.paging says", async () => {
    expect(books.capabilities.paging).toEqual(["offset"]);
    await rejectsWith(books.list({ page: { limit: 2, cursor: "abc" } }), "unsupported_op");
  });

  it("filters exactly as evaluateFilter does", () => {
    const rows = BOOKS.map((b) => ({ ...b, __meta: { id: b.__meta.id, version: 1 } })) as Row[];
    const filters: FilterNode[] = [
      { field: "pages", op: "gt", value: 9 },
      { not: { field: "rating", op: "eq", value: 4.5 } },
      {
        or: [
          { field: "title", op: "starts_with", value: "b", case_insensitive: true },
          { field: "in_print", op: "is_null" },
        ],
      },
      {
        field: "published",
        op: "between",
        value: ["2000-01-01T00:00:00Z", "2005-01-01T00:00:00Z"],
      },
    ];
    for (const filter of filters) {
      const got = queryRows(rows, booksSchema, { filter, limit: 100 });
      const want = rows.filter((r) => evaluateFilter(filter, r));
      expect(ids(got.rows).sort(), JSON.stringify(filter)).toEqual(ids(want).sort());
      expect(got.total).toBe(want.length);
    }
  });
});

// --- against the Postgres source -------------------------------------------------

const { db } = useTestDb();
const pg = companiesSource(db);
let pgRows: Row[];
let memory: MemorySource;

beforeAll(async () => {
  await resetTables(db);
  await seedCollection(db, {
    table: "companies",
    schema: companiesSchemaJson,
    rows: companiesSeed,
  });
  pgRows = (await pg.list({ page: { limit: 1000 } })).rows;
  // The same rows, the same ids: the array source over what Postgres holds.
  memory = new MemorySource({ schema: companiesSchema, rows: pgRows });
});

// Text order is the database collation's in SQL and localeCompare's in memory, so the
// parity sorts are the typed ones: numbers, dates, bools (nulls last, ties by id in both).
const SORTS: SortKey[][] = [
  [{ field: "employees" }],
  [{ field: "revenue_eur", dir: "desc" }],
  [{ field: "founded" }],
  [{ field: "active", dir: "desc" }, { field: "employees" }],
  [{ field: "lat" }, { field: "lng", dir: "desc" }],
];
const FILTERS: (FilterNode | undefined)[] = [
  undefined,
  { field: "employees", op: "between", value: [10, 400] },
  {
    and: [
      { field: "active", op: "eq", value: true },
      { field: "founded", op: "gte", value: "2005-01-01" },
    ],
  },
  {
    or: [
      { field: "city", op: "in", value: ["Beograd", "Novi Sad"] },
      { field: "revenue_eur", op: "lt", value: 500000 },
    ],
  },
  { not: { field: "industry", op: "contains", value: "it", case_insensitive: true } },
];

describe("ArraySource vs PostgresJsonbSource on the companies seed", () => {
  const cases = FILTERS.flatMap((filter) => SORTS.map((sort) => [filter, sort] as const));
  it.each(cases.map(([f, s]) => [JSON.stringify(f ?? null), JSON.stringify(s), f, s] as const))(
    "filter %s sort %s: same rows, same order, same pages",
    async (_f, _s, filter, sort) => {
      for (const page of [{ limit: 1000 }, { limit: 17, offset: 0 }, { limit: 17, offset: 34 }]) {
        const [a, b] = await Promise.all([
          pg.list({ filter, sort, page }),
          memory.list({ filter, sort, page }),
        ]);
        expect(ids(b.rows)).toEqual(ids(a.rows));
        expect(b.total).toBe(a.total);
      }
    },
  );

  it("the parity filters discriminate", () => {
    const counts = FILTERS.map((f) => pgRows.filter((r) => evaluateFilter(f, r)).length);
    expect(counts.filter((n) => n > 0 && n < pgRows.length).length).toBeGreaterThanOrEqual(3);
  });

  it("sortRows leaves its input alone", () => {
    const before = ids(pgRows);
    sortRows(pgRows, [{ field: "employees", dir: "desc" }], companiesSchema);
    expect(ids(pgRows)).toEqual(before);
  });
});
