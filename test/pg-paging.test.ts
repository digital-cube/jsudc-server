import type { FilterNode, Row, SortKey } from "@jsudc/core";
import { beforeAll, describe, expect, it } from "vitest";
import { seedCollection } from "../src/seed.js";
import { decodeCursor, encodeCursor } from "../src/sources/cursor.js";
import type { PostgresJsonbSource } from "../src/sources/postgres-jsonb.js";
import {
  companiesSchemaJson,
  companiesSeed,
  companiesSource,
  ids,
  insertRows,
  rejectsWith,
  resetTables,
  useTestDb,
} from "./helpers.js";

const { db } = useTestDb();
let source: PostgresJsonbSource;

beforeAll(async () => {
  await resetTables(db);
  await seedCollection(db, {
    table: "companies",
    schema: companiesSchemaJson,
    rows: companiesSeed,
  });
  // Rows with missing sort fields, so the NULLS LAST tails are paged through too.
  await insertRows(db, [
    { name: "Bez Grada DOO", employees: 10 },
    { name: "Bez Broja DOO", city: "Beograd" },
    { name: "Prazna DOO" },
  ]);
  source = companiesSource(db, 10);
});

async function walkCursor(sort: SortKey[], limit: number, filter?: FilterNode): Promise<Row[]> {
  const out: Row[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 300; pages++) {
    const res = await source.list({ filter, sort, page: { limit, cursor } });
    out.push(...res.rows);
    if (res.next_cursor === null) return out;
    expect(res.rows).toHaveLength(limit);
    cursor = res.next_cursor;
  }
  throw new Error("cursor walk did not end");
}

async function walkOffset(sort: SortKey[], limit: number, filter?: FilterNode): Promise<Row[]> {
  const out: Row[] = [];
  for (let offset = 0; ; offset += limit) {
    const res = await source.list({ filter, sort, page: { limit, offset } });
    out.push(...res.rows);
    if (res.rows.length < limit) return out;
  }
}

const SORTS: [string, SortKey[]][] = [
  ["no sort (id)", []],
  ["employees asc", [{ field: "employees", dir: "asc" }]],
  ["employees desc", [{ field: "employees", dir: "desc" }]],
  ["city, name asc", [{ field: "city" }, { field: "name" }]],
  [
    "city, employees desc",
    [
      { field: "city", dir: "desc" },
      { field: "employees", dir: "desc" },
    ],
  ],
  ["active desc (many ties)", [{ field: "active", dir: "desc" }]],
  ["founded asc", [{ field: "founded" }]],
  ["mixed: city asc, employees desc", [{ field: "city" }, { field: "employees", dir: "desc" }]],
  ["mixed: active desc, revenue asc", [{ field: "active", dir: "desc" }, { field: "revenue_eur" }]],
];

describe("paging", () => {
  it.each(SORTS)("cursor and offset pages give the same sequence: %s", async (_, sort) => {
    const all = await source.list({ sort, page: { limit: 1000 } });
    expect(all.rows).toHaveLength(33);
    expect(all.next_cursor).toBeNull();
    const byCursor = await walkCursor(sort, 17);
    const byOffset = await walkOffset(sort, 17);
    expect(ids(byCursor)).toEqual(ids(all.rows));
    expect(ids(byOffset)).toEqual(ids(all.rows));
  });

  it.each([
    ["employees asc", [{ field: "employees", dir: "asc" }]],
    [
      "city desc, employees desc",
      [
        { field: "city", dir: "desc" },
        { field: "employees", dir: "desc" },
      ],
    ],
    ["mixed: city asc, employees desc", [{ field: "city" }, { field: "employees", dir: "desc" }]],
  ] as [string, SortKey[]][])(
    "a one-row cursor walk crosses the NULL tails: %s",
    async (_, sort) => {
      // Every row becomes a cursor once, including rows whose sort value is missing.
      const all = await source.list({ sort, page: { limit: 1000 } });
      expect(ids(await walkCursor(sort, 1))).toEqual(ids(all.rows));
    },
  );

  it("pages a filtered list the same way, and total honours the filter", async () => {
    const filter: FilterNode = { field: "city", op: "eq", value: "Beograd" };
    const sort: SortKey[] = [{ field: "employees", dir: "desc" }];
    const expected = companiesSeed.filter((r) => r.city === "Beograd").length + 1;
    const first = await source.list({ filter, sort, page: { limit: 5 } });
    expect(first.total).toBe(expected);
    expect(first.rows).toHaveLength(5);
    const walked = await walkCursor(sort, 7, filter);
    expect(walked).toHaveLength(expected);
    expect(walked.every((r) => r.city === "Beograd")).toBe(true);
    // The cursor narrows the rows, never the total.
    const second = await source.list({
      filter,
      sort,
      page: { limit: 5, cursor: first.next_cursor },
    });
    expect(second.total).toBe(expected);
  });

  it("orders numerically: employees desc is a non-increasing sequence of numbers", async () => {
    const res = await source.list({
      sort: [{ field: "employees", dir: "desc" }],
      page: { limit: 1000 },
    });
    const values = res.rows.map((r) => r.employees).filter((v) => v !== undefined) as number[];
    expect(values).toEqual([...values].sort((a, b) => b - a));
    // NULLS LAST even in descending order.
    expect(res.rows.at(-1)?.employees).toBeUndefined();
  });

  it("next_cursor is null on a short page and on the exact last page", async () => {
    const short = await source.list({ page: { limit: 1000 } });
    expect(short.next_cursor).toBeNull();
    const exact = await source.list({ page: { limit: 3, offset: 30 } });
    expect(exact.rows).toHaveLength(3);
    expect(exact.next_cursor).toBeNull();
    const more = await source.list({ page: { limit: 3, offset: 29 } });
    expect(more.next_cursor).not.toBeNull();
  });

  it("uses the view's default page size when no limit is given", async () => {
    const res = await source.list({});
    expect(res.rows).toHaveLength(10);
    expect(res.total).toBe(33);
  });

  it("serializes rows flat with __meta", async () => {
    const [row] = (await source.list({ sort: [{ field: "pib" }], page: { limit: 1 } })).rows;
    expect(row).toEqual({
      __meta: { id: expect.stringMatching(/^[0-9a-f-]{36}$/), version: 1 },
      ...companiesSeed.toSorted((a, b) => ((a.pib as string) < (b.pib as string) ? -1 : 1))[0],
    });
  });

  it("refuses a malformed cursor", async () => {
    await rejectsWith(source.list({ page: { cursor: "not-base64-json" } }), "validation_error");
    // Right encoding, wrong arity for the sort.
    const wrong = encodeCursor(["1", "2", "00000000-0000-0000-0000-000000000000"]);
    await rejectsWith(
      source.list({ sort: [{ field: "employees" }], page: { cursor: wrong } }),
      "validation_error",
    );
    const badId = encodeCursor(["1", "x'; drop table companies"]);
    await rejectsWith(
      source.list({ sort: [{ field: "employees" }], page: { cursor: badId } }),
      "validation_error",
    );
  });
});

describe("cursor codec", () => {
  it("round-trips through base64url JSON", () => {
    const parts = ["Beograd", null, "3f1c0b8e-1111-4222-8333-444455556666"];
    const c = encodeCursor(parts);
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(Buffer.from(c, "base64url").toString())).toEqual(parts);
    expect(decodeCursor(c, 2)).toEqual({ values: ["Beograd", null], id: parts[2] });
  });
});
