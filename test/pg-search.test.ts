// postgres_table answering the search box: a `tsvector` column matched with
// websearch_to_tsquery and ranked with ts_rank, under the row scope of two contexts.
import {
  type ListResponse,
  requestKind,
  SchemaDocSchema,
  UdcError,
  ViewConfigSchema,
} from "@jsudc/core";
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createDispatcher } from "../src/dispatcher.js";
import { decodeSearchCursor, type PostgresTableSearch, PostgresTableSource } from "../src/index.js";
import { CollectionRegistry } from "../src/registry.js";
import { rejectsWith, useTestDb } from "./helpers.js";

const handle = useTestDb();
const { db } = handle;

const schema = SchemaDocSchema.parse({
  version: "v1",
  fields: {
    tenant: { type: "string" },
    subject: { type: "string" },
    body: { type: "string" },
    received: { type: "integer" },
  },
});

// id, tenant, subject, body, received
const MAIL = [
  ["m1", "a", "Invoice for October", "please pay the invoice, the invoice is due", 1],
  ["m2", "a", "Lunch", "and an invoice", 2],
  ["m3", "a", "Meeting", "agenda attached", 3],
  ["m4", "b", "Invoice overdue", "the invoice", 4],
  ["m5", "b", "Holiday", "photos", 5],
  ["m6", "a", "Re: invoice", "attached", 6],
  ["m7", "a", "Lunch", "and an invoice", 7],
] as const;

beforeAll(async () => {
  await db.execute(sql`DROP TABLE IF EXISTS ps_mail`);
  await db.execute(sql`
    CREATE TABLE ps_mail (
      id text PRIMARY KEY, tenant text NOT NULL, subject text, body text, received integer,
      tsv tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', coalesce(subject, '')), 'A') ||
        setweight(to_tsvector('simple', coalesce(body, '')), 'B')) STORED)`);
  for (const [id, tenant, subject, body, received] of MAIL) {
    await db.execute(sql`
      INSERT INTO ps_mail (id, tenant, subject, body, received)
      VALUES (${id}, ${tenant}, ${subject}, ${body}, ${received})`);
  }
});

const fullText: PostgresTableSearch = {
  match: (q) => sql`tsv @@ websearch_to_tsquery('simple', ${q})`,
  rank: (q) => sql`ts_rank(tsv, websearch_to_tsquery('simple', ${q}))`,
};

function mail(search: PostgresTableSearch | null = fullText) {
  return new PostgresTableSource({
    db,
    schema,
    table: "ps_mail",
    idType: "text",
    ...(search ? { search } : {}),
  });
}

interface Ctx {
  tenant: string;
}

function dispatcherOver(source: PostgresTableSource) {
  const registry = new CollectionRegistry();
  registry.register({ name: "mail", source, view: ViewConfigSchema.parse({}) });
  const dispatcher = createDispatcher<Ctx>(registry, {
    log: { error: vi.fn() },
    rowScope: (ctx) => ({ field: "tenant", op: "eq", value: ctx.tenant }),
  });
  return async (tenant: string, payload: object) => {
    const res = await dispatcher.dispatch(
      { kind: requestKind("list"), id: "1", payload: { collection: "mail", ...payload } },
      { tenant },
    );
    return res;
  };
}

const ids = (res: ListResponse) => res.rows.map((r) => r.__meta.id);

