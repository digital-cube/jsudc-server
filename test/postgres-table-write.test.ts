// PostgresTableSource, write side: insert / update / delete on a relational `ptw_message`
// table (typed columns, a version column, a read-only column, computed fields), the same
// over a `FROM` with a join and a `writeTable`, a table without a version column and with
// integer ids, and the row scope of two contexts, directly and through the dispatcher.
import {
  type FilterNode,
  type Row,
  requestKind,
  type SchemaDocInput,
  SchemaDocSchema,
  UdcError,
  ViewConfigSchema,
} from "@jsudc/core";
import { sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDispatcher } from "../src/dispatcher.js";
import { PostgresTableSource, type PostgresTableSourceOptions } from "../src/postgres.js";
import { CollectionRegistry } from "../src/registry.js";
import type { SourceContext } from "../src/sources/source.js";
import { rejectsWith, useTestDb } from "./helpers.js";

const { db } = useTestDb();

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

/** Over the table itself: `folder` and `attachment_count` are correlated subqueries. */
function tableSource(extra: Partial<PostgresTableSourceOptions> = {}) {
  return new PostgresTableSource({
    db,
    schema,
    table: "ptw_message",
    versionColumn: "row_version",
    fields: {
      created_at: { readOnly: true },
      folder: { sql: "(SELECT f.name FROM ptw_folder f WHERE f.id = ptw_message.folder_id)" },
      attachment_count: {
        sql: "(SELECT count(*)::int FROM ptw_attachment a WHERE a.message_id = ptw_message.id)",
      },
    },
    ...extra,
  });
}

/** Over a `FROM` with a join: `folder` is a column of the joined table. */
function joinedSource(extra: Partial<PostgresTableSourceOptions> = {}) {
  return new PostgresTableSource({
    db,
    schema,
    from: "ptw_message m LEFT JOIN ptw_folder f ON f.id = m.folder_id",
    idColumn: "m.id",
    versionColumn: "m.row_version",
    fields: {
      tenant: "m.tenant",
      folder_id: "m.folder_id",
      folder: "f.name",
      subject: "m.subject",
      size: "m.size",
      seen: "m.seen",
      labels: "m.labels",
      headers: "m.headers",
      sent_on: "m.sent_on",
      created_at: { column: "m.created_at", readOnly: true },
      attachment_count: {
        sql: "(SELECT count(*)::int FROM ptw_attachment a WHERE a.message_id = m.id)",
      },
    },
    ...extra,
  });
}

/** Integer ids from a sequence, no version column. */
const plainSource = () =>
  new PostgresTableSource({ db, schema: plainSchema, table: "ptw_plain", idType: "integer" });

const scopeOf = (tenant: string): SourceContext => ({
  ctx: { tenant },
  collection: "message",
  rowScope: { field: "tenant", op: "eq", value: tenant },
});

async function rawMessage(id: string) {
  const res = await db.execute<Record<string, unknown>>(
    sql`SELECT tenant, subject, size, seen, row_version FROM ptw_message WHERE id = ${id}::uuid`,
  );
  return res.rows[0];
}

const count = async (table: string) =>
  (await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}`))
    .rows[0]?.n;

beforeAll(async () => {
  await db.execute(sql`DROP TABLE IF EXISTS ptw_attachment, ptw_message, ptw_folder, ptw_plain`);
  await db.execute(sql`CREATE TABLE ptw_folder (id integer PRIMARY KEY, name text NOT NULL)`);
  await db.execute(sql`INSERT INTO ptw_folder VALUES (1, 'Inbox'), (2, 'Archive')`);
  await db.execute(sql`
    CREATE TABLE ptw_message (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant text NOT NULL,
      folder_id integer REFERENCES ptw_folder(id),
      subject text NOT NULL,
      size integer,
      seen boolean NOT NULL DEFAULT false,
      labels text[],
      headers jsonb,
      sent_on date,
      created_at timestamptz NOT NULL DEFAULT now(),
      row_version integer NOT NULL DEFAULT 1)`);
  await db.execute(sql`
    CREATE TABLE ptw_attachment (
      id serial PRIMARY KEY, message_id uuid REFERENCES ptw_message(id) ON DELETE CASCADE, name text)`);
  await db.execute(
    sql`CREATE TABLE ptw_plain (id bigserial PRIMARY KEY, name text NOT NULL, n integer)`,
  );
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE ptw_attachment, ptw_message, ptw_plain RESTART IDENTITY`);
});

describe("insert, update, delete on a table", () => {
  it("offers mutate and writes typed columns, serving computed fields back", async () => {
    const source = tableSource();
    expect(source.capabilities.mutate).toBe(true);
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
      seen: false, // the column default
      labels: ["inbox", "Work"],
      headers: { from: "x@y.rs", list: [1, 2] },
      sent_on: "2024-01-10",
      created_at: expect.any(String), // the column default; never written by a request
      attachment_count: 0,
    });
    expect(await source.read(row.__meta.id)).toEqual(row);

    await db.execute(
      sql`INSERT INTO ptw_attachment (message_id, name) VALUES (${row.__meta.id}::uuid, 'a.pdf')`,
    );
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

    const deleted = await source.mutate({ op: "delete", id: row.__meta.id, expected_version: 2 });
    expect(deleted).toEqual(updated);
    expect(await count("ptw_message")).toBe(0);
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
    expect(err.message).toContain("created_at is read-only");
    expect(await count("ptw_message")).toBe(0);

    // `created_at` is required, but read-only: an insert is not asked for it.
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
    // Read-only problems and schema problems are listed together.
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
  });

  it("checks expected_version inside the statement: version_conflict with the current version", async () => {
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

    // An empty patch still bumps the version, as on postgres_jsonb.
    const bumped = await source.mutate({ op: "update", id: row.__meta.id, row: {} });
    expect(bumped.__meta.version).toBe(3);
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
      expected_version: 7, // the inline editor always sends one
    });
    expect(updated).toEqual({ __meta: { id: "1", version: 1 }, name: "one", n: 2 });
    // An empty patch writes nothing and answers the row.
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
    const source = tableSource({ where: "folder_id IS DISTINCT FROM 2" });
    const row = await source.mutate({ op: "insert", row: { tenant: "a", subject: "x" } });
    await rejectsWith(
      source.mutate({ op: "update", id: row.__meta.id, row: { folder_id: 2 } }),
      "forbidden",
    );
    expect(await source.read(row.__meta.id)).toEqual(row);
  });
});

