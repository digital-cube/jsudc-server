// SqliteTableSource, write side — the scenarios of postgres-table-write.test.ts on SQLite,
// on `:memory:` and on a file: insert / update / delete with typed columns, a version
// column, a read-only column and computed fields; a table without a version column and
// with integer ids; the row scope of two contexts, directly and through the dispatcher;
// value forms. Plus what is SQLite's own: uuid ids as lower-case text, the version trigger.
import {
  type FilterNode,
  type Row,
  requestKind,
  type SchemaDocInput,
  SchemaDocSchema,
  UdcError,
  ViewConfigSchema,
} from "@jsudc/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDispatcher } from "../../src/dispatcher.js";
import { CollectionRegistry } from "../../src/registry.js";
import type { SourceContext } from "../../src/sources/source.js";
import {
  type SqliteDatabase,
  SqliteTableSource,
  type SqliteTableSourceOptions,
  sqliteVersionTriggerSql,
} from "../../src/sqlite.js";
import { openDb, rejectsWith, WHERES } from "./helpers.js";

const schema = SchemaDocSchema.parse({
  version: "v1",
  fields: {
    tenant: { type: "string" },
    folder_id: { type: "integer" },
    folder: { type: "string" },
    subject: { type: "string", required: true },
    size: { type: "integer", min: 0 },
    seen: { type: "bool" },
    labels: { type: "string_array" },
    headers: { type: "json" },
    sent_on: { type: "date" },
    created_at: { type: "datetime", required: true },
    attachment_count: { type: "integer" },
  },
} satisfies SchemaDocInput);

const plainSchema = SchemaDocSchema.parse({
  version: "v1",
  fields: { name: { type: "string", required: true }, n: { type: "integer" } },
} satisfies SchemaDocInput);

const DDL = `
  CREATE TABLE ptw_folder (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
  INSERT INTO ptw_folder VALUES (1, 'Inbox'), (2, 'Archive');
  CREATE TABLE ptw_message (
    id TEXT PRIMARY KEY,
    tenant TEXT NOT NULL,
    folder_id INTEGER REFERENCES ptw_folder(id),
    subject TEXT NOT NULL,
    size INTEGER,
    seen INTEGER NOT NULL DEFAULT 0,
    labels TEXT,
    headers TEXT,
    sent_on TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    row_version INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE ptw_attachment (
    id INTEGER PRIMARY KEY,
    message_id TEXT REFERENCES ptw_message(id) ON DELETE CASCADE,
    name TEXT);
  CREATE TABLE ptw_plain (id INTEGER PRIMARY KEY, name TEXT NOT NULL, n INTEGER);
`;

