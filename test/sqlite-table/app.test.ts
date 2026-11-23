// End to end: a collection directory whose source.yaml says `kind: sqlite_table`, made by
// the root entry's makeSource over a registered SqliteDatabase, served by
// buildApp({ swagger: false }) with a row scope; describe, list and mutate over HTTP.
// (test/no-pg/run.mjs does the same from the packed tarball, in an install without pg.)
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { unauthenticatedError } from "@jsudc/core";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildApp,
  createDispatcher,
  loadRegistry,
  makeSource,
  type SqliteDatabase,
  sqliteVersionTriggerSql,
} from "../../src/index.js";
import { openNodeSqlite } from "../../src/sqlite.js";
import { tempDir } from "./helpers.js";

let app: FastifyInstance;
let vault: SqliteDatabase;

beforeAll(async () => {
  const dir = tempDir();
  vault = openNodeSqlite(join(dir, "vault.db"), { name: "vault" });
  await vault.exec(`
    CREATE TABLE note (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      title TEXT NOT NULL,
      body_text TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      tags TEXT,
      version INTEGER NOT NULL DEFAULT 1);
    ${sqliteVersionTriggerSql({ table: "note", versionColumn: "version" })}
    INSERT INTO note (id, owner, title, pinned, tags) VALUES
      ('0b6f9d4e-0000-4000-8000-000000000001', 'ana', 'Ana''s first', 1, '["x"]'),
      ('0b6f9d4e-0000-4000-8000-000000000002', 'ana', 'Ana''s second', 0, NULL),
      ('0b6f9d4e-0000-4000-8000-000000000003', 'bob', 'Bob''s', 0, '[]');`);

  const notes = join(dir, "collections", "notes");
  mkdirSync(notes, { recursive: true });
  writeFileSync(
    join(notes, "schema.json"),
    JSON.stringify({
      version: "v1",
      core_fields: [],
      fields: {
        owner: { type: "string" },
        title: { type: "string", required: true },
        body: { type: "string" },
        pinned: { type: "bool" },
        tags: { type: "string_array" },
      },
    }),
  );
  writeFileSync(
    join(notes, "view.yaml"),
    "default_renderer: table\ncolumns:\n  - {field: title}\n  - {field: pinned}\n",
  );
  writeFileSync(
    join(notes, "source.yaml"),
    [
      "kind: sqlite_table",
      "options:",
      "  database: vault",
      "  table: note",
      "  version_column: version",
      "  columns:",
      "    body: body_text",
    ].join("\n"),
  );

  const registry = loadRegistry(join(dir, "collections"), (asset, reg) =>
    makeSource(asset, { registry: reg, sqlite: { vault } }),
  );
  const dispatcher = createDispatcher<{ user: string }>(registry, {
    log: { error: (...a: unknown[]) => console.error(...a) },
    rowScope: (ctx) => ({ field: "owner", op: "eq", value: ctx.user }),
  });
  const context = (req: FastifyRequest) => {
    const user = req.headers["x-user"];
    if (typeof user !== "string") throw unauthenticatedError();
    return { user };
  };
  app = await buildApp({ dispatcher, registry, context, swagger: false });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  vault?.close();
});

async function post(user: string, action: string, payload: object) {
  const res = await app.inject({
    method: "POST",
    url: `/udc/${action}`,
    payload,
    headers: { "x-user": user },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { kind: string; payload: Record<string, unknown> };
}

describe("a sqlite_table collection over HTTP", () => {
  it("describe: the schema without the scope field, honest capabilities", async () => {
    const res = await post("ana", "describe", { collection: "notes" });
    expect(res.kind).toBe("udc.describe.ok");
    const schema = res.payload.schema as { fields: Record<string, unknown> };
    expect(Object.keys(schema.fields).sort()).toEqual(["body", "pinned", "tags", "title"]);
    expect(res.payload.capabilities).toMatchObject({
      mutate: true,
      mutate_many: true,
      reindex: true,
      total_count: true,
      paging: ["cursor", "offset"],
    });
  });

  it("list: only the caller's rows, in JSON types", async () => {
    const res = await post("ana", "list", { collection: "notes", sort: [{ field: "title" }] });
    expect(res.kind).toBe("udc.list.ok");
    expect(res.payload.total).toBe(2);
    expect(res.payload.rows).toEqual([
      {
        __meta: { id: "0b6f9d4e-0000-4000-8000-000000000001", version: 1 },
        title: "Ana's first",
        pinned: true,
        tags: ["x"],
      },
      {
        __meta: { id: "0b6f9d4e-0000-4000-8000-000000000002", version: 1 },
        title: "Ana's second",
        pinned: false,
      },
    ]);
    const bob = await post("bob", "list", { collection: "notes" });
    expect((bob.payload.rows as unknown[]).length).toBe(1);
  });

  it("mutate: insert in the caller's scope, update with a version, nothing of another's", async () => {
    const ins = await post("bob", "mutate", {
      collection: "notes",
      op: "insert",
      row: { title: "New", body: "text", tags: ["a", "b"] },
    });
    expect(ins.kind).toBe("udc.mutate.ok");
    const row = ins.payload.row as { __meta: { id: string; version: number } };
    expect(row).toMatchObject({ title: "New", body: "text", tags: ["a", "b"] });
    expect(
      (
        await vault.get<{ owner: string }>({
          sql: "SELECT owner FROM note WHERE id = ?",
          params: [row.__meta.id],
        })
      )?.owner,
    ).toBe("bob");

    const upd = await post("bob", "mutate", {
      collection: "notes",
      op: "update",
      id: row.__meta.id,
      row: { pinned: true },
      expected_version: 1,
    });
    expect(upd.payload.row).toMatchObject({ pinned: true, __meta: { version: 2 } });

    const stale = await post("bob", "mutate", {
      collection: "notes",
      op: "update",
      id: row.__meta.id,
      row: { pinned: false },
      expected_version: 1,
    });
    expect(stale.payload).toMatchObject({ code: "version_conflict" });

    const theirs = await post("ana", "mutate", {
      collection: "notes",
      op: "delete",
      id: row.__meta.id,
    });
    expect(theirs.payload).toMatchObject({ code: "not_found" });
    const read = await post("ana", "read", { collection: "notes", id: row.__meta.id });
    expect(read.payload).toMatchObject({ code: "not_found" });
  });
});

describe("makeSource for sqlite_table", () => {
  it("names the missing database handle", () => {
    const dir = tempDir();
    const c = join(dir, "c");
    mkdirSync(c);
    writeFileSync(join(c, "schema.json"), JSON.stringify({ version: "v1", fields: {} }));
    writeFileSync(join(c, "view.yaml"), "default_renderer: table\n");
    writeFileSync(join(c, "source.yaml"), "kind: sqlite_table\n");
    expect(() => loadRegistry(dir, (asset) => makeSource(asset, { sqlite: { vault } }))).toThrow(
      /needs the SQLite database "main"/,
    );
  });
});