describe("a FROM with joins", () => {
  it("without a writeTable: mutate false, and refused", async () => {
    const source = joinedSource();
    expect(source.capabilities.mutate).toBe(false);
    await rejectsWith(
      source.mutate({ op: "insert", row: { tenant: "a", subject: "x" } }),
      "unsupported_op",
    );
    expect(await count("ptw_message")).toBe(0);
  });

  it("readOnly: true makes a table source read-only too", async () => {
    const source = tableSource({ readOnly: true });
    expect(source.capabilities.mutate).toBe(false);
    await rejectsWith(source.mutate({ op: "delete", id: "x" }), "unsupported_op");
  });

  it("with a writeTable: writes its own columns, a column of the joined table is read-only", async () => {
    const source = joinedSource({ writeTable: "ptw_message", writeAlias: "m" });
    expect(source.capabilities.mutate).toBe(true);
    expect(source.readOnlyFields).toEqual(
      expect.arrayContaining(["folder", "created_at", "attachment_count"]),
    );
    const row = await source.mutate({
      op: "insert",
      row: { tenant: "a", subject: "joined", folder_id: 1 },
    });
    expect(row).toMatchObject({ subject: "joined", folder: "Inbox", attachment_count: 0 });
    const moved = await source.mutate({
      op: "update",
      id: row.__meta.id,
      row: { folder_id: 2 },
      expected_version: 1,
    });
    expect(moved).toMatchObject({ folder: "Archive", __meta: { version: 2 } });
    const err = await rejectsWith(
      source.mutate({ op: "update", id: row.__meta.id, row: { folder: "Spam" } }),
      "validation_error",
    );
    expect(err.details?.problems).toEqual([{ field: "folder", message: "is read-only" }]);
    expect(await source.mutate({ op: "delete", id: row.__meta.id })).toEqual(moved);
    expect(await count("ptw_folder")).toBe(2);
  });

  it("refuses a writeTable next to a table, and an id or version column of another table", () => {
    expect(() => tableSource({ writeTable: "ptw_message" })).toThrow(/writeTable goes with from/);
    expect(() =>
      joinedSource({ writeTable: "ptw_message", writeAlias: "m", idColumn: "f.id" }),
    ).toThrow(/id column f\.id is not a column of ptw_message/);
    expect(() =>
      joinedSource({ writeTable: "ptw_message", writeAlias: "m", versionColumn: "f.v" }),
    ).toThrow(/version column/);
  });
});

describe("the row scope of two contexts", () => {
  async function seed() {
    const source = tableSource();
    const a = await source.mutate({ op: "insert", row: { tenant: "a", subject: "of a" } });
    const b = await source.mutate({ op: "insert", row: { tenant: "b", subject: "of b" } });
    return { source, a, b };
  }

  it("neither updates nor deletes the other's rows: not_found, also with expected_version", async () => {
    const { source, a, b } = await seed();
    for (const [mine, theirs, tenant] of [
      [a, b, "a"],
      [b, a, "b"],
    ] as const) {
      const sctx = scopeOf(tenant);
      for (const op of [
        { op: "update" as const, id: theirs.__meta.id, row: { subject: "hijacked" } },
        { op: "update" as const, id: theirs.__meta.id, row: { subject: "x" }, expected_version: 9 },
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
    registry.register({ name: "message", source: tableSource(), view: ViewConfigSchema.parse({}) });
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

    expect(errCode(await call("a", { op: "update", id: b.__meta.id, row: { subject: "x" } }))).toBe(
      "not_found",
    );
    expect(errCode(await call("b", { op: "delete", id: a.__meta.id }))).toBe("not_found");
    const inserted = await call("b", { op: "insert", row: { tenant: "a", subject: "forged" } });
    expect(inserted.kind).toBe(`${requestKind("mutate")}.ok`);
    const row = (inserted.payload as { row: Row }).row;
    expect(row.tenant).toBe("b");
    expect((await rawMessage(row.__meta.id))?.tenant).toBe("b");
  });
});

describe("value forms", () => {
  it("a json field holding an array or a string is stored as JSON, not as a Postgres array", async () => {
    const source = tableSource();
    const row = await source.mutate({
      op: "insert",
      row: { tenant: "a", subject: "j", headers: ["x", "y"] },
    });
    expect(row.headers).toEqual(["x", "y"]);
    const s = await source.mutate({ op: "update", id: row.__meta.id, row: { headers: "plain" } });
    expect(s.headers).toBe("plain");
    const res = await db.execute<{ t: string }>(
      sql`SELECT jsonb_typeof(headers) AS t FROM ptw_message WHERE id = ${row.__meta.id}::uuid`,
    );
    expect(res.rows[0]?.t).toBe("string");
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
