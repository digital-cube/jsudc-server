// The scenarios of pg-mutate, pg-paging and pg-allowlist on a `sqlite_table` `companies`
// (the fixture collection's schema and seed, one typed column per field), on `:memory:` and
// on a file. What pg-mutate checks of the jsonb store alone (schema revisions, updated_at)
// has no counterpart here.
import { randomUUID } from "node:crypto";
import type { FilterNode, Row, SortKey } from "@jsudc/core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeCursor, encodeCursor } from "../../src/sources/cursor.js";
import {
  type SqliteDatabase,
  SqliteTableSource,
  type SqliteTableSourceOptions,
} from "../../src/sqlite.js";
import {
  companiesSchema,
  companiesSeed,
  createTableSql,
  ids,
  openDb,
  rejectsWith,
  WHERES,
} from "./helpers.js";

const MISSING = "00000000-0000-4000-8000-000000000000";

function companies(db: SqliteDatabase, extra: Partial<SqliteTableSourceOptions> = {}) {
  return new SqliteTableSource({
    db,
    schema: companiesSchema,
    table: "companies",
    versionColumn: "version",
    ...extra,
  });
}

/** A fresh `companies` table holding `rows`, written through the source (validated). */
async function seeded(db: SqliteDatabase, rows: Record<string, unknown>[]) {
  await db.exec(`DROP TABLE IF EXISTS companies; ${createTableSql("companies", companiesSchema)}`);
  const source = companies(db);
  for (const row of rows) await source.mutate({ op: "insert", row });
}

