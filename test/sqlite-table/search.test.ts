// sqlite_table answering the search box with FTS5: an external-content FTS5 table kept by
// triggers in the database (sqliteFts5Sql), matched and ranked inside the source's own
// statement (sqliteFts5Search), under the row scope, with the client's filter and sort; the
// search box's text made into a MATCH expression FTS5 never refuses (fts5MatchExpression).
import { DatabaseSync } from "node:sqlite";
import { type ListResponse, requestKind, SchemaDocSchema, ViewConfigSchema } from "@jsudc/core";
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createDispatcher } from "../../src/dispatcher.js";
import { CollectionRegistry } from "../../src/registry.js";
import { decodeSearchCursor } from "../../src/sources/search.js";
import type { SourceContext } from "../../src/sources/source.js";
import {
  fts5MatchExpression,
  openNodeSqlite,
  type SqliteDatabase,
  type SqliteTableSearch,
  SqliteTableSource,
  type SqliteTableSourceOptions,
  sqliteFts5RebuildSql,
  sqliteFts5Search,
  sqliteFts5Sql,
  sqliteVersionTriggerSql,
} from "../../src/sqlite.js";
import { openDb, rejectsWith, tempFile } from "./helpers.js";

const schema = SchemaDocSchema.parse({
  version: "v1",
  fields: {
    ref: { type: "string" },
    owner: { type: "string" },
    title: { type: "string" },
    body: { type: "string" },
    received: { type: "integer" },
  },
});

// id, owner, title, body_text, received
const NOTES = [
  ["n1", "ana", "Invoice for October", "please pay the invoice, the invoice is due", 1],
  ["n2", "ana", "Lunch", "and an invoice", 2],
  ["n3", "ana", "Meeting", "agenda attached", 3],
  ["n4", "bob", "Overdue: invoice", "reminder", 4],
  ["n5", "bob", "Holiday", "photos", 5],
  ["n6", "ana", "Re: invoice", "attached", 6],
  ["n7", "ana", "Lunch", "and an invoice", 7],
  ["n8", "ana", "Čvarci i đuveč", "recept za ručak", 8],
] as const;

const TABLE_SQL = `
  CREATE TABLE note (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    title TEXT,
    body_text TEXT,
    received INTEGER,
    version INTEGER NOT NULL DEFAULT 1)`;

const FTS = { table: "note", columns: ["title", "body_text"] } as const;

/** The table, its rows, then the FTS5 table and its triggers (the rebuild indexes the rows). */
async function vault(db: SqliteDatabase): Promise<void> {
  await db.exec(`${TABLE_SQL};
    ${sqliteVersionTriggerSql({ table: "note", versionColumn: "version" })}`);
  await db.transaction((tx) => {
    for (const [id, owner, title, body, received] of NOTES) {
      tx.run(sql`INSERT INTO note (id, owner, title, body_text, received)
        VALUES (${id}, ${owner}, ${title}, ${body}, ${received})`);
    }
  });
  await db.exec(sqliteFts5Sql(FTS));
}

function notes(
  db: SqliteDatabase,
  search: SqliteTableSearch | null = sqliteFts5Search({ table: "note" }),
  extra: Partial<SqliteTableSourceOptions> = {},
): SqliteTableSource {
  return new SqliteTableSource({
    db,
    schema,
    table: "note",
    idType: "text",
    versionColumn: "version",
    fields: { ref: "id", body: "body_text" },
    ...(search ? { search } : {}),
    ...extra,
  });
}

const ids = (res: ListResponse) => res.rows.map((r) => r.__meta.id);
const scoped = (owner: string): SourceContext => ({
  ctx: { owner },
  collection: "notes",
  rowScope: { field: "owner", op: "eq", value: owner },
});

describe("fts5MatchExpression", () => {
  it("quotes each term, ANDs them, the last one a prefix", () => {
    expect(fts5MatchExpression("invoice")).toBe('"invoice"*');
    expect(fts5MatchExpression("  pay   the invo ")).toBe('"pay" AND "the" AND "invo"*');
    expect(fts5MatchExpression("pay invo", { prefix: false })).toBe('"pay" AND "invo"');
  });

  it("makes operators, column filters and quotes plain words", () => {
    expect(fts5MatchExpression("a OR")).toBe('"a" AND "OR"*');
    expect(fts5MatchExpression("NEAR(")).toBe('"NEAR("*');
    expect(fts5MatchExpression("title:x")).toBe('"title:x"*');
    expect(fts5MatchExpression('say "hi')).toBe('"say" AND """hi"*');
    expect(fts5MatchExpression("-draft")).toBe('"-draft"*');
  });

  it("leaves no expression for a text with no letter or digit", () => {
    for (const text of ["", "   ", '"', "*", "-", ":", "( )", '""', "^ + -"]) {
      expect(fts5MatchExpression(text), JSON.stringify(text)).toBeNull();
    }
  });

  it("keeps at most maxTerms terms", () => {
    expect(fts5MatchExpression("a b c d", { maxTerms: 2, prefix: false })).toBe('"a" AND "b"');
    expect(fts5MatchExpression(Array(100).fill("w").join(" "))?.split(" AND ")).toHaveLength(32);
  });
});

