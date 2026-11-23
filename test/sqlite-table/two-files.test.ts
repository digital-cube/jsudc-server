// One vault, two SQLite files: `boards` in boards.db, `tickets` in tickets.db, each a
// `sqlite_table` whose source.yaml names its `database`, the host registering both
// handles by name (`SourceDeps.sqlite`). `tickets.board_id` is a lookup into `boards`
// and `boards` opens `tickets` through a `row_link`: neither needs a join, so neither
// needs the two files in one connection (no ATTACH).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lookupKeyOf, lookupKeysFilter, type Row, rowLinkCondition } from "@jsudc/core";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildApp,
  type CollectionRegistry,
  checkRegistryLinks,
  createDispatcher,
  loadRegistry,
  makeSource,
  type SqliteDatabase,
  sqliteVersionTriggerSql,
} from "../../src/index.js";
import { openNodeSqlite } from "../../src/sqlite.js";
import { tempDir } from "./helpers.js";

const B = (n: number) => `5a0c1f00-0000-4000-8000-00000000000${n}`;
const T = (n: number) => `7e2d3a00-0000-4000-8000-00000000000${n}`;

let dir: string;
let boardsDb: SqliteDatabase;
let ticketsDb: SqliteDatabase;
let registry: CollectionRegistry;
let app: FastifyInstance;

