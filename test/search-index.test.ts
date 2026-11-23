// The search box answered outside the database: a host's index returns ids in relevance
// order, `withSearchIndex` loads exactly those rows under the scope and the filter. And a
// source that does not answer search refuses the text.
import {
  type DescribeResponse,
  type ListResponse,
  requestKind,
  SchemaDocSchema,
  ViewConfigSchema,
} from "@jsudc/core";
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createDispatcher } from "../src/dispatcher.js";
import {
  decodeSearchCursor,
  encodeSearchCursor,
  MemorySource,
  type SearchIndexQuery,
  type SearchIndexResult,
  type Source,
  withSearchIndex,
} from "../src/index.js";
import { PostgresTableSource } from "../src/postgres.js";
import { CollectionRegistry } from "../src/registry.js";
import { rejectsWith, useTestDb } from "./helpers.js";

const handle = useTestDb();
const { db } = handle;

const schema = SchemaDocSchema.parse({
  version: "v1",
  fields: {
    tenant: { type: "string" },
    subject: { type: "string" },
    folder: { type: "string" },
  },
});

// id, tenant, subject, folder
const MAIL = [
  ["m1", "a", "Invoice for October", "inbox"],
  ["m2", "a", "Lunch invoice", "archive"],
  ["m3", "a", "Invoice reminder", "inbox"],
  ["m4", "b", "Invoice overdue", "inbox"],
  ["m5", "b", "Holiday", "inbox"],
] as const;

const memory = () =>
  new MemorySource({
    schema,
    rows: MAIL.map(([id, tenant, subject, folder]) => ({
      __meta: { id },
      tenant,
      subject,
      folder,
    })),
  });

interface Ctx {
  tenant: string;
}

function dispatcherOver(source: Source) {
  const registry = new CollectionRegistry();
  registry.register({ name: "mail", source, view: ViewConfigSchema.parse({}) });
  const dispatcher = createDispatcher<Ctx>(registry, {
    log: { error: vi.fn() },
    rowScope: (ctx) => ({ field: "tenant", op: "eq", value: ctx.tenant }),
  });
  return async (tenant: string, action: string, payload: object) =>
    dispatcher.dispatch(
      { kind: requestKind(action), id: "1", payload: { collection: "mail", ...payload } },
      { tenant },
    );
}

const ids = (res: ListResponse) => res.rows.map((r) => r.__meta.id);

/** An index that answers every text with these ids (all tenants mixed), paged by the query. */
function index(order: string[], total?: number | null) {
  return vi.fn((q: SearchIndexQuery): SearchIndexResult => {
    const page = order.slice(q.page.offset, q.page.offset + q.page.limit);
    return total === undefined ? { ids: page } : { ids: page, total };
  });
}

describe("a source without the search capability", () => {
  it("refuses a search with unsupported_op instead of listing every row", async () => {
    const call = dispatcherOver(memory());
    const res = await call("a", "list", { search: "invoice" });
    expect(res.kind).toBe(`${requestKind("list")}.err`);
    expect(res.payload).toMatchObject({ code: "unsupported_op", details: { field: "search" } });
  });

  it("lists as before without a search, and with a blank one", async () => {
    const call = dispatcherOver(memory());
    for (const payload of [{}, { search: "" }, { search: "  " }]) {
      const res = await call("a", "list", payload);
      expect(res.kind).toBe(`${requestKind("list")}.ok`);
      expect(ids(res.payload as ListResponse).sort()).toEqual(["m1", "m2", "m3"]);
    }
  });

  it("does not report the capability", async () => {
    const call = dispatcherOver(memory());
    const res = await call("a", "describe", {});
    expect((res.payload as DescribeResponse).capabilities.search).toBeUndefined();
  });
});