describe("sqliteFts5Sql", () => {
  it("is the virtual table, three triggers and a rebuild, and runs twice", async () => {
    const text = sqliteFts5Sql(FTS);
    expect(text).toContain(
      `CREATE VIRTUAL TABLE IF NOT EXISTS "note_fts" USING fts5("title", "body_text", content='note', content_rowid='rowid', tokenize='unicode61');`,
    );
    expect(text).toContain(`AFTER UPDATE OF "title", "body_text" ON "note"`);
    expect(text.match(/CREATE TRIGGER IF NOT EXISTS/g)).toHaveLength(3);
    expect(text.trim().endsWith(`INSERT INTO "note_fts"("note_fts") VALUES ('rebuild');`)).toBe(
      true,
    );
    const db = openDb("memory");
    await vault(db);
    await db.exec(sqliteFts5Sql(FTS));
    const res = await notes(db).list({ search: "invoice", page: { limit: 100 } });
    expect(res.total).toBe(5);
  });

  it("takes a tokenizer, an FTS5 table name and a trigger prefix", () => {
    const text = sqliteFts5Sql({
      ...FTS,
      fts: "note_search",
      tokenize: "unicode61 remove_diacritics 2",
      triggerPrefix: "nsx",
    });
    expect(text).toContain(`"note_search" USING fts5(`);
    expect(text).toContain(`tokenize='unicode61 remove_diacritics 2'`);
    expect(text).toContain(`"nsx_ai"`);
    expect(sqliteFts5RebuildSql({ ...FTS, fts: "note_search" })).toBe(
      `INSERT INTO "note_search"("note_search") VALUES ('rebuild');`,
    );
  });

  it("refuses a name, a column or a tokenizer that is not plain", () => {
    expect(() => sqliteFts5Sql({ table: "note; DROP", columns: ["title"] })).toThrow(/table/);
    expect(() => sqliteFts5Sql({ table: "note", columns: ['ti"tle'] })).toThrow(/column/);
    expect(() => sqliteFts5Sql({ table: "note", columns: [] })).toThrow(/columns/);
    expect(() => sqliteFts5Sql({ ...FTS, tokenize: "x'); DROP TABLE note; --" })).toThrow(
      /tokenize/,
    );
    expect(() => sqliteFts5Search({ table: "a.b.c" })).toThrow(/table/);
    expect(() => sqliteFts5Search({ table: "note", weights: [Number.NaN] })).toThrow(/weight/);
  });
});