describe.each(WHERES)("sqlite_table companies on %s", (where) => {
  describe("mutate (pg-mutate)", () => {
    let db: SqliteDatabase;
    let source: SqliteTableSource;

    beforeEach(async () => {
      db = openDb(where);
      await seeded(db, companiesSeed.slice(0, 20));
      source = companies(db);
    });

    async function firstRow() {
      const [row] = (await source.list({ sort: [{ field: "pib" }], page: { limit: 1 } })).rows;
      if (!row) throw new Error("no rows");
      return row;
    }

    it("insert writes data at version 1 and returns the row", async () => {
      const row = await source.mutate({
        op: "insert",
        row: {
          name: "Nova Firma DOO",
          city: "Pirot",
          employees: 3,
          __meta: { id: "forged", version: 9 },
        },
      });
      expect(row).toEqual({
        __meta: { id: expect.stringMatching(/^[0-9a-f-]{36}$/), version: 1 },
        name: "Nova Firma DOO",
        city: "Pirot",
        employees: 3,
      });
      expect(await source.read(row.__meta.id)).toEqual(row);
      expect((await source.list({})).total).toBe(21);
    });

    it("insert refuses an invalid row with every problem listed", async () => {
      const err = await rejectsWith(
        source.mutate({ op: "insert", row: { employees: -1, founded: "1.1.2000", extra: 1 } }),
        "validation_error",
      );
      expect(err.details?.problems).toEqual(
        expect.arrayContaining([
          { field: "employees", message: "must be >= 0" },
          { field: "founded", message: "must be a date (YYYY-MM-DD)" },
          { field: "extra", message: "unknown field" },
          { field: "name", message: "is required" },
        ]),
      );
      expect((await source.list({})).total).toBe(20);
    });

    it("update merges the patch and bumps the version", async () => {
      const before = await firstRow();
      const after = await source.mutate({
        op: "update",
        id: before.__meta.id,
        row: { employees: 4321, city: "Vranje" },
        expected_version: 1,
      });
      expect(after).toEqual({
        ...before,
        employees: 4321,
        city: "Vranje",
        __meta: { id: before.__meta.id, version: 2 },
      });
      const again = await source.mutate({
        op: "update",
        id: before.__meta.id,
        row: { active: false },
      });
      expect(again.__meta.version).toBe(3);
      expect(again.active).toBe(false);
    });

    it("update answers version_conflict with the current version and changes nothing", async () => {
      const row = await firstRow();
      await source.mutate({ op: "update", id: row.__meta.id, row: { city: "Niš" } });
      const err = await rejectsWith(
        source.mutate({
          op: "update",
          id: row.__meta.id,
          row: { city: "Sombor" },
          expected_version: 1,
        }),
        "version_conflict",
      );
      expect(err.details).toMatchObject({ current_version: 2, expected_version: 1 });
      expect(await source.read(row.__meta.id)).toMatchObject({
        city: "Niš",
        __meta: { version: 2 },
      });
    });

    it("lets exactly one of two concurrent edits of the same version win", async () => {
      const row = await firstRow();
      const results = await Promise.allSettled(
        ["Šabac", "Užice"].map((city) =>
          source.mutate({ op: "update", id: row.__meta.id, row: { city }, expected_version: 1 }),
        ),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(lost.reason.code).toBe("version_conflict");
      expect((await source.read(row.__meta.id)).__meta.version).toBe(2);
    });

    it("update validates the patch: types, unknown fields, required only when touched", async () => {
      const row = await firstRow();
      const err = await rejectsWith(
        source.mutate({ op: "update", id: row.__meta.id, row: { employees: "many", nope: 1 } }),
        "validation_error",
      );
      expect(err.details?.problems).toHaveLength(2);
      await rejectsWith(
        source.mutate({ op: "update", id: row.__meta.id, row: { name: "" } }),
        "validation_error",
      );
      await source.mutate({ op: "update", id: row.__meta.id, row: { city: "Pirot" } });
    });

    it("update needs an id and answers not_found for an unknown or malformed one", async () => {
      await rejectsWith(source.mutate({ op: "update", row: { city: "x" } }), "validation_error");
      await rejectsWith(
        source.mutate({ op: "update", id: MISSING, row: { city: "x" } }),
        "not_found",
      );
      await rejectsWith(
        source.mutate({ op: "update", id: "nope", row: { city: "x" } }),
        "not_found",
      );
    });

    it("delete returns the deleted row, then the id is gone", async () => {
      const row = await firstRow();
      expect(await source.mutate({ op: "delete", id: row.__meta.id })).toEqual(row);
      await rejectsWith(source.read(row.__meta.id), "not_found");
      await rejectsWith(source.mutate({ op: "delete", id: row.__meta.id }), "not_found");
      expect((await source.list({})).total).toBe(19);
    });

    it("delete honours expected_version and needs an id", async () => {
      const row = await firstRow();
      await rejectsWith(
        source.mutate({ op: "delete", id: row.__meta.id, expected_version: 5 }),
        "version_conflict",
      );
      await rejectsWith(source.mutate({ op: "delete" }), "validation_error");
    });

    it("read answers not_found for an unknown or malformed id", async () => {
      await rejectsWith(source.read(MISSING), "not_found");
      await rejectsWith(source.read("1; select 1"), "not_found");
    });
  });

  describe("paging (pg-paging)", () => {
    let db: SqliteDatabase;
    let source: SqliteTableSource;

    beforeAll(async () => {
      db = openDb(where);
      await seeded(db, [
        ...companiesSeed,
        // Rows with missing sort fields, so the NULLS LAST tails are paged through too.
        { name: "Bez Grada DOO", employees: 10 },
        { name: "Bez Broja DOO", city: "Beograd" },
        { name: "Prazna DOO" },
      ]);
      source = companies(db, { pageSizeDefault: 10 });
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

    async function walkOffset(sort: SortKey[], limit: number): Promise<Row[]> {
      const out: Row[] = [];
      for (let offset = 0; ; offset += limit) {
        const res = await source.list({ sort, page: { limit, offset } });
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
      ["lat desc (decimal)", [{ field: "lat", dir: "desc" }]],
      [
        "mixed: active desc, revenue asc",
        [{ field: "active", dir: "desc" }, { field: "revenue_eur" }],
      ],
    ];

    it.each(SORTS)("cursor and offset pages give the same sequence: %s", async (_, sort) => {
      const all = await source.list({ sort, page: { limit: 1000 } });
      expect(all.rows).toHaveLength(33);
      expect(all.next_cursor).toBeNull();
      expect(ids(await walkCursor(sort, 17))).toEqual(ids(all.rows));
      expect(ids(await walkOffset(sort, 17))).toEqual(ids(all.rows));
    });

    it.each([
      ["employees asc", [{ field: "employees", dir: "asc" }]],
      ["mixed: city asc, employees desc", [{ field: "city" }, { field: "employees", dir: "desc" }]],
    ] as [string, SortKey[]][])(
      "a one-row cursor walk crosses the NULL tails: %s",
      async (_, sort) => {
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
      const second = await source.list({
        filter,
        sort,
        page: { limit: 5, cursor: first.next_cursor },
      });
      expect(second.total).toBe(expected);
    });

    it("orders numerically, NULLS LAST even in descending order", async () => {
      const res = await source.list({
        sort: [{ field: "employees", dir: "desc" }],
        page: { limit: 1000 },
      });
      const values = res.rows.map((r) => r.employees).filter((v) => v !== undefined) as number[];
      expect(values).toEqual([...values].sort((a, b) => b - a));
      expect(res.rows.at(-1)?.employees).toBeUndefined();
    });

    it("next_cursor is null on a short page and on the exact last page", async () => {
      expect((await source.list({ page: { limit: 1000 } })).next_cursor).toBeNull();
      const exact = await source.list({ page: { limit: 3, offset: 30 } });
      expect(exact.rows).toHaveLength(3);
      expect(exact.next_cursor).toBeNull();
      expect((await source.list({ page: { limit: 3, offset: 29 } })).next_cursor).not.toBeNull();
    });

    it("uses the default page size when no limit is given", async () => {
      const res = await source.list({});
      expect(res.rows).toHaveLength(10);
      expect(res.total).toBe(33);
    });

    it("serializes rows flat with __meta, in the wire protocol's JSON types", async () => {
      const [row] = (await source.list({ sort: [{ field: "pib" }], page: { limit: 1 } })).rows;
      expect(row).toEqual({
        __meta: { id: expect.stringMatching(/^[0-9a-f-]{36}$/), version: 1 },
        ...companiesSeed.toSorted((a, b) => ((a.pib as string) < (b.pib as string) ? -1 : 1))[0],
      });
      expect(typeof row?.active).toBe("boolean");
      expect(typeof row?.lat).toBe("number");
    });

    it("refuses a malformed cursor", async () => {
      await rejectsWith(source.list({ page: { cursor: "not-base64-json" } }), "validation_error");
      const wrong = encodeCursor(["1", "2", MISSING]);
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

    it("a cursor whose id is upper-case pages on as the lower-case one", async () => {
      const sort: SortKey[] = [{ field: "employees" }];
      const first = await source.list({ sort, page: { limit: 4 } });
      const { values, id } = decodeCursor(first.next_cursor as string, 1);
      const upper = encodeCursor([...values, id.toUpperCase()]);
      const a = await source.list({ sort, page: { limit: 4, cursor: first.next_cursor } });
      const b = await source.list({ sort, page: { limit: 4, cursor: upper } });
      expect(ids(b.rows)).toEqual(ids(a.rows));
    });

    it("total_count: false answers total null, without a count(*)", async () => {
      const noCount = companies(db, { totalCount: false });
      expect(noCount.capabilities.total_count).toBe(false);
      const res = await noCount.list({ page: { limit: 2 } });
      expect(res.total).toBeNull();
      expect(res.rows).toHaveLength(2);
    });

    it("defaultSort orders a list that asks for none, and pages by it", async () => {
      const sorted = companies(db, { defaultSort: [{ field: "employees", dir: "desc" }] });
      const explicit = await source.list({
        sort: [{ field: "employees", dir: "desc" }],
        page: { limit: 1000 },
      });
      const all = await sorted.list({ page: { limit: 1000 } });
      expect(ids(all.rows)).toEqual(ids(explicit.rows));
      const p1 = await sorted.list({ page: { limit: 20 } });
      const p2 = await sorted.list({ page: { limit: 20, cursor: p1.next_cursor } });
      expect(ids([...p1.rows, ...p2.rows])).toEqual(ids(explicit.rows));
      // A sort given by the request wins.
      const byName = await sorted.list({ sort: [{ field: "name" }], page: { limit: 3 } });
      expect(byName.rows.map((r) => r.name)).toEqual(
        companiesSeed
          .map((r) => r.name as string)
          .concat(["Bez Grada DOO", "Bez Broja DOO", "Prazna DOO"])
          .sort()
          .slice(0, 3),
      );
    });

    it("keepNulls serves a NULL column as null", async () => {
      const keep = companies(db, { keepNulls: true });
      const res = await keep.list({ filter: { field: "name", op: "eq", value: "Prazna DOO" } });
      expect(res.rows[0]).toMatchObject({ name: "Prazna DOO", city: null, employees: null });
    });

    it("search is not answered by the source: unsupported_op", async () => {
      await rejectsWith(source.list({ search: "Beograd" }), "unsupported_op");
      expect((await source.list({ search: "  " })).total).toBe(33);
    });
  });

  describe("field allowlist (pg-allowlist)", () => {
    let db: SqliteDatabase;
    const INJECTION = "x'); drop table companies; --";

    beforeAll(async () => {
      db = openDb(where);
      await seeded(db, [{ name: "Alfa DOO" }]);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    const BAD: [string, { filter?: FilterNode; sort?: SortKey[] }, string][] = [
      ["unknown field in filter", { filter: { field: "nope", op: "eq", value: 1 } }, "nope"],
      ["injection in filter", { filter: { field: INJECTION, op: "eq", value: 1 } }, INJECTION],
      [
        "injection nested in a group",
        {
          filter: {
            and: [
              { field: "name", op: "is_not_null" },
              { not: { field: INJECTION, op: "is_null" } },
            ],
          },
        },
        INJECTION,
      ],
      ["unknown field in sort", { sort: [{ field: "nope" }] }, "nope"],
      ["injection in sort", { sort: [{ field: INJECTION }] }, INJECTION],
      ["uppercase name (fails FIELD_NAME_RE)", { sort: [{ field: "Name" }] }, "Name"],
      ["__meta is not a field", { filter: { field: "__meta", op: "is_null" } }, "__meta"],
      [
        "a filterable: false field in a filter",
        { filter: { field: "pib", op: "eq", value: "1" } },
        "pib",
      ],
      ["a sortable: false field in a sort", { sort: [{ field: "mb" }] }, "mb"],
    ];

    it.each(BAD)("%s → validation_error, no statement runs", async (_, req, field) => {
      const source = companies(db, {
        fields: { pib: { filterable: false }, mb: { sortable: false } },
      });
      expect(source.notFilterable).toEqual(["pib"]);
      expect(source.notSortable).toEqual(["mb"]);
      const read = vi.spyOn(db, "read");
      const err = await rejectsWith(source.list(req), "validation_error");
      expect(err.details?.field).toBe(field);
      expect(err.message).toContain(JSON.stringify(field));
      expect(read).not.toHaveBeenCalled();
    });

    it("the table is intact afterwards, and the other field still filters and sorts", async () => {
      const source = companies(db, { fields: { pib: { filterable: false } } });
      const res = await source.list({
        filter: { field: "name", op: "eq", value: "Alfa DOO" },
        sort: [{ field: "pib" }],
      });
      expect(res.total).toBe(1);
    });
  });
});

describe("sqlite_table on a file other programs write", () => {
  it("caches nothing: a row another connection wrote is listed at once", async () => {
    const db = openDb("file");
    await seeded(db, [{ name: "One DOO" }]);
    const source = companies(db);
    expect((await source.list({})).total).toBe(1);
    await db.run({
      sql: "INSERT INTO companies (id, name) VALUES (?, 'Two DOO')",
      params: [randomUUID()],
    });
    expect((await source.list({})).total).toBe(2);
  });
});