function collection(name: string, files: Record<string, string>) {
  const d = join(dir, "collections", name);
  mkdirSync(d, { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(d, file), text);
}

beforeAll(async () => {
  dir = tempDir();
  boardsDb = openNodeSqlite(join(dir, "boards.db"), { name: "boards" });
  ticketsDb = openNodeSqlite(join(dir, "tickets.db"), { name: "tickets" });
  await boardsDb.exec(`
    CREATE TABLE board (id TEXT PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1);
    ${sqliteVersionTriggerSql({ table: "board", versionColumn: "version" })}
    INSERT INTO board (id, name) VALUES ('${B(1)}', 'Roadmap'), ('${B(2)}', 'Bugs'), ('${B(3)}', 'Empty');`);
  await ticketsDb.exec(`
    CREATE TABLE ticket (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, board_id TEXT,
      version INTEGER NOT NULL DEFAULT 1);
    ${sqliteVersionTriggerSql({ table: "ticket", versionColumn: "version" })}
    INSERT INTO ticket (id, title, board_id) VALUES
      ('${T(1)}', 'Plan Q1', '${B(1)}'),
      ('${T(2)}', 'Crash on save', '${B(2)}'),
      ('${T(3)}', 'Plan Q2', '${B(1)}'),
      ('${T(4)}', 'Unfiled', NULL);`);

  collection("boards", {
    "schema.json": JSON.stringify({
      version: "v1",
      core_fields: [],
      fields: { name: { type: "string", required: true } },
    }),
    "view.yaml": [
      "default_renderer: table",
      "columns:",
      "  - {field: name}",
      "row_link: {collection: tickets, filter: {field: board_id, value_from: id}}",
    ].join("\n"),
    "source.yaml": [
      "kind: sqlite_table",
      "options:",
      "  database: boards",
      "  table: board",
      "  version_column: version",
    ].join("\n"),
  });
  collection("tickets", {
    "schema.json": JSON.stringify({
      version: "v1",
      core_fields: [],
      fields: {
        title: { type: "string", required: true },
        board_id: {
          type: "lookup",
          index: true,
          lookup: { collection: "boards", label_field: "name" },
        },
      },
    }),
    "view.yaml": "default_renderer: table\ncolumns:\n  - {field: title}\n  - {field: board_id}\n",
    "source.yaml": [
      "kind: sqlite_table",
      "options:",
      "  database: tickets",
      "  table: ticket",
      "  version_column: version",
    ].join("\n"),
  });

  registry = loadRegistry(join(dir, "collections"), (asset, reg) =>
    makeSource(asset, { registry: reg, sqlite: { boards: boardsDb, tickets: ticketsDb } }),
  );
  const dispatcher = createDispatcher(registry, {
    log: { error: (...a: unknown[]) => console.error(...a) },
  });
  // `udcPlugin` runs checkRegistryLinks before it serves: building the app is the first check.
  app = await buildApp({ dispatcher, registry, swagger: false });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  boardsDb?.close();
  ticketsDb?.close();
});

async function post(action: string, payload: object) {
  const res = await app.inject({ method: "POST", url: `/udc/${action}`, payload });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { kind: string; payload: Record<string, unknown> };
  expect(body.kind, JSON.stringify(body.payload)).toBe(`udc.${action}.ok`);
  return body.payload;
}

const rowsOf = (p: Record<string, unknown>) => p.rows as Row[];
const titles = (p: Record<string, unknown>) => rowsOf(p).map((r) => r.title);

describe("two collections in two SQLite files", () => {
  it("each collection reads its own file", () => {
    expect(registry.get("boards").source.kind).toBe("sqlite_table");
    expect(registry.get("tickets").source.kind).toBe("sqlite_table");
  });

  it("checkRegistryLinks passes: the lookup and the row_link reach across files", async () => {
    await expect(checkRegistryLinks(registry)).resolves.toBeUndefined();
  });

  it("a lookup label resolves with an ordinary list on the target, as the client asks it", async () => {
    const tickets = rowsOf(
      await post("list", { collection: "tickets", sort: [{ field: "title" }] }),
    );
    const describe = await post("describe", { collection: "tickets" });
    const lookup = (
      describe.schema as { fields: Record<string, { lookup: Parameters<typeof lookupKeyOf>[1] }> }
    ).fields.board_id?.lookup;
    if (!lookup) throw new Error("board_id has no lookup");
    const keys = [...new Set(tickets.map((t) => t.board_id).filter((k) => k != null))];
    const boards = rowsOf(
      await post("list", {
        collection: lookup.collection,
        filter: lookupKeysFilter(lookup, keys),
        page: { limit: keys.length },
      }),
    );
    const label = new Map(boards.map((b) => [lookupKeyOf(b, lookup), b[lookup.label_field]]));
    expect(
      tickets.map((t) => [t.title, t.board_id == null ? null : label.get(t.board_id)]),
    ).toEqual([
      ["Crash on save", "Bugs"],
      ["Plan Q1", "Roadmap"],
      ["Plan Q2", "Roadmap"],
      ["Unfiled", null],
    ]);
  });

  it("a row_link opens the other file's collection filtered by the row", async () => {
    const boards = rowsOf(await post("list", { collection: "boards", sort: [{ field: "name" }] }));
    const link = registry.get("boards").view.row_link;
    if (!link) throw new Error("boards has no row_link");
    const per = await Promise.all(
      boards.map(async (b) => [
        b.name,
        titles(
          await post("list", {
            collection: link.collection,
            filter: rowLinkCondition(b, link),
            sort: [{ field: "title" }],
          }),
        ),
      ]),
    );
    expect(per).toEqual([
      ["Bugs", ["Crash on save"]],
      ["Empty", []],
      ["Roadmap", ["Plan Q1", "Plan Q2"]],
    ]);
  });

  it("filters by the lookup key", async () => {
    const eq = await post("list", {
      collection: "tickets",
      filter: { field: "board_id", op: "eq", value: B(1) },
      sort: [{ field: "title" }],
    });
    expect(titles(eq)).toEqual(["Plan Q1", "Plan Q2"]);
    const inList = await post("list", {
      collection: "tickets",
      filter: { field: "board_id", op: "in", value: [B(2), B(3)] },
    });
    expect(titles(inList)).toEqual(["Crash on save"]);
    const none = await post("list", {
      collection: "tickets",
      filter: { field: "board_id", op: "is_null" },
    });
    expect(titles(none)).toEqual(["Unfiled"]);
  });

  it("sorts by the lookup key, and pages through that sort", async () => {
    const sort = [{ field: "board_id", dir: "desc" }, { field: "title" }];
    const first = await post("list", { collection: "tickets", sort, page: { limit: 2 } });
    expect(titles(first)).toEqual(["Crash on save", "Plan Q1"]);
    const next = await post("list", {
      collection: "tickets",
      sort,
      page: { limit: 10, cursor: first.next_cursor },
    });
    // The ticket without a board comes last.
    expect(titles(next)).toEqual(["Plan Q2", "Unfiled"]);
  });

  it("a write in one file opens no transaction in the other", async () => {
    const tx = vi.spyOn(boardsDb, "transaction");
    const read = vi.spyOn(boardsDb, "read");
    try {
      // Hold the boards file's write turn for the whole write: a tickets write that needed
      // it would wait for its busy timeout and answer `busy`.
      let release!: () => void;
      const held = new Promise<void>((r) => {
        release = r;
      });
      const holding = boardsDb.transaction(() => held);
      tx.mockClear();

      const inserted = await post("mutate", {
        collection: "tickets",
        op: "insert",
        row: { title: "Triage", board_id: B(2) },
      });
      const id = (inserted.row as Row).__meta.id;
      await post("mutate", {
        collection: "tickets",
        op: "update",
        id,
        expected_version: (inserted.row as Row).__meta.version,
        row: { board_id: B(1) },
      });
      await post("mutate", { collection: "tickets", op: "delete", id });

      expect(tx).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      release();
      await holding;
    } finally {
      tx.mockRestore();
      read.mockRestore();
    }
    // And the other way round: a boards write leaves tickets.db alone.
    const ttx = vi.spyOn(ticketsDb, "transaction");
    try {
      await post("mutate", {
        collection: "boards",
        op: "update",
        id: B(3),
        expected_version: 1,
        row: { name: "Archive" },
      });
      expect(ttx).not.toHaveBeenCalled();
    } finally {
      ttx.mockRestore();
    }
    const row = await ticketsDb.get<{ n: number }>("SELECT count(*) AS n FROM ticket");
    expect(row?.n).toBe(4);
    expect(
      (await boardsDb.get<{ name: string }>(`SELECT name FROM board WHERE id = '${B(3)}'`))?.name,
    ).toBe("Archive");
  });
});