describe("sqlite_table with an FTS5 search", () => {
  let db: SqliteDatabase;
  let source: SqliteTableSource;

  beforeAll(async () => {
    db = openDb("memory");
    await vault(db);
    source = notes(db);
  });

  it('reports search: "source"; without the option a search is refused', async () => {
    expect(source.capabilities.search).toBe("source");
    const plain = notes(db, null);
    expect("search" in plain.capabilities).toBe(false);
    const err = await rejectsWith(plain.list({ search: "invoice" }), "unsupported_op");
    expect(err.details).toMatchObject({ field: "search" });
  });

  it("matches and ranks: the best hit first, equal ranks by id", async () => {
    const res = await source.list({ search: "invoice" });
    // bm25 over the row: n1 has it three times; n4 and n6 once in three words, the same rank;
    // n2 and n7 once in four words, the same rank.
    expect(ids(res)).toEqual(["n1", "n4", "n6", "n2", "n7"]);
    expect(res.total).toBe(5);
    expect(res.next_cursor).toBeNull();
  });

  it("weights move a title hit ahead of a body hit", async () => {
    const titles = notes(db, sqliteFts5Search({ table: "note", weights: [10, 1] }));
    const res = await titles.list({ search: "invoice", sort: [], page: { limit: 100 } });
    expect(ids(res).slice(0, 4)).toEqual(expect.arrayContaining(["n1", "n4", "n6"]));
    expect(ids(res).slice(-2)).toEqual(["n2", "n7"]);
  });

  it("all terms must match; the last one is a prefix", async () => {
    expect(ids(await source.list({ search: "invoice due" }))).toEqual(["n1"]);
    expect(ids(await source.list({ search: "invo" }))).toEqual(["n1", "n4", "n6", "n2", "n7"]);
    const whole = notes(db, sqliteFts5Search({ table: "note", prefix: false }));
    expect((await whole.list({ search: "invo" })).total).toBe(0);
  });

  it("folds case and Latin diacritics (unicode61); đ is a letter of its own", async () => {
    expect(ids(await source.list({ search: "CVARCI đuvec" }))).toEqual(["n8"]);
    expect(ids(await source.list({ search: "rucak" }))).toEqual(["n8"]);
    expect((await source.list({ search: "duvec" })).total).toBe(0);
  });

  it("pages through the search cursor, and by offset alike", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: ListResponse = await source.list({
        search: "invoice",
        page: { limit: 2, ...(cursor ? { cursor } : {}) },
      });
      seen.push(...ids(res));
      expect(res.total).toBe(5);
      cursor = res.next_cursor;
      if (cursor) expect(decodeSearchCursor(cursor)).toBe(seen.length);
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(["n1", "n4", "n6", "n2", "n7"]);
    const second = await source.list({ search: "invoice", page: { limit: 2, offset: 2 } });
    expect(ids(second)).toEqual(["n6", "n2"]);
    await rejectsWith(
      source.list({ search: "invoice", page: { cursor: "not-a-cursor" } }),
      "validation_error",
    );
  });

  it("the row scope hides matching rows, in the page and in the total", async () => {
    const ana = await source.list({ search: "invoice", page: { limit: 100 } }, scoped("ana"));
    expect(ids(ana)).toEqual(["n1", "n6", "n2", "n7"]);
    expect(ana.total).toBe(4);
    const bob = await source.list({ search: "invoice" }, scoped("bob"));
    expect(ids(bob)).toEqual(["n4"]);
    expect(bob.total).toBe(1);
    expect((await source.list({ search: "holiday" }, scoped("ana"))).total).toBe(0);
  });

  it("the client's filter combines with the search, and with the scope", async () => {
    const res = await source.list(
      { search: "invoice", filter: { field: "received", op: "gte", value: 4 } },
      scoped("ana"),
    );
    expect(ids(res)).toEqual(["n6", "n7"]);
    expect(res.total).toBe(2);
  });

  it("the base where narrows a search too", async () => {
    const recent = notes(db, undefined, { where: "received > 5" });
    expect(ids(await recent.list({ search: "invoice" }))).toEqual(["n6", "n7"]);
  });

  it("with a sort the match is one more condition, paged by keyset", async () => {
    const first = await source.list({
      search: "invoice",
      sort: [{ field: "received", dir: "desc" }],
      page: { limit: 3 },
    });
    expect(ids(first)).toEqual(["n7", "n6", "n4"]);
    expect(first.next_cursor).not.toBeNull();
    const rest = await source.list({
      search: "invoice",
      sort: [{ field: "received", dir: "desc" }],
      page: { limit: 3, cursor: first.next_cursor as string },
    });
    expect(ids(rest)).toEqual(["n2", "n1"]);
    expect(rest.next_cursor).toBeNull();
  });

  it("without rank a search is ordered like any list (defaultSort)", async () => {
    const { match } = sqliteFts5Search({ table: "note" });
    const unranked = notes(db, { match }, { defaultSort: [{ field: "received", dir: "desc" }] });
    expect(ids(await unranked.list({ search: "invoice" }))).toEqual(["n7", "n6", "n4", "n2", "n1"]);
  });

  it("a host's own match gets the text as a bound parameter", async () => {
    const titled = notes(db, { match: (q) => sql`title = ${q}` });
    expect(ids(await titled.list({ search: "Lunch" }))).toEqual(["n2", "n7"]);
    expect(ids(await titled.list({ search: "x' OR '1'='1" }))).toEqual([]);
    // A constant rank is a value, not an ORDER BY column number.
    const flat = notes(db, { match: (q) => sql`title = ${q}`, rank: () => sql`1` });
    expect(ids(await flat.list({ search: "Lunch" }))).toEqual(["n2", "n7"]);
  });

  it("hostile text never raises an FTS5 syntax error", async () => {
    const hostile = [
      '"',
      'say "hi',
      "NEAR(",
      "NEAR(a b",
      "a OR",
      "OR",
      "AND NOT",
      "*",
      "invoice*due",
      "-",
      "-invoice",
      ":",
      "title:invoice",
      "{title body}: x",
      "(",
      ")",
      "^",
      "+",
      "'",
      "\\",
      "\u0000",
      "🙂",
    ];
    for (const search of hostile) {
      await expect(source.list({ search }), JSON.stringify(search)).resolves.toBeDefined();
      await expect(
        source.list({ search, sort: [{ field: "received" }] }),
        JSON.stringify(search),
      ).resolves.toBeDefined();
    }
    // Nothing to search for: no row, no error.
    for (const search of ['"', "*", "-", ":", "(", "^ +"]) {
      const res = await source.list({ search });
      expect([JSON.stringify(search), res.rows, res.total]).toEqual([
        JSON.stringify(search),
        [],
        0,
      ]);
    }
    // Operators are words: `title:invoice` is the phrase "title invoice", not a column filter.
    expect((await source.list({ search: "title:invoice" })).total).toBe(0);
    expect(ids(await source.list({ search: "-invoice" }))).toEqual(["n1", "n4", "n6", "n2", "n7"]);
  });

  it("an empty text after trimming is no search: every row", async () => {
    const res = await source.list({ search: "   ", page: { limit: 100 } });
    expect(res.total).toBe(NOTES.length);
  });

  it("the source's own writes are indexed by the triggers", async () => {
    const own = openDb("memory");
    await vault(own);
    const src = notes(own);
    const added = await src.mutate({
      op: "insert",
      row: { ref: "w1", owner: "ana", title: "Quarterly zebra report", received: 9 },
    });
    expect(ids(await src.list({ search: "zebra" }))).toEqual(["w1"]);
    await src.mutate({
      op: "update",
      id: added.__meta.id,
      row: { title: "Quarterly giraffe report" },
      expected_version: 1,
    });
    expect((await src.list({ search: "zebra" })).total).toBe(0);
    expect(ids(await src.list({ search: "giraffe" }))).toEqual(["w1"]);
    // A write of another column leaves the index as it is (the version trigger included).
    await src.mutate({ op: "update", id: "w1", row: { received: 10 } });
    expect(ids(await src.list({ search: "giraffe" }))).toEqual(["w1"]);
    await src.mutate({ op: "delete", id: "w1" });
    expect((await src.list({ search: "giraffe" })).total).toBe(0);
    const check = await own.read((q) =>
      q.get<{ n: number }>(`SELECT count(*) AS n FROM note_fts WHERE note_fts MATCH 'giraffe'`),
    );
    expect(check?.n).toBe(0);
  });
});

