// PostgresTableSource, read side: a relational `pt_message` table with typed columns and
// UUID ids, an `pt_attachment` link table for computed fields, tables with text and integer
// ids, the row scope of two contexts, and a source.yaml through loadRegistry + makeSource.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DescribeResponse,
  type FilterNode,
  type ListResponse,
  type Row,
  requestKind,
  type SchemaDocInput,
  SchemaDocSchema,
  type SortKey,
  ViewConfigSchema,
} from "@jsudc/core";
import { sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Described } from "../src/describe.js";
import { createDispatcher } from "../src/dispatcher.js";
import { encodeCursor, makeSource, PostgresTableSource } from "../src/index.js";
import { CollectionRegistry, loadRegistry } from "../src/registry.js";
import { ids, rejectsWith, useTestDb } from "./helpers.js";

const handle = useTestDb();
const { db } = handle;

const messageSchema = SchemaDocSchema.parse({
  version: "v1",
  fields: {
    tenant: { type: "string" },
    subject: { type: "string", required: true },
    size: { type: "integer" },
    score: { type: "decimal" },
    sent_on: { type: "date" },
    sent_at: { type: "datetime" },
    unread: { type: "bool" },
    labels: { type: "string_array" },
    secret: { type: "string" },
    attachment_count: { type: "integer" },
    attachment_names: { type: "string_array" },
  },
} satisfies SchemaDocInput);

/** The fields of `pt_message` itself, no computed ones. */
const plainSchema = SchemaDocSchema.parse({
  version: "v1",
  fields: {
    subject: { type: "string" },
    size: { type: "integer" },
    labels: { type: "string_array" },
  },
} satisfies SchemaDocInput);

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// Typed columns; `subject_line` is mapped to the field `subject`.
const MESSAGES = [
  [1, "a", "alpha", 10, 1.5, "2024-01-10", "2024-01-10T08:00:00Z", true, ["inbox", "Work"]],
  [2, "a", "Beta", 20, 2.25, "2024-02-01", "2024-02-01T09:30:00Z", false, ["inbox"]],
  [3, "a", "gamma", null, null, null, null, null, null],
  [4, "b", "alpha", 5, -1, "2023-12-31", "2023-12-31T23:00:00Z", true, []],
  [5, "b", "delta", 40, 10.125, "2024-03-05", "2024-03-05T12:00:00Z", false, ["sent"]],
  [6, "b", "Epsilon", 30, 0, "2024-01-10", "2024-01-10T10:00:00Z", true, ["inbox", "x_y"]],
] as const;
// message n → attachment names
const ATTACHMENTS: Record<number, string[]> = {
  1: ["a.pdf", "b.png"],
  2: ["c.txt"],
  5: ["d", "e", "f"],
};