describe("withSearchIndex over a source without native scope (memory)", () => {
  it('reports search: "source" and keeps the rest of the source', async () => {
    const inner = memory();
    const wrapped = withSearchIndex(inner, { search: index([]) });
    expect(wrapped.capabilities).toEqual({ ...inner.capabilities, search: "source" });
    expect(wrapped.enforcesRowScope).toBeUndefined();
    expect((await wrapped.read("m2")).subject).toBe("Lunch invoice");
    const row = await wrapped.mutate({ op: "update", id: "m2", row: { folder: "inbox" } });
    expect(row.folder).toBe("inbox");
    expect(typeof wrapped.reindex).toBe(typeof inner.reindex);
    expect(wrapped.readSource).toBeUndefined();
    const call = dispatcherOver(wrapped);
    const d = await call("a", "describe", {});
    expect((d.payload as DescribeResponse).capabilities.search).toBe("source");
  });

  it("returns the host's order, drops ids out of scope or unknown, passes the context", async () => {
    const search = index(["m3", "m4", "gone", "m1", "m2"], 5);
    const call = dispatcherOver(withSearchIndex(memory(), { search }));
    const res = await call("a", "list", { search: "  invoice  ", page: { limit: 10 } });
    expect(res.kind, JSON.stringify(res.payload)).toBe(`${requestKind("list")}.ok`);
    const body = res.payload as ListResponse;
    expect(ids(body)).toEqual(["m3", "m1", "m2"]);
    expect(body.total).toBe(5);
    expect(body.next_cursor).toBeNull();
    expect(search).toHaveBeenCalledTimes(1);
    const q = search.mock.calls[0]?.[0] as SearchIndexQuery;
    expect(q.text).toBe("invoice");
    expect(q.page).toEqual({ limit: 10, offset: 0 });
    expect(q.ctx).toEqual({ tenant: "a" });
    expect(q.collection).toBe("mail");
    expect(q.rowScope).toEqual({ field: "tenant", op: "eq", value: "a" });
    expect(q.sort).toBeUndefined();
  });

  it("the other context gets only its own rows from the same hits", async () => {
    const call = dispatcherOver(
      withSearchIndex(memory(), { search: index(["m3", "m4", "m1", "m5"]) }),
    );
    const res = await call("b", "list", { search: "invoice", page: { limit: 10 } });
    expect(ids(res.payload as ListResponse)).toEqual(["m4", "m5"]);
  });

  it("ANDs the client's filter, and hands it and the sort to the host", async () => {
    const search = index(["m3", "m2", "m1"]);
    const call = dispatcherOver(withSearchIndex(memory(), { search }));
    const filter = { field: "folder", op: "eq", value: "inbox" };
    const sort = [{ field: "subject", dir: "asc" }];
    const res = await call("a", "list", { search: "invoice", filter, sort });
    // The host's order is kept even with a sort: the host chose how to apply it.
    expect(ids(res.payload as ListResponse)).toEqual(["m3", "m1"]);
    const q = search.mock.calls[0]?.[0] as SearchIndexQuery;
    expect(q.sort).toEqual(sort);
    // The scope ANDed in, since memory does not enforce it itself.
    expect(JSON.stringify(q.filter)).toContain('"folder"');
    expect(JSON.stringify(q.filter)).toContain('"tenant"');
  });

  it("pages: the next cursor asks the host for the next offset, without and with a total", async () => {
    const order = ["m1", "m2", "m3"];
    for (const total of [undefined, 3]) {
      const search = index(order, total);
      const call = dispatcherOver(withSearchIndex(memory(), { search }));
      const first = (await call("a", "list", { search: "x", page: { limit: 2 } }))
        .payload as ListResponse;
      expect(ids(first)).toEqual(["m1", "m2"]);
      expect(first.total).toBe(total ?? null);
      expect(decodeSearchCursor(first.next_cursor as string)).toBe(2);
      const second = (
        await call("a", "list", { search: "x", page: { limit: 2, cursor: first.next_cursor } })
      ).payload as ListResponse;
      expect(ids(second)).toEqual(["m3"]);
      expect(second.next_cursor).toBeNull();
      expect(search.mock.calls[1]?.[0].page).toEqual({ limit: 2, offset: 2 });
      const byOffset = (await call("a", "list", { search: "x", page: { limit: 2, offset: 1 } }))
        .payload as ListResponse;
      expect(ids(byOffset)).toEqual(["m2", "m3"]);
    }
  });

  it("a page whose ids the scope hides comes back short, not refilled", async () => {
    const search = index(["m4", "m1", "m5", "m2"]);
    const call = dispatcherOver(withSearchIndex(memory(), { search }));
    const res = (await call("a", "list", { search: "x", page: { limit: 2 } }))
      .payload as ListResponse;
    expect(ids(res)).toEqual(["m1"]);
    expect(res.next_cursor).not.toBeNull();
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("cuts a host answer longer than the page, and dedupes ids", async () => {
    const search = vi.fn(() => ({ ids: ["m1", "m1", "m2", "m3"] }));
    const call = dispatcherOver(withSearchIndex(memory(), { search }));
    const res = (await call("a", "list", { search: "x", page: { limit: 3 } }))
      .payload as ListResponse;
    expect(ids(res)).toEqual(["m1", "m2"]);
    expect(decodeSearchCursor(res.next_cursor as string)).toBe(3);
  });

  it("no hits: an empty page, the source not asked", async () => {
    const inner = memory();
    const spy = vi.spyOn(inner, "list");
    const call = dispatcherOver(withSearchIndex(inner, { search: () => ({ ids: [], total: 0 }) }));
    const res = (await call("a", "list", { search: "zebra" })).payload as ListResponse;
    expect(res).toEqual({ rows: [], next_cursor: null, total: 0 });
    expect(spy).not.toHaveBeenCalled();
  });

  it("a list without search is the source's own; the host is not asked", async () => {
    const search = index(["m1"]);
    const call = dispatcherOver(withSearchIndex(memory(), { search }));
    const res = (await call("a", "list", { sort: [{ field: "subject" }] })).payload as ListResponse;
    expect(ids(res)).toEqual(["m1", "m3", "m2"]);
    expect(search).not.toHaveBeenCalled();
  });

  it("refuses a malformed cursor", async () => {
    const wrapped = withSearchIndex(memory(), { search: index(["m1"]) });
    await rejectsWith(
      wrapped.list({ search: "x", page: { limit: 2, cursor: "not-a-cursor" } }),
      "validation_error",
    );
    await rejectsWith(
      wrapped.list({
        search: "x",
        page: { limit: 2, cursor: Buffer.from("[1]").toString("base64url") },
      }),
      "validation_error",
    );
    expect(decodeSearchCursor(encodeSearchCursor(40))).toBe(40);
  });

  it("an error of the host's index is an internal error, not an empty page", async () => {
    const call = dispatcherOver(
      withSearchIndex(memory(), {
        search: () => Promise.reject(new Error("index down")),
      }),
    );
    const res = await call("a", "list", { search: "x" });
    expect(res.payload).toMatchObject({ code: "internal" });
  });
});

describe("withSearchIndex over postgres_table (the scope in its own statement)", () => {
  beforeAll(async () => {
    await db.execute(sql`DROP TABLE IF EXISTS psi_mail`);
    await db.execute(
      sql`CREATE TABLE psi_mail (id text PRIMARY KEY, tenant text NOT NULL, subject text, folder text)`,
    );
    for (const [id, tenant, subject, folder] of MAIL) {
      await db.execute(sql`INSERT INTO psi_mail VALUES (${id}, ${tenant}, ${subject}, ${folder})`);
    }
  });

  const table = () => new PostgresTableSource({ db, schema, table: "psi_mail", idType: "text" });

  it("loads exactly the hits in scope, in the host's order, one query", async () => {
    const inner = table();
    const spy = vi.spyOn(inner, "list");
    const search = index(["m4", "m2", "m3", "m1", "zzz"], 5);
    const wrapped = withSearchIndex(inner, { search });
    expect(wrapped.enforcesRowScope).toBe(true);
    const call = dispatcherOver(wrapped);
    const res = (await call("a", "list", { search: "invoice", page: { limit: 10 } }))
      .payload as ListResponse;
    expect(ids(res)).toEqual(["m2", "m3", "m1"]);
    expect(res.total).toBe(5);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      filter: { field: "id", op: "in", value: ["m4", "m2", "m3", "m1", "zzz"] },
      page: { limit: 5, offset: 0 },
    });
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ ctx: { tenant: "a" }, collection: "mail" });
    // The scope stays out of the filter: the source applies it from the context.
    expect(search.mock.calls[0]?.[0].filter).toBeUndefined();
    expect(search.mock.calls[0]?.[0].rowScope).toEqual({ field: "tenant", op: "eq", value: "a" });
  });

  it("the other context, the same hits: only its own", async () => {
    const call = dispatcherOver(withSearchIndex(table(), { search: index(["m4", "m2", "m5"]) }));
    const res = (await call("b", "list", { search: "invoice" })).payload as ListResponse;
    expect(ids(res)).toEqual(["m4", "m5"]);
  });

  it("with the client's filter", async () => {
    const call = dispatcherOver(withSearchIndex(table(), { search: index(["m2", "m3", "m1"]) }));
    const res = (
      await call("a", "list", {
        search: "invoice",
        filter: { field: "folder", op: "eq", value: "inbox" },
      })
    ).payload as ListResponse;
    expect(ids(res)).toEqual(["m3", "m1"]);
  });
});