describe("postgres_table with a search option", () => {
  const list = dispatcherOver(mail());
  const ok = async (tenant: string, payload: object) => {
    const res = await list(tenant, payload);
    expect(res.kind, JSON.stringify(res.payload)).toBe(`${requestKind("list")}.ok`);
    return res.payload as ListResponse;
  };

  it('reports search: "source"; without the option it does not', () => {
    expect(mail().capabilities.search).toBe("source");
    expect(mail(null).capabilities.search).toBeUndefined();
    expect("search" in mail(null).capabilities).toBe(false);
  });

  it("matches and ranks: relevance first, ties by id", async () => {
    const res = await ok("a", { search: "invoice" });
    // m1: subject and body twice; m6: the subject; m2 and m7: the body once, the same rank.
    expect(ids(res)).toEqual(["m1", "m6", "m2", "m7"]);
    expect(res.total).toBe(4);
    expect(res.next_cursor).toBeNull();
  });

  it("two contexts searching the same word each get only their own rows", async () => {
    const a = await ok("a", { search: "invoice", page: { limit: 100 } });
    const b = await ok("b", { search: "invoice", page: { limit: 100 } });
    expect(ids(a)).toEqual(["m1", "m6", "m2", "m7"]);
    expect(ids(b)).toEqual(["m4"]);
    expect(b.total).toBe(1);
    // The scope field itself is not shown (showScopeFields).
    expect(a.rows.every((r) => r.tenant === undefined)).toBe(true);
  });

  it("pages by offset, and by the cursor it hands out", async () => {
    const first = await ok("a", { search: "invoice", page: { limit: 2 } });
    expect(ids(first)).toEqual(["m1", "m6"]);
    expect(first.total).toBe(4);
    expect(first.next_cursor).not.toBeNull();
    expect(decodeSearchCursor(first.next_cursor as string)).toBe(2);
    const byOffset = await ok("a", { search: "invoice", page: { limit: 2, offset: 2 } });
    expect(ids(byOffset)).toEqual(["m2", "m7"]);
    expect(byOffset.next_cursor).toBeNull();
    const byCursor = await ok("a", {
      search: "invoice",
      page: { limit: 2, cursor: first.next_cursor },
    });
    expect(ids(byCursor)).toEqual(["m2", "m7"]);
    const past = await ok("a", { search: "invoice", page: { limit: 2, offset: 10 } });
    expect(past.rows).toEqual([]);
    expect(past.total).toBe(4);
  });

  it("ANDs the client's filter with the match", async () => {
    const res = await ok("a", {
      search: "invoice",
      filter: { field: "received", op: "gte", value: 2 },
    });
    expect(ids(res)).toEqual(["m6", "m2", "m7"]);
    expect(res.total).toBe(3);
  });

  it("with a sort, orders by it and pages by the keyset cursor as usual", async () => {
    const first = await ok("a", {
      search: "invoice",
      sort: [{ field: "received", dir: "desc" }],
      page: { limit: 3 },
    });
    expect(ids(first)).toEqual(["m7", "m6", "m2"]);
    const next = await ok("a", {
      search: "invoice",
      sort: [{ field: "received", dir: "desc" }],
      page: { limit: 3, cursor: first.next_cursor },
    });
    expect(ids(next)).toEqual(["m1"]);
  });

  it("takes the source's own query syntax (websearch: a minus excludes)", async () => {
    expect(ids(await ok("a", { search: "invoice -october" })).sort()).toEqual(["m2", "m6", "m7"]);
    expect(ids(await ok("a", { search: '"pay the invoice"' }))).toEqual(["m1"]);
  });

  it("no match is an empty page; a blank search is no search", async () => {
    const none = await ok("a", { search: "zebra" });
    expect(none.rows).toEqual([]);
    expect(none.total).toBe(0);
    const blank = await ok("a", { search: "   ", page: { limit: 100 } });
    expect(ids(blank)).toEqual(["m1", "m2", "m3", "m6", "m7"]);
  });

  it("keeps the text a parameter: quotes and SQL in it are only text", async () => {
    const res = await ok("a", { search: "'); DROP TABLE ps_mail; --" });
    expect(res.rows).toEqual([]);
    const still = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ps_mail`);
    expect(still.rows[0]?.n).toBe(MAIL.length);
  });

  it("without rank, matches and orders like any list (by id)", async () => {
    const source = mail({ match: fullText.match });
    expect(source.capabilities.search).toBe("source");
    const res = await source.list(
      { search: "invoice" },
      { ctx: null, collection: "mail", rowScope: { field: "tenant", op: "eq", value: "a" } },
    );
    expect(ids(res)).toEqual(["m1", "m2", "m6", "m7"]);
  });

  it("hands the host both the parameter and the text", async () => {
    const match = vi.fn((q, text: string) => {
      expect(text).toBe("lunch");
      return sql`tsv @@ to_tsquery('simple', ${q} || ':*')`;
    });
    const res = await mail({ match }).list({ search: "lunch" });
    expect(match).toHaveBeenCalled();
    expect(ids(res)).toEqual(["m2", "m7"]);
  });
});

describe("postgres_table without a search option", () => {
  it("refuses a search with unsupported_op, through the dispatcher", async () => {
    const list = dispatcherOver(mail(null));
    const res = await list("a", { search: "invoice" });
    expect(res.kind).toBe(`${requestKind("list")}.err`);
    expect((res.payload as { code: string }).code).toBe("unsupported_op");
    const plain = await list("a", { page: { limit: 100 } });
    expect((plain.payload as ListResponse).rows).toHaveLength(5);
  });

  it("refuses it when called directly too, never lists everything", async () => {
    const err = await rejectsWith(mail(null).list({ search: "invoice" }), "unsupported_op");
    expect(err).toBeInstanceOf(UdcError);
  });
});
