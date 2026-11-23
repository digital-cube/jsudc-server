// The test kit (`@jsudc/server/testing`): a database and a ready app per call, nothing
// shared, everything undone by close(). No database server (vitest project `no-db`).
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ListResponse, type Row, SchemaDocSchema, ViewConfigSchema } from "@jsudc/core";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteTableSource } from "../src/sources/sqlite-table.js";
import type { SqliteDatabase } from "../src/sqlite-database.js";
import { openNodeSqlite } from "../src/sqlite-node.js";
import { openTestApp, type TestApp } from "../src/testing.js";

const DDL = `
  CREATE TABLE task (id TEXT PRIMARY KEY, title TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1);
  INSERT INTO task (id, title) VALUES ('00000000-0000-4000-8000-000000000001', 'Write the kit');`;

const schema = SchemaDocSchema.parse({
  version: "v1",
  core_fields: [],
  fields: { title: { type: "string", required: true } },
});
const view = ViewConfigSchema.parse({ columns: [{ field: "title" }] });

const tasks = (db: SqliteDatabase) => [
  {
    name: "tasks",
    source: new SqliteTableSource({ db, schema, table: "task", versionColumn: "version" }),
    view,
  },
];

const open: TestApp[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
});

async function kit(opts: Partial<Parameters<typeof openTestApp>[0]> = {}): Promise<TestApp> {
  const t = await openTestApp({ ddl: DDL, collections: tasks, ...opts });
  open.push(t);
  return t;
}

const titles = (res: { payload: unknown }) =>
  (res.payload as ListResponse).rows.map((r: Row) => r.title);

describe("openTestApp", () => {
  it("opens :memory:, runs the DDL and serves the collections, swagger off", async () => {
    const t = await kit();
    expect(t.path).toBe(":memory:");
    const res = await t.call("list", { collection: "tasks" });
    expect(res.kind).toBe("udc.list.ok");
    expect(titles(res)).toEqual(["Write the kit"]);
    expect((await t.app.inject({ method: "GET", url: "/docs" })).statusCode).toBe(404);
  });

  it("shares nothing between two calls", async () => {
    const a = await kit();
    const b = await kit();
    const ins = await a.call("mutate", {
      collection: "tasks",
      op: "insert",
      row: { title: "Only in a" },
    });
    expect(ins.kind).toBe("udc.mutate.ok");
    expect(titles(await a.call("list", { collection: "tasks" }))).toHaveLength(2);
    expect(titles(await b.call("list", { collection: "tasks" }))).toEqual(["Write the kit"]);
  });

  it("a temp file: there while open, its directory gone after close(), close() twice is fine", async () => {
    const t = await openTestApp({ where: "file", ddl: DDL, collections: tasks });
    expect(existsSync(t.path)).toBe(true);
    await t.db.exec(
      "INSERT INTO task (id, title) VALUES ('00000000-0000-4000-8000-000000000002', 'b')",
    );
    expect(titles(await t.call("list", { collection: "tasks" }))).toHaveLength(2);
    await t.close();
    await t.close();
    expect(existsSync(dirname(t.path))).toBe(false);
  });

  it("a directory of collections: made by makeSource, the database under its name", async () => {
    const root = mkdtempSync(join(tmpdir(), "jsudc-kit-"));
    try {
      const dir = join(root, "tasks");
      mkdirSync(dir);
      writeFileSync(join(dir, "schema.json"), JSON.stringify(schema));
      writeFileSync(join(dir, "view.yaml"), "columns:\n  - {field: title}\n");
      writeFileSync(
        join(dir, "source.yaml"),
        "kind: sqlite_table\noptions:\n  database: vault\n  table: task\n  version_column: version\n",
      );
      const t = await kit({ collections: root, database: "vault", ddl: [DDL] });
      expect(t.registry.list().map((c) => c.name)).toEqual(["tasks"]);
      const res = await t.call("list", { collection: "tasks" });
      expect(titles(res)).toEqual(["Write the kit"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("changes: true serves the change feed", async () => {
    const t = await kit({ changes: true });
    const desc = await t.call<{ capabilities: { changes?: boolean } }>("describe", {
      collection: "tasks",
    });
    expect(desc.payload.capabilities.changes).toBe(true);
    expect(t.changes).toBeDefined();
    const none = await kit();
    expect(none.changes).toBeUndefined();
  });

  it("a failing DDL closes the database and removes the temp directory", async () => {
    let path = "";
    const failing = openTestApp({
      where: "file",
      ddl: "CREATE TABLE nope (",
      collections: tasks,
      open: (p, o) => {
        path = p;
        return openNodeSqlite(p, o);
      },
    });
    await expect(failing).rejects.toThrow();
    expect(path).not.toBe("");
    expect(existsSync(dirname(path))).toBe(false);
  });
});