describe("sqlite_table search over a dispatcher", () => {
  it("two owners searching the same word each get only their own rows", async () => {
    const db = openDb("memory");
    await vault(db);
    const registry = new CollectionRegistry();
    registry.register({ name: "notes", source: notes(db), view: ViewConfigSchema.parse({}) });
    const dispatcher = createDispatcher<{ owner: string }>(registry, {
      log: { error: vi.fn() },
      rowScope: (ctx) => ({ field: "owner", op: "eq", value: ctx.owner }),
    });
    const list = async (owner: string, payload: object) => {
      const res = await dispatcher.dispatch(
        { kind: requestKind("list"), id: "1", payload: { collection: "notes", ...payload } },
        { owner },
      );
      expect(res.kind, JSON.stringify(res.payload)).toBe(`${requestKind("list")}.ok`);
      return res.payload as ListResponse;
    };
    expect(ids(await list("ana", { search: "invoice" }))).toEqual(["n1", "n6", "n2", "n7"]);
    expect(ids(await list("bob", { search: "invoice" }))).toEqual(["n4"]);
    expect((await list("bob", { search: 'NEAR( "' })).total).toBe(0);
  });
});

describe("sqlite_table search on a file another connection writes", () => {
  it("finds a row written by a second connection, without the source", async () => {
    const path = tempFile("vault.db");
    const db = openNodeSqlite(path);
    try {
      await vault(db);
      const source = notes(db);
      expect((await source.list({ search: "zebra" })).total).toBe(0);

      // Another process: its own connection to the file, plain SQL, no jsudc.
      const other = new DatabaseSync(path);
      try {
        other.exec("PRAGMA busy_timeout = 5000");
        other
          .prepare(
            "INSERT INTO note (id, owner, title, body_text, received) VALUES (?, ?, ?, ?, ?)",
          )
          .run("x1", "ana", "Zebra crossing", "seen from the other process", 20);
        expect(ids(await source.list({ search: "zebra" }, scoped("ana")))).toEqual(["x1"]);
        expect((await source.list({ search: "zebra" }, scoped("bob"))).total).toBe(0);

        other.prepare("UPDATE note SET title = ? WHERE id = ?").run("Okapi crossing", "x1");
        expect((await source.list({ search: "zebra" })).total).toBe(0);
        expect(ids(await source.list({ search: "okapi" }))).toEqual(["x1"]);
        const [row] = (await source.list({ search: "okapi" })).rows;
        expect(row?.__meta.version).toBe(2); // the version trigger bumped it

        other.prepare("DELETE FROM note WHERE id = ?").run("x1");
        expect((await source.list({ search: "okapi" })).total).toBe(0);
      } finally {
        other.close();
      }
    } finally {
      db.close();
    }
  });
});