beforeAll(async () => {
  await db.execute(sql`DROP TABLE IF EXISTS pt_attachment, pt_message, pt_text_ids, pt_int_ids`);
  await db.execute(sql`
    CREATE TABLE pt_message (
      id uuid PRIMARY KEY, tenant text NOT NULL, subject_line text NOT NULL, size integer,
      score numeric, sent_on date, sent_at timestamptz, unread boolean, labels text[],
      secret text, row_version integer NOT NULL DEFAULT 1)`);
  await db.execute(sql`
    CREATE TABLE pt_attachment (id serial PRIMARY KEY, message_id uuid REFERENCES pt_message(id), name text)`);
  for (const [n, tenant, subject, size, score, on, at, unread, labels] of MESSAGES) {
    await db.execute(sql`
      INSERT INTO pt_message (id, tenant, subject_line, size, score, sent_on, sent_at, unread, labels, secret, row_version)
      VALUES (${uuid(n)}::uuid, ${tenant}, ${subject}, ${size}, ${score}, ${on}::date, ${at}::timestamptz,
              ${unread}, ${labels === null ? null : sql.param(labels)}::text[], ${`s${n}`}, ${n})`);
  }
  for (const [n, names] of Object.entries(ATTACHMENTS)) {
    for (const name of names) {
      await db.execute(
        sql`INSERT INTO pt_attachment (message_id, name) VALUES (${uuid(Number(n))}::uuid, ${name})`,
      );
    }
  }
  await db.execute(sql`CREATE TABLE pt_text_ids (code text PRIMARY KEY, name text, n integer)`);
  await db.execute(sql`CREATE TABLE pt_int_ids (id bigint PRIMARY KEY, name text, n integer)`);
  for (let i = 1; i <= 23; i++) {
    const code = `K-${String.fromCharCode(65 + (i % 7))}${i}`;
    await db.execute(
      sql`INSERT INTO pt_text_ids (code, name, n) VALUES (${code}, ${`row ${i}`}, ${i % 4})`,
    );
    await db.execute(
      sql`INSERT INTO pt_int_ids (id, name, n) VALUES (${i * 1000 + 7}, ${`row ${i}`}, ${i % 4})`,
    );
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The message table with a LATERAL join over its attachments: computed count and names. */
const FROM_WITH_JOIN = `pt_message m
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS n, array_agg(a.name ORDER BY a.name) AS names
    FROM pt_attachment a WHERE a.message_id = m.id
  ) ac ON true`;

function messages(opts: Partial<ConstructorParameters<typeof PostgresTableSource>[0]> = {}) {
  return new PostgresTableSource({
    db,
    schema: messageSchema,
    from: FROM_WITH_JOIN,
    idColumn: "m.id",
    versionColumn: "m.row_version",
    fields: {
      tenant: "m.tenant",
      subject: "m.subject_line",
      size: "m.size",
      score: "m.score",
      sent_on: "m.sent_on",
      sent_at: "m.sent_at",
      unread: "m.unread",
      labels: "m.labels",
      secret: { column: "m.secret", filterable: false, sortable: false },
      attachment_count: { sql: "ac.n" },
      attachment_names: { sql: "ac.names" },
    },
    ...opts,
  });
}

const subjects = (res: ListResponse) => res.rows.map((r) => r.subject);

describe("rows", () => {
  it("serves typed columns as JSON values, __meta from the id and version columns", async () => {
    const row = await messages().read(uuid(1));
    expect(row).toEqual({
      __meta: { id: uuid(1), version: 1 },
      tenant: "a",
      subject: "alpha",
      size: 10,
      score: 1.5,
      sent_on: "2024-01-10",
      sent_at: expect.stringMatching(/^2024-01-10T08:00:00(\+00:00|Z)$/),
      unread: true,
      labels: ["inbox", "Work"],
      secret: "s1",
      attachment_count: 2,
      attachment_names: ["a.pdf", "b.png"],
    });
    expect((await messages().read(uuid(5))).__meta.version).toBe(5);
  });

  it("leaves NULL columns out of the row, or serves them as null with keepNulls", async () => {
    const row = await messages().read(uuid(3));
    expect(row).toEqual({
      __meta: { id: uuid(3), version: 3 },
      tenant: "a",
      subject: "gamma",
      secret: "s3",
      attachment_count: 0,
    });
    const kept = await messages({ keepNulls: true }).read(uuid(3));
    expect(kept.size).toBeNull();
    expect(kept.attachment_names).toBeNull();
  });

  it("is version 1 without a version column", async () => {
    const src = new PostgresTableSource({
      db,
      schema: plainSchema,
      table: "pt_message",
      fields: { subject: "subject_line" },
    });
    expect((await src.read(uuid(5))).__meta.version).toBe(1);
  });

  it("read: an id of the wrong type, an unknown id and a row outside the base where are not_found", async () => {
    await rejectsWith(messages().read("not-a-uuid"), "not_found");
    await rejectsWith(messages().read(uuid(99)), "not_found");
    await rejectsWith(messages({ where: "m.tenant = 'b'" }).read(uuid(1)), "not_found");
  });
});

describe("a computed field from a join", () => {
  it("lists, sorts and filters", async () => {
    const src = messages();
    const sorted = await src.list({
      sort: [{ field: "attachment_count", dir: "desc" }, { field: "subject" }],
    });
    expect(sorted.rows.map((r) => [r.subject, r.attachment_count])).toEqual([
      ["delta", 3],
      ["alpha", 2],
      ["Beta", 1],
      ["Epsilon", 0],
      ["alpha", 0],
      ["gamma", 0],
    ]);
    const two = await src.list({ filter: { field: "attachment_count", op: "gte", value: 2 } });
    expect(subjects(two).sort()).toEqual(["alpha", "delta"]);
    expect(two.total).toBe(2);
    const named = await src.list({
      filter: { field: "attachment_names", op: "in", value: ["c.txt", "e"] },
      sort: [{ field: "subject" }],
    });
    expect(subjects(named)).toEqual(["Beta", "delta"]);
  });

  it("works as a correlated subquery over a plain table too", async () => {
    const src = new PostgresTableSource({
      db,
      schema: messageSchema,
      table: "pt_message",
      fields: {
        subject: "subject_line",
        attachment_count: {
          sql: "(SELECT count(*)::int FROM pt_attachment a WHERE a.message_id = pt_message.id)",
        },
        attachment_names: {
          sql: "(SELECT array_agg(a.name) FROM pt_attachment a WHERE a.message_id = pt_message.id)",
        },
      },
    });
    const res = await src.list({
      filter: { field: "attachment_count", op: "between", value: [1, 2] },
      sort: [{ field: "attachment_count" }],
    });
    expect(subjects(res)).toEqual(["Beta", "alpha"]);
    expect(src.computedFields).toEqual(["attachment_count", "attachment_names"]);
  });
});

describe("typed comparisons agree with the jsonb source", () => {
  const src = messages();
  const tags = async (filter: FilterNode) =>
    subjects(await src.list({ filter, sort: [{ field: "subject" }] }));

  it.each<[FilterNode, string[]]>([
    [{ field: "size", op: "gt", value: 9 }, ["Beta", "Epsilon", "alpha", "delta"]],
    [{ field: "size", op: "contains", value: "0" }, ["Beta", "Epsilon", "alpha", "delta"]],
    [{ field: "score", op: "lt", value: 0 }, ["alpha"]],
    [{ field: "score", op: "in", value: [1.5, 10.125] }, ["alpha", "delta"]],
    [{ field: "sent_on", op: "eq", value: "2024-01-10" }, ["Epsilon", "alpha"]],
    [{ field: "sent_on", op: "starts_with", value: "2023" }, ["alpha"]],
    [{ field: "sent_at", op: "lt", value: "2024-01-10T09:00:00+02:00" }, ["alpha"]],
    [{ field: "sent_at", op: "lte", value: "2024-01-10T10:00:00+02:00" }, ["alpha", "alpha"]],
    [{ field: "unread", op: "eq", value: false }, ["Beta", "delta"]],
    [{ field: "subject", op: "gt", value: "a" }, ["alpha", "alpha", "delta", "gamma"]],
    [{ field: "subject", op: "lt", value: "b", case_insensitive: true }, ["alpha", "alpha"]],
    [{ field: "labels", op: "in", value: ["work"], case_insensitive: true }, ["alpha"]],
    [{ field: "labels", op: "contains", value: "_" }, ["Epsilon"]],
    [{ field: "labels", op: "not_in", value: ["inbox"] }, ["alpha", "delta"]],
    [{ field: "labels", op: "is_null" }, ["gamma"]],
    [{ field: "id", op: "in", value: [uuid(2), uuid(4), "junk"] }, ["Beta", "alpha"]],
  ])("%j", async (filter, expected) => {
    expect(await tags(filter)).toEqual(expected);
  });

  it("sorts text by code point (uppercase first), nulls last", async () => {
    const res = await src.list({ sort: [{ field: "subject" }, { field: "size" }] });
    expect(subjects(res)).toEqual(["Beta", "Epsilon", "alpha", "alpha", "delta", "gamma"]);
    const bySize = await src.list({ sort: [{ field: "size", dir: "desc" }] });
    expect(bySize.rows.map((r) => r.size)).toEqual([40, 30, 20, 10, 5, undefined]);
  });
});

describe("defaultSort", () => {
  const sizes = (res: ListResponse) => res.rows.map((r) => r.size);
  const bySize = () => messages({ defaultSort: [{ field: "size", dir: "desc" }] });

  it("orders a list without a sort, or with an empty one", async () => {
    expect(sizes(await bySize().list({}))).toEqual([40, 30, 20, 10, 5, undefined]);
    expect(sizes(await bySize().list({ sort: [] }))).toEqual([40, 30, 20, 10, 5, undefined]);
  });

  it("gives way to the request's sort", async () => {
    const res = await bySize().list({ sort: [{ field: "size" }] });
    expect(sizes(res)).toEqual([5, 10, 20, 30, 40, undefined]);
  });

  it("pages by cursor in the default order, as by offset", async () => {
    const src = bySize();
    const seen: string[] = [];
    let cursor: string | null | undefined;
    do {
      const res: ListResponse = await src.list({ page: { limit: 4, cursor } });
      seen.push(...ids(res.rows));
      cursor = res.next_cursor;
    } while (cursor);
    expect(seen).toEqual(ids((await src.list({ page: { limit: 100 } })).rows));
  });

  it("steps aside for a ranked search without a sort, and orders an unranked one", async () => {
    const match = (q: unknown) => sql`m.subject_line ILIKE '%' || ${q} || '%'`;
    const ranked = messages({
      defaultSort: [{ field: "size" }],
      search: { match, rank: () => sql`m.size` },
    });
    // By rank (size, higher first), not by the default (size ascending).
    expect(sizes(await ranked.list({ search: "a" }))).toEqual([40, 20, 10, 5, undefined]);
    const plain = messages({ defaultSort: [{ field: "size" }], search: { match } });
    expect(sizes(await plain.list({ search: "a" }))).toEqual([5, 10, 20, 40, undefined]);
  });

  it("is refused at construction when it names a field that is unknown or not sortable", () => {
    expect(() => messages({ defaultSort: [{ field: "nope" }] })).toThrow(
      "PostgresTableSource: defaultSort names nope, not a sortable field",
    );
    expect(() => messages({ defaultSort: [{ field: "secret" }] })).toThrow(/names secret/);
  });
});

describe("a field marked not filterable", () => {
  it("is refused in a filter and a sort like an unknown field, before any query", async () => {
    const src = messages();
    const query = vi.spyOn(handle.pool, "query");
    const err = await rejectsWith(
      src.list({ filter: { field: "secret", op: "eq", value: "s1" } }),
      "validation_error",
    );
    expect(err.message).toBe('unknown field in filter: "secret"');
    expect(err.details).toEqual({ field: "secret", where: "filter" });
    const sortErr = await rejectsWith(
      src.list({ sort: [{ field: "secret" }] }),
      "validation_error",
    );
    expect(sortErr.message).toBe('unknown field in sort: "secret"');
    expect(query).not.toHaveBeenCalled();
    expect(src.notFilterable).toEqual(["secret"]);
  });

  it("is still read, and the host's row scope may use it", async () => {
    const src = messages();
    const res = await src.list(
      { sort: [{ field: "subject" }] },
      { ctx: null, collection: "m", rowScope: { field: "secret", op: "in", value: ["s1", "s2"] } },
    );
    expect(res.rows.map((r) => r.secret)).toEqual(["s2", "s1"]);
  });

  it("is left out of describe.filterable", async () => {
    const registry = new CollectionRegistry();
    registry.register({ name: "messages", source: messages(), view: ViewConfigSchema.parse({}) });
    const dispatcher = createDispatcher(registry, { log: { error: vi.fn() } });
    const res = await dispatcher.dispatch({
      kind: requestKind("describe"),
      id: "1",
      payload: { collection: "messages" },
    });
    const d = res.payload as DescribeResponse;
    const fields = d.filterable.fields.map((f) => f.field);
    expect(fields).toContain("subject");
    expect(fields).toContain("attachment_count");
    expect(fields).not.toContain("secret");
    expect(d.schema.fields.secret).toBeDefined();
    expect(d.source_kind).toBe("postgres_table");
    expect(d.capabilities).toMatchObject({
      mutate: false,
      total_count: true,
      schema_edit: false,
      reindex: false,
      tree_reparent: false,
      paging: ["cursor", "offset"],
    });
  });
});

describe("a field marked not sortable", () => {
  async function describeMessages(view: unknown = {}) {
    const registry = new CollectionRegistry();
    registry.register({
      name: "messages",
      source: messages(),
      view: ViewConfigSchema.parse(view),
    });
    const dispatcher = createDispatcher(registry, { log: { error: vi.fn() } });
    const res = await dispatcher.dispatch({
      kind: requestKind("describe"),
      id: "1",
      payload: { collection: "messages" },
    });
    return res.payload as Described;
  }

  it("is listed in notSortable and left out of describe.sortable, which lists the others", async () => {
    expect(messages().notSortable).toEqual(["secret"]);
    const d = await describeMessages();
    expect(d.sortable?.fields).toEqual(
      messageSchema.field_order.filter((f) => f !== "secret" && !messageSchema.fields[f]?.deleted),
    );
    expect(d.sortable?.fields).toContain("subject");
    expect(d.sortable?.fields).toContain("attachment_count");
    expect(d.sortable?.fields).not.toContain("secret");
    // Still a column the table draws, and still in the schema.
    expect(d.view.columns.map((c) => c.field)).toContain("secret");
  });

  it("describe.sortable lists exactly what list accepts in a sort", async () => {
    const d = await describeMessages();
    const src = messages();
    for (const field of d.sortable?.fields ?? []) {
      await expect(src.list({ sort: [{ field }], page: { limit: 1 } })).resolves.toBeDefined();
    }
    await rejectsWith(src.list({ sort: [{ field: "secret" }] }), "validation_error");
  });

  it("only one sortable field: the source a mailbox declares", async () => {
    const only = new PostgresTableSource({
      db,
      schema: messageSchema,
      from: FROM_WITH_JOIN,
      idColumn: "m.id",
      fields: Object.fromEntries(
        messageSchema.field_order
          .filter((f) => f !== "size" && !messageSchema.fields[f]?.deleted)
          .map((f) => [f, { sql: "NULL", sortable: false }]),
      ),
    });
    expect(only.notSortable).not.toContain("size");
    const registry = new CollectionRegistry();
    registry.register({ name: "only", source: only, view: ViewConfigSchema.parse({}) });
    const dispatcher = createDispatcher(registry, { log: { error: vi.fn() } });
    const res = await dispatcher.dispatch({
      kind: requestKind("describe"),
      id: "1",
      payload: { collection: "only" },
    });
    expect((res.payload as Described).sortable).toEqual({ fields: ["size"] });
  });
});

describe("total_count: false", () => {
  it("runs no count(*), answers total null, and the cursor still pages", async () => {
    const src = messages({ totalCount: false });
    expect(src.capabilities.total_count).toBe(false);
    const query = vi.spyOn(handle.pool, "query");
    const seen: Row[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const res: ListResponse = await src.list({
        sort: [{ field: "sent_at", dir: "desc" }],
        page: { limit: 4, cursor },
      });
      expect(res.total).toBeNull();
      seen.push(...res.rows);
      cursor = res.next_cursor;
      if (cursor === null) break;
    }
    expect(seen).toHaveLength(6);
    expect(new Set(ids(seen)).size).toBe(6);
    const texts = query.mock.calls.map(([q]) =>
      typeof q === "string" ? q : (q as { text: string }).text,
    );
    expect(texts.length).toBe(2);
    expect(texts.some((t) => /count\(\*\)/i.test(t) && !/LATERAL/.test(t))).toBe(false);
    expect(texts.every((t) => !/SELECT count\(\*\)::int AS total/i.test(t))).toBe(true);
  });
});

describe("ids that are not UUIDs", () => {
  const textIds = () =>
    new PostgresTableSource({
      db,
      schema: kvSchema,
      table: "pt_text_ids",
      idColumn: "code",
      idType: "text",
      pageSizeDefault: 5,
    });
  const intIds = () =>
    new PostgresTableSource({
      db,
      schema: kvSchema,
      table: "pt_int_ids",
      idType: "integer",
      totalCount: false,
    });

  async function walk(src: PostgresTableSource, sort: SortKey[], limit: number): Promise<string[]> {
    const out: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 100; i++) {
      const res: ListResponse = await src.list({ sort, page: { limit, cursor } });
      out.push(...ids(res.rows));
      cursor = res.next_cursor;
      if (cursor === null) return out;
    }
    throw new Error("did not end");
  }

  it.each<[string, SortKey[]]>([
    ["no sort", []],
    ["n asc", [{ field: "n" }]],
    ["n desc, name", [{ field: "n", dir: "desc" }, { field: "name" }]],
  ])("text and integer ids page by cursor as by offset: %s", async (_, sort) => {
    for (const src of [textIds(), intIds()]) {
      const all = ids((await src.list({ sort, page: { limit: 100 } })).rows);
      expect(all).toHaveLength(23);
      expect(await walk(src, sort, 4)).toEqual(all);
      expect(await walk(src, sort, 1)).toEqual(all);
    }
  });

  it("an integer id is a string in __meta, read takes it, a non-integer is not_found", async () => {
    const row = await intIds().read("5007");
    expect(row).toEqual({ __meta: { id: "5007", version: 1 }, name: "row 5", n: 1 });
    await rejectsWith(intIds().read("5007.5"), "not_found");
    await rejectsWith(intIds().read(uuid(1)), "not_found");
    expect((await textIds().read("K-F5")).name).toBe("row 5");
  });

  it("orders integer ids numerically, and refuses a cursor whose id is not of the type", async () => {
    const first = await intIds().list({ page: { limit: 3 } });
    expect(ids(first.rows)).toEqual(["1007", "2007", "3007"]);
    await rejectsWith(
      intIds().list({ page: { cursor: encodeCursor(["x'; drop table pt_int_ids"]) } }),
      "validation_error",
    );
    await rejectsWith(
      intIds().list({ page: { cursor: encodeCursor([uuid(1)]) } }),
      "validation_error",
    );
    // A text id takes any string: it travels as a parameter.
    const res = await textIds().list({
      page: { cursor: encodeCursor(["x'; drop table pt_text_ids"]) },
    });
    expect(res.rows).toHaveLength(0);
  });
});

const kvSchema = SchemaDocSchema.parse({
  version: "v1",
  fields: { name: { type: "string" }, n: { type: "integer" } },
});

describe("two contexts over one table", () => {
  interface Ctx {
    tenant: string;
  }
  const registry = new CollectionRegistry();
  registry.register({ name: "message", source: messages(), view: ViewConfigSchema.parse({}) });
  const dispatcher = createDispatcher<Ctx>(registry, {
    log: { error: vi.fn() },
    rowScope: (ctx) => ({ field: "tenant", op: "eq", value: ctx.tenant }),
  });
  async function call(tenant: string, action: string, payload: object) {
    return dispatcher.dispatch({ kind: requestKind(action), id: "1", payload }, { tenant });
  }

  it("each sees only its own rows in list and read", async () => {
    for (const [tenant, own, other] of [
      ["a", [1, 2, 3], [4, 5, 6]],
      ["b", [4, 5, 6], [1, 2, 3]],
    ] as const) {
      const listed = await call(tenant, "list", { collection: "message", page: { limit: 100 } });
      expect(listed.kind).toBe(`${requestKind("list")}.ok`);
      const res = listed.payload as ListResponse;
      expect(ids(res.rows).sort()).toEqual(own.map(uuid));
      expect(res.total).toBe(3);
      // The scope field is hidden from a scoped client.
      expect(res.rows.every((r) => !("tenant" in r))).toBe(true);
      const mine = await call(tenant, "read", { collection: "message", id: uuid(own[0]) });
      expect(mine.kind).toBe(`${requestKind("read")}.ok`);
      for (const n of other) {
        const theirs = await call(tenant, "read", { collection: "message", id: uuid(n) });
        expect(theirs.kind).toBe(`${requestKind("read")}.err`);
        expect((theirs.payload as { code: string }).code).toBe("not_found");
      }
    }
  });

  it("the scope sits in the statement's WHERE, next to a client filter and the base where", async () => {
    const src = messages({ where: "m.size IS NOT NULL" });
    const query = vi.spyOn(handle.pool, "query");
    const res = await src.list(
      { filter: { field: "subject", op: "eq", value: "alpha" } },
      { ctx: null, collection: "message", rowScope: { field: "tenant", op: "eq", value: "b" } },
    );
    expect(ids(res.rows)).toEqual([uuid(4)]);
    expect(res.total).toBe(1);
    const texts = query.mock.calls.map(([q]) => (q as unknown as { text: string }).text);
    expect(texts.every((t) => t.includes("(m.size IS NOT NULL)"))).toBe(true);
  });
});

describe("an array field stored as jsonb", () => {
  it("compiles the jsonb form when the field says array: jsonb", async () => {
    const src = new PostgresTableSource({
      db,
      schema: plainSchema,
      table: "pt_message",
      fields: {
        subject: "subject_line",
        labels: { sql: "to_jsonb(labels)", array: "jsonb" },
      },
    });
    const res = await src.list({
      filter: { field: "labels", op: "starts_with", value: "in" },
      sort: [{ field: "subject" }],
    });
    expect(subjects(res)).toEqual(["Beta", "Epsilon", "alpha"]);
    const none = await src.list({ filter: { field: "labels", op: "not_in", value: ["inbox"] } });
    expect(subjects(none).sort()).toEqual(["alpha", "delta"]);
  });
});

describe("refusals", () => {
  it("answers unsupported_op for writes and schema edits", async () => {
    const src = messages();
    await rejectsWith(src.mutate({ op: "insert", row: { subject: "x" } }), "unsupported_op");
    await rejectsWith(
      src.addField({ name: "x", fielddef: { type: "string" }, position: { where: "end" } }),
      "unsupported_op",
    );
    await rejectsWith(
      src.updateField({ name: "subject", fielddef: { type: "string" } }),
      "unsupported_op",
    );
    await rejectsWith(src.softDeleteField("subject"), "unsupported_op");
  });

  it("refuses a bad configuration when it is built", () => {
    const base = { db, schema: messageSchema };
    expect(() => new PostgresTableSource(base)).toThrow(/exactly one of table and from/);
    expect(() => new PostgresTableSource({ ...base, table: "a", from: "b" })).toThrow(
      /exactly one/,
    );
    expect(() => new PostgresTableSource({ ...base, table: "a; drop table x" })).toThrow(
      /invalid table/,
    );
    expect(() => new PostgresTableSource({ ...base, table: "a.b.c" })).toThrow(/invalid table/);
    expect(
      () => new PostgresTableSource({ ...base, table: "pt_message", fields: { nope: "x" } }),
    ).toThrow(/nope is not a field/);
    expect(
      () =>
        new PostgresTableSource({
          ...base,
          table: "pt_message",
          fields: { subject: { column: "a", sql: "b" } },
        }),
    ).toThrow(/both column and sql/);
    expect(
      () => new PostgresTableSource({ ...base, table: "pt_message", idColumn: "id::text" }),
    ).toThrow(/invalid id column/);
  });
});

describe("source.yaml", () => {
  function collectionsDir(sourceYaml: string): string {
    const dir = mkdtempSync(join(tmpdir(), "jsudc-pt-"));
    const base = join(dir, "inbox");
    mkdirSync(base);
    writeFileSync(join(base, "view.yaml"), "columns:\n  - field: subject\n");
    writeFileSync(
      join(base, "schema.json"),
      JSON.stringify({
        version: "v1",
        fields: {
          subject: { type: "string" },
          size: { type: "integer" },
          unread: { type: "bool" },
        },
      }),
    );
    writeFileSync(join(base, "source.yaml"), sourceYaml);
    return dir;
  }

  it("kind: postgres_table loads through loadRegistry + makeSource", async () => {
    const dir = collectionsDir(
      [
        "kind: postgres_table",
        "options:",
        "  table: pt_message",
        "  id_column: id",
        "  version_column: row_version",
        "  columns:",
        "    subject: subject_line",
        "  total_count: false",
        "",
      ].join("\n"),
    );
    const registry = loadRegistry(dir, (asset, reg) => makeSource(asset, { db, registry: reg }));
    const { source } = registry.get("inbox");
    expect(source).toBeInstanceOf(PostgresTableSource);
    expect(source.kind).toBe("postgres_table");
    expect(source.capabilities.total_count).toBe(false);
    const res = await source.list({
      filter: { field: "size", op: "gte", value: 20 },
      sort: [{ field: "size" }],
    });
    expect(res.total).toBeNull();
    expect(res.rows.map((r) => [r.subject, r.size, r.__meta.version])).toEqual([
      ["Beta", 20, 2],
      ["Epsilon", 30, 6],
      ["delta", 40, 5],
    ]);
  });

  it("the collection name is the table by default, and a database is required", () => {
    const dir = collectionsDir("kind: postgres_table\n");
    expect(() => loadRegistry(dir, (asset) => makeSource(asset, {}))).toThrow(/needs a database/);
    const registry = loadRegistry(dir, (asset) => makeSource(asset, { db }));
    expect(registry.get("inbox").source.capabilities.total_count).toBe(true);
  });

  it("refuses an SQL expression where a column name goes", () => {
    const dir = collectionsDir("kind: postgres_table\ncolumns:\n  subject: lower(subject_line)\n");
    expect(() => loadRegistry(dir, (asset) => makeSource(asset, { db }))).toThrow(/source\.yaml/);
  });
});