describe.each(WHERES)("sqlite_table writes on %s", (where) => {
  let db: SqliteDatabase;

  beforeEach(async () => {
    // A pragma a host sets per connection, as it opens it (not inside a transaction).
    db = openDb(where, { setup: (conn) => conn.exec("PRAGMA foreign_keys = ON") });
    await db.exec(DDL);
  });

  /** Over the table itself: `folder` and `attachment_count` are correlated subqueries. */
  function tableSource(extra: Partial<SqliteTableSourceOptions> = {}) {
    return new SqliteTableSource({
      db,
      schema,
      table: "ptw_message",
      versionColumn: "row_version",
      fields: {
        created_at: { readOnly: true },
        folder: { sql: "(SELECT f.name FROM ptw_folder f WHERE f.id = ptw_message.folder_id)" },
        attachment_count: {
          sql: "(SELECT count(*) FROM ptw_attachment a WHERE a.message_id = ptw_message.id)",
        },
      },
      ...extra,
    });
  }

  /** Integer ids (INTEGER PRIMARY KEY), no version column. */
  const plainSource = () =>
    new SqliteTableSource({ db, schema: plainSchema, table: "ptw_plain", idType: "integer" });

  const scopeOf = (tenant: string): SourceContext => ({
    ctx: { tenant },
    collection: "message",
    rowScope: { field: "tenant", op: "eq", value: tenant },
  });

  const rawMessage = (id: string) =>
    db.get<Record<string, unknown>>({
      sql: "SELECT tenant, subject, size, seen, row_version FROM ptw_message WHERE id = ?",
      params: [id],
    });

  const count = async (table: string) =>
    (await db.get<{ n: number }>(`SELECT count(*) AS n FROM "${table}"`))?.n;

  describe("insert, update, delete on a table", () => {
    it("offers mutate and writes typed columns, serving computed fields back", async () => {
      const source = tableSource();
      expect(source.capabilities).toMatchObject({
        mutate: true,
        mutate_many: false,
        reindex: false,
        paging: ["cursor", "offset"],
      });
      expect(source.capabilities.search).toBeUndefined();
      const row = await source.mutate({
        op: "insert",
        row: {
          tenant: "a",
          folder_id: 1,
          subject: "hello",
          size: 12,
          labels: ["inbox", "Work"],
          headers: { from: "x@y.rs", list: [1, 2] },
          sent_on: "2024-01-10",
          __meta: { id: "forged", version: 9 },
        },
      });
      expect(row).toEqual({
        __meta: { id: expect.stringMatching(/^[0-9a-f-]{36}$/), version: 1 },
        tenant: "a",
        folder_id: 1,
        folder: "Inbox",
        subject: "hello",
        size: 12,
        seen: false, // the column default, 0, served as a boolean
        labels: ["inbox", "Work"],
        headers: { from: "x@y.rs", list: [1, 2] },
        sent_on: "2024-01-10",
        created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
        attachment_count: 0,
      });
      expect(await source.read(row.__meta.id)).toEqual(row);

      await db.run({
        sql: "INSERT INTO ptw_attachment (message_id, name) VALUES (?, 'a.pdf')",
        params: [row.__meta.id],
      });
      const updated = await source.mutate({
        op: "update",
        id: row.__meta.id,
        row: { seen: true, folder_id: 2, labels: [], size: null },
        expected_version: 1,
      });
      expect(updated).toEqual({
        ...row,
        __meta: { id: row.__meta.id, version: 2 },
        seen: true,
        folder_id: 2,
        folder: "Archive",
        labels: [],
        size: undefined,
        attachment_count: 1,
      });
      expect(updated).not.toHaveProperty("size");
      expect(await rawMessage(row.__meta.id)).toMatchObject({ seen: 1, row_version: 2 });

      const deleted = await source.mutate({
        op: "delete",
        id: row.__meta.id,
        expected_version: 2,
      });
      expect(deleted).toEqual(updated);
      expect(await count("ptw_message")).toBe(0);
      expect(await count("ptw_attachment")).toBe(0);
      await rejectsWith(source.read(row.__meta.id), "not_found");
    });

    it("refuses a read-only or a computed field in an insert or a patch, naming it", async () => {
      const source = tableSource();
      const err = await rejectsWith(
        source.mutate({
          op: "insert",
          row: { tenant: "a", subject: "x", created_at: "2024-01-01T00:00:00Z", folder: "Inbox" },
        }),
        "validation_error",
      );
      expect(err.details?.problems).toEqual([
        { field: "created_at", message: "is read-only" },
        { field: "folder", message: "is read-only" },
      ]);
      expect(await count("ptw_message")).toBe(0);

      const row = await source.mutate({ op: "insert", row: { tenant: "a", subject: "x" } });
      for (const patch of [{ attachment_count: 3 }, { created_at: "2024-01-01T00:00:00Z" }]) {
        const e = await rejectsWith(
          source.mutate({ op: "update", id: row.__meta.id, row: { subject: "y", ...patch } }),
          "validation_error",
        );
        expect(e.details?.problems).toEqual([
          { field: Object.keys(patch)[0], message: "is read-only" },
        ]);
      }
      const both = await rejectsWith(
        source.mutate({ op: "update", id: row.__meta.id, row: { folder: "x", size: -1, nope: 1 } }),
        "validation_error",
      );
      expect(both.details?.problems).toEqual(
        expect.arrayContaining([
          { field: "folder", message: "is read-only" },
          { field: "size", message: "must be >= 0" },
          { field: "nope", message: "unknown field" },
        ]),
      );
      expect(await rawMessage(row.__meta.id)).toMatchObject({ subject: "x", row_version: 1 });
      expect(source.readOnlyFields).toEqual(["folder", "created_at", "attachment_count"]);
      expect(source.computedFields).toEqual(["folder", "attachment_count"]);
    });

    it("checks expected_version: version_conflict with the current version", async () => {
      const source = tableSource();
      const row = await source.mutate({ op: "insert", row: { tenant: "a", subject: "x" } });
      await source.mutate({ op: "update", id: row.__meta.id, row: { subject: "y" } });
      const err = await rejectsWith(
        source.mutate({
          op: "update",
          id: row.__meta.id,
          row: { subject: "z" },
          expected_version: 1,
        }),
        "version_conflict",
      );
      expect(err.details).toMatchObject({
        id: row.__meta.id,
        current_version: 2,
        expected_version: 1,
      });
      const del = await rejectsWith(
        source.mutate({ op: "delete", id: row.__meta.id, expected_version: 7 }),
        "version_conflict",
      );
      expect(del.details).toMatchObject({ current_version: 2 });
      expect(await rawMessage(row.__meta.id)).toMatchObject({ subject: "y", row_version: 2 });

      // An empty patch still bumps the version, as on postgres_table.
      const bumped = await source.mutate({ op: "update", id: row.__meta.id, row: {} });
      expect(bumped.__meta.version).toBe(3);
    });

    it("puts the version check and the scope in the UPDATE / DELETE statement itself", async () => {
      const source = tableSource();
      const row = await source.mutate({ op: "insert", row: { tenant: "a", subject: "x" } });
      const writer = (db as unknown as { writer: { run(s: string, p: unknown[]): unknown } })
        .writer;
      const run = vi.spyOn(writer, "run");
      await source.mutate(
        { op: "update", id: row.__meta.id, row: { subject: "y" }, expected_version: 1 },
        scopeOf("a"),
      );
      await source.mutate({ op: "delete", id: row.__meta.id, expected_version: 2 }, scopeOf("a"));
      const texts = run.mock.calls.map(([text]) => text);
      const update = texts.find((t) => t.startsWith("UPDATE"));
      const del = texts.find((t) => t.startsWith("DELETE"));
      for (const t of [update, del]) {
        expect(t).toMatch(/"row_version" = \?/);
        expect(t).toMatch(/"tenant"/);
      }
      run.mockRestore();
    });

    it("lets exactly one of two concurrent edits of the same version win", async () => {
      const source = tableSource();
      const row = await source.mutate({ op: "insert", row: { tenant: "a", subject: "x" } });
      const results = await Promise.allSettled(
        ["p", "q", "r"].map((subject) =>
          source.mutate({ op: "update", id: row.__meta.id, row: { subject }, expected_version: 1 }),
        ),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results.filter((r) => r.status === "rejected")) {
        expect((r as PromiseRejectedResult).reason.code).toBe("version_conflict");
      }
      expect((await rawMessage(row.__meta.id))?.row_version).toBe(2);
    });

    it("without a version column: version 1 always, an expected_version accepted and not checked", async () => {
      const source = plainSource();
      expect(source.capabilities.mutate).toBe(true);
      const row = await source.mutate({ op: "insert", row: { name: "one", n: 1 } });
      expect(row).toEqual({ __meta: { id: "1", version: 1 }, name: "one", n: 1 });
      const updated = await source.mutate({
        op: "update",
        id: "1",
        row: { n: 2 },
        expected_version: 7,
      });
      expect(updated).toEqual({ __meta: { id: "1", version: 1 }, name: "one", n: 2 });
      expect(await source.mutate({ op: "update", id: "1", row: {}, expected_version: 3 })).toEqual(
        updated,
      );
      await rejectsWith(source.mutate({ op: "update", id: "2", row: { n: 1 } }), "not_found");
      await rejectsWith(source.mutate({ op: "update", id: "x", row: { n: 1 } }), "not_found");
      expect(await source.mutate({ op: "delete", id: "1", expected_version: 99 })).toEqual(updated);
      expect(await count("ptw_plain")).toBe(0);
    });

    it("needs an id, answers not_found for an unknown or malformed one", async () => {
      const source = tableSource();
      await rejectsWith(source.mutate({ op: "update", row: { subject: "x" } }), "validation_error");
      await rejectsWith(source.mutate({ op: "delete" }), "validation_error");
      const missing = "00000000-0000-4000-8000-000000000000";
      await rejectsWith(source.mutate({ op: "update", id: missing, row: {} }), "not_found");
      await rejectsWith(source.mutate({ op: "delete", id: missing }), "not_found");
      await rejectsWith(source.mutate({ op: "delete", id: "1; drop" }), "not_found");
      await rejectsWith(source.read("1; drop"), "not_found");
    });

    it("validates an insert against the schema", async () => {
      const err = await rejectsWith(
        tableSource().mutate({ op: "insert", row: { size: "big" } }),
        "validation_error",
      );
      expect(err.details?.problems).toEqual(
        expect.arrayContaining([
          { field: "subject", message: "is required" },
          { field: "size", message: "must be an integer" },
        ]),
      );
    });

    it("a row that leaves the base where is refused and rolled back", async () => {
      const source = tableSource({ where: "folder_id IS NOT 2" });
      const row = await source.mutate({ op: "insert", row: { tenant: "a", subject: "x" } });
      await rejectsWith(
        source.mutate({ op: "update", id: row.__meta.id, row: { folder_id: 2 } }),
        "forbidden",
      );
      expect(await source.read(row.__meta.id)).toEqual(row);
    });

    it("readOnly: true makes the source read-only", async () => {
      const source = tableSource({ readOnly: true });
      expect(source.capabilities.mutate).toBe(false);
      await rejectsWith(source.mutate({ op: "delete", id: "x" }), "unsupported_op");
      await rejectsWith(
        source.mutate({ op: "insert", row: { tenant: "a", subject: "x" } }),
        "unsupported_op",
      );
      await rejectsWith(source.addField({} as never), "unsupported_op");
      expect(await count("ptw_message")).toBe(0);
    });

    it("refuses bad names and a field that writes the version column at construction", () => {
      expect(() => tableSource({ table: 'x"; drop' })).toThrow(/invalid table/);
      expect(() => tableSource({ idColumn: "id; drop" })).toThrow(/invalid id column/);
      expect(() => tableSource({ fields: { subject: "lower(subject)" } })).toThrow(
        /invalid column/,
      );
      expect(() => tableSource({ fields: { nope: "x" } })).toThrow(/not a field/);
      expect(() => tableSource({ fields: { subject: { column: "s", sql: "1" } } })).toThrow(
        /both column and sql/,
      );
      expect(() => tableSource({ fields: { size: "row_version" } })).toThrow(/version column/);
      expect(() => tableSource({ defaultSort: [{ field: "nope" }] })).toThrow(/defaultSort/);
    });
  });

  describe("ids", () => {
    it("a uuid id is lower-case text: assigned on insert, matched in any case", async () => {
      const source = tableSource();
      const row = await source.mutate({ op: "insert", row: { tenant: "a", subject: "x" } });
      expect(row.__meta.id).toBe(row.__meta.id.toLowerCase());
      const upper = row.__meta.id.toUpperCase();
      expect(await source.read(upper)).toEqual(row);
      const updated = await source.mutate({ op: "update", id: upper, row: { subject: "y" } });
      expect(updated.__meta.id).toBe(row.__meta.id);
      const page = await source.list({ page: { limit: 1 } });
      expect(page.rows[0]?.__meta.id).toBe(row.__meta.id);
      expect(await source.mutate({ op: "delete", id: upper })).toEqual(updated);
    });

    it("a uuid given through a field mapped to the id column is checked and lower-cased", async () => {
      const idSchema = SchemaDocSchema.parse({
        version: "v1",
        fields: { key: { type: "string" }, name: { type: "string" } },
      });
      await db.exec("CREATE TABLE keyed (id TEXT PRIMARY KEY, name TEXT)");
      const source = new SqliteTableSource({
        db,
        schema: idSchema,
        table: "keyed",
        fields: { key: "id" },
      });
      const given = "0F8FAD5B-D9CB-469F-A165-70867728950E";
      const row = await source.mutate({ op: "insert", row: { key: given, name: "n" } });
      expect(row).toEqual({
        __meta: { id: given.toLowerCase(), version: 1 },
        key: given.toLowerCase(),
        name: "n",
      });
      const err = await rejectsWith(
        source.mutate({ op: "insert", row: { key: "not-a-uuid", name: "n" } }),
        "validation_error",
      );
      expect(err.details?.problems).toEqual([{ field: "key", message: "is not a uuid" }]);
      // Without one, the source assigns it.
      const auto = await source.mutate({ op: "insert", row: { name: "auto" } });
      expect(auto.key).toBe(auto.__meta.id);
    });

    it("a text id is the column's own value, given by the row", async () => {
      await db.exec("CREATE TABLE tagged (code TEXT PRIMARY KEY, label TEXT)");
      const s = SchemaDocSchema.parse({
        version: "v1",
        fields: { code: { type: "string", required: true }, label: { type: "string" } },
      });
      const source = new SqliteTableSource({
        db,
        schema: s,
        table: "tagged",
        idColumn: "code",
        idType: "text",
      });
      const row = await source.mutate({ op: "insert", row: { code: "Ab-1", label: "x" } });
      expect(row).toEqual({ __meta: { id: "Ab-1", version: 1 }, code: "Ab-1", label: "x" });
      await rejectsWith(source.read("ab-1"), "not_found");
      expect(await source.read("Ab-1")).toEqual(row);
    });
  });

  describe("the version trigger", () => {
    it("bumps for a writer that does not, and never twice for the source", async () => {
      await db.exec(
        sqliteVersionTriggerSql({ table: "ptw_message", versionColumn: "row_version" }),
      );
      const source = tableSource();
      const row = await source.mutate({ op: "insert", row: { tenant: "a", subject: "x" } });
      const v1 = await source.mutate({ op: "update", id: row.__meta.id, row: { subject: "y" } });
      expect(v1.__meta.version).toBe(2);
      // Another program's UPDATE that knows nothing of the version.
      await db.run({
        sql: "UPDATE ptw_message SET subject = 'z' WHERE id = ?",
        params: [row.__meta.id],
      });
      expect((await source.read(row.__meta.id)).__meta.version).toBe(3);
      // A writer that bumps the version itself is left alone.
      await db.run({
        sql: "UPDATE ptw_message SET subject = 'w', row_version = row_version + 1 WHERE id = ?",
        params: [row.__meta.id],
      });
      expect((await source.read(row.__meta.id)).__meta.version).toBe(4);
      // The source's own update, with expected_version, still answers the right version.
      const v5 = await source.mutate({
        op: "update",
        id: row.__meta.id,
        row: { subject: "v" },
        expected_version: 4,
      });
      expect(v5.__meta.version).toBe(5);
      await rejectsWith(
        source.mutate({ op: "update", id: row.__meta.id, row: {}, expected_version: 4 }),
        "version_conflict",
      );
    });

    it("is plain SQL with checked names", () => {
      expect(sqliteVersionTriggerSql({ table: "note", versionColumn: "version" })).toBe(
        [
          'CREATE TRIGGER IF NOT EXISTS "note_version_bump" AFTER UPDATE ON "note"',
          'FOR EACH ROW WHEN NEW."version" IS OLD."version"',
          "BEGIN",
          '  UPDATE "note" SET "version" = coalesce(OLD."version", 0) + 1 WHERE rowid = NEW.rowid;',
          "END;",
        ].join("\n"),
      );
      expect(() => sqliteVersionTriggerSql({ table: "x; drop", versionColumn: "v" })).toThrow();
    });
  });

  describe("the row scope of two contexts", () => {
    async function seed() {
      const source = tableSource();
      const a = await source.mutate({ op: "insert", row: { tenant: "a", subject: "of a" } });
      const b = await source.mutate({ op: "insert", row: { tenant: "b", subject: "of b" } });
      return { source, a, b };
    }

    it("lists and reads only its own rows", async () => {
      const { source, a, b } = await seed();
      const listed = await source.list({}, scopeOf("a"));
      expect(listed.rows.map((r) => r.__meta.id)).toEqual([a.__meta.id]);
      expect(listed.total).toBe(1);
      await rejectsWith(source.read(b.__meta.id, scopeOf("a")), "not_found");
      expect(await source.read(a.__meta.id, scopeOf("a"))).toEqual(a);
    });

    it("neither updates nor deletes the other's rows: not_found, also with expected_version", async () => {
      const { source, a, b } = await seed();
      for (const [mine, theirs, tenant] of [
        [a, b, "a"],
        [b, a, "b"],
      ] as const) {
        const sctx = scopeOf(tenant);
        for (const op of [
          { op: "update" as const, id: theirs.__meta.id, row: { subject: "hijacked" } },
          {
            op: "update" as const,
            id: theirs.__meta.id,
            row: { subject: "x" },
            expected_version: 9,
          },
          { op: "delete" as const, id: theirs.__meta.id },
          { op: "delete" as const, id: theirs.__meta.id, expected_version: 1 },
        ]) {
          await rejectsWith(source.mutate(op, sctx), "not_found");
        }
        const own = await source.mutate(
          { op: "update", id: mine.__meta.id, row: { seen: true } },
          sctx,
        );
        expect(own).toMatchObject({ tenant, seen: true });
      }
      expect(await rawMessage(a.__meta.id)).toMatchObject({ subject: "of a", row_version: 2 });
      expect(await rawMessage(b.__meta.id)).toMatchObject({ subject: "of b", row_version: 2 });
    });

    it("an insert or a patch with a forged scope value stays in the caller's scope", async () => {
      const { source, a } = await seed();
      const row = await source.mutate(
        { op: "insert", row: { tenant: "b", subject: "forged" } },
        scopeOf("a"),
      );
      expect(row.tenant).toBe("a");
      expect((await rawMessage(row.__meta.id))?.tenant).toBe("a");
      const patched = await source.mutate(
        { op: "update", id: a.__meta.id, row: { tenant: "b" } },
        scopeOf("a"),
      );
      expect(patched.tenant).toBe("a");
    });

    it("a write that would leave a scope with more than eq conditions is forbidden and rolled back", async () => {
      const { source, a } = await seed();
      const sctx: SourceContext = {
        ctx: null,
        collection: "message",
        rowScope: {
          and: [
            { field: "tenant", op: "eq", value: "a" },
            { field: "size", op: "is_null" },
          ],
        } as FilterNode,
      };
      const err = await rejectsWith(
        source.mutate({ op: "update", id: a.__meta.id, row: { size: 5 } }, sctx),
        "forbidden",
      );
      expect(err.details).toMatchObject({ reason: "out_of_scope", collection: "message" });
      await rejectsWith(
        source.mutate({ op: "insert", row: { subject: "big", size: 5 } }, sctx),
        "forbidden",
      );
      expect(await count("ptw_message")).toBe(2);
      expect(await rawMessage(a.__meta.id)).toMatchObject({ size: null, row_version: 1 });
    });

    it("through the dispatcher: the scope holds, the forged value lands in the caller's scope", async () => {
      const { a, b } = await seed();
      type Ctx = { tenant: string };
      const registry = new CollectionRegistry();
      registry.register({
        name: "message",
        source: tableSource(),
        view: ViewConfigSchema.parse({}),
      });
      const dispatcher = createDispatcher<Ctx>(registry, {
        log: { error: vi.fn() },
        rowScope: (ctx) => ({ field: "tenant", op: "eq", value: ctx.tenant }),
        showScopeFields: ["message"],
      });
      const call = (tenant: string, payload: object) =>
        dispatcher.dispatch(
          { kind: requestKind("mutate"), id: "1", payload: { collection: "message", ...payload } },
          { tenant },
        );
      const errCode = (res: { payload: unknown }) => (res.payload as { code?: string }).code;

      expect(
        errCode(await call("a", { op: "update", id: b.__meta.id, row: { subject: "x" } })),
      ).toBe("not_found");
      expect(errCode(await call("b", { op: "delete", id: a.__meta.id }))).toBe("not_found");
      const inserted = await call("b", { op: "insert", row: { tenant: "a", subject: "forged" } });
      expect(inserted.kind).toBe(`${requestKind("mutate")}.ok`);
      const row = (inserted.payload as { row: Row }).row;
      expect(row.tenant).toBe("b");
      expect((await rawMessage(row.__meta.id))?.tenant).toBe("b");
    });
  });

  describe("value forms", () => {
    it("a json field holding an array or a string is stored as JSON text", async () => {
      const source = tableSource();
      const row = await source.mutate({
        op: "insert",
        row: { tenant: "a", subject: "j", headers: ["x", "y"] },
      });
      expect(row.headers).toEqual(["x", "y"]);
      const s = await source.mutate({ op: "update", id: row.__meta.id, row: { headers: "plain" } });
      expect(s.headers).toBe("plain");
      const stored = await db.get<{ t: string; h: string }>({
        sql: "SELECT json_type(headers) AS t, headers AS h FROM ptw_message WHERE id = ?",
        params: [row.__meta.id],
      });
      expect(stored).toEqual({ t: "text", h: '"plain"' });
    });

    it("a datetime is stored in the dialect's UTC form and served so", async () => {
      const dtSchema = SchemaDocSchema.parse({
        version: "v1",
        fields: { at: { type: "datetime" }, on: { type: "date" }, ok: { type: "bool" } },
      });
      await db.exec('CREATE TABLE times (id TEXT PRIMARY KEY, at TEXT, "on" TEXT, ok INTEGER)');
      const source = new SqliteTableSource({ db, schema: dtSchema, table: "times" });
      const row = await source.mutate({
        op: "insert",
        row: { at: "2021-06-01T00:00:00+02:00", on: "2021-06-01", ok: true },
      });
      expect(row).toMatchObject({ at: "2021-05-31T22:00:00.000Z", on: "2021-06-01", ok: true });
      // Compared in the stored form: the offset is gone on both sides.
      const found = await source.list({
        filter: { field: "at", op: "gt", value: "2021-05-31T23:30:00+02:00" },
      });
      expect(found.rows.map((r) => r.__meta.id)).toEqual([row.__meta.id]);
      // Written by another program in SQLite's own datetime() form: read as ISO.
      await db.run({
        sql: "UPDATE times SET at = '2021-06-01 10:00:00', ok = 0 WHERE id = ?",
        params: [row.__meta.id],
      });
      expect(await source.read(row.__meta.id)).toMatchObject({
        at: "2021-06-01T10:00:00.000Z",
        ok: false,
      });
      // It is served in the ISO form, but compared as the text it is: filters and sorts need
      // the stored form (sqliteDateTime's), which this source always writes.
    });

    it("a database refusal (a constraint) rolls the write back and is not a UdcError", async () => {
      const source = tableSource();
      const err = await source
        .mutate({ op: "insert", row: { tenant: "a", subject: "fk", folder_id: 99 } })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(UdcError);
      expect(await count("ptw_message")).toBe(0);
    });
  });
});
