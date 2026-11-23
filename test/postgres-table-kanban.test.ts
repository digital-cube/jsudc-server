// The kanban's drop over a `postgres_table` collection, end to end: collection directories whose
// source.yaml says `kind: postgres_table`, served by buildApp with a row scope, driven over HTTP by
// a real UdcClient through the calls `persistOrder` (jsudc-react/src/kanban/persist.ts) makes
// when the neighbours of a drop leave no room: `reindex` of the scope, the scope listed again
// sorted by the order field, then the `mutate` with the new order (and, for a card dropped into
// another column, the new bucket) and the version the fresh list carries. The SQLite twin is
// test/sqlite-table/kanban.test.ts; the expectations are the same.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectCollision,
  type FilterNode,
  orderBetween,
  type Row,
  UdcError,
  unauthenticatedError,
} from "@jsudc/core";
import { UdcClient } from "@jsudc/core/client";
import { sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, createDispatcher, loadRegistry } from "../src/index.js";
import { makeSource } from "../src/postgres.js";
import { listen } from "./changes-helpers.js";
import { useTestDb } from "./helpers.js";

const { db } = useTestDb();

const uuid = (n: number) => `0b6f9d4e-0000-4000-8000-${String(n).padStart(12, "0")}`;
const B = { todo: uuid(101), doing: uuid(102), done: uuid(103), other: uuid(104) };
const T = { t1: uuid(1), t2: uuid(2), t3: uuid(3), x: uuid(4), y: uuid(5), theirs: uuid(9) };

let app: FastifyInstance;
let client: UdcClient;
let root: string;

const SEED = sql.raw(`
  TRUNCATE ptk_ticket, ptk_bucket;
  INSERT INTO ptk_bucket (id, tenant, board_id, name, "order") VALUES
    ('${B.todo}', 'ana', 'board1', 'To do', 100),
    ('${B.doing}', 'ana', 'board1', 'Doing', 101),
    ('${B.done}', 'ana', 'board1', 'Done', 102),
    ('${B.other}', 'bob', 'board1', 'Theirs', 100);
  -- To do: no room between t1 and t2, nor between t2 and t3. Doing: x, y.
  INSERT INTO ptk_ticket (id, tenant, board_id, bucket_id, title, "order") VALUES
    ('${T.t1}', 'ana', 'board1', '${B.todo}', 't1', 100),
    ('${T.t2}', 'ana', 'board1', '${B.todo}', 't2', 101),
    ('${T.t3}', 'ana', 'board1', '${B.todo}', 't3', 102),
    ('${T.x}', 'ana', 'board1', '${B.doing}', 'x', 100),
    ('${T.y}', 'ana', 'board1', '${B.doing}', 'y', NULL),
    -- Another tenant's card in the same bucket id: never renumbered by ana.
    ('${T.theirs}', 'bob', 'board1', '${B.todo}', 'theirs', 100);
`);

function collection(name: string, schema: object, table: string) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "schema.json"),
    JSON.stringify({ version: "v1", core_fields: [], ...schema }),
  );
  writeFileSync(join(dir, "view.yaml"), "default_renderer: table\ncolumns:\n  - {field: title}\n");
  writeFileSync(
    join(dir, "source.yaml"),
    ["kind: postgres_table", "options:", `  table: ${table}`, "  version_column: version"].join(
      "\n",
    ),
  );
}

beforeAll(async () => {
  await db.execute(sql`DROP TABLE IF EXISTS ptk_ticket, ptk_bucket`);
  await db.execute(sql`
    CREATE TABLE ptk_bucket (
      id uuid PRIMARY KEY, tenant text NOT NULL, board_id text NOT NULL, name text NOT NULL,
      "order" integer, version integer NOT NULL DEFAULT 1)`);
  await db.execute(sql`
    CREATE TABLE ptk_ticket (
      id uuid PRIMARY KEY, tenant text NOT NULL, board_id text NOT NULL,
      bucket_id uuid REFERENCES ptk_bucket(id), title text NOT NULL,
      "order" integer, version integer NOT NULL DEFAULT 1)`);

  root = mkdtempSync(join(tmpdir(), "jsudc-pg-kanban-"));
  collection(
    "buckets",
    {
      fields: {
        tenant: { type: "string" },
        board_id: { type: "string" },
        name: { type: "string", required: true },
        order: { type: "integer" },
      },
    },
    "ptk_bucket",
  );
  collection(
    "tickets",
    {
      fields: {
        tenant: { type: "string" },
        board_id: { type: "string" },
        bucket_id: { type: "string" },
        title: { type: "string", required: true },
        order: { type: "integer" },
      },
    },
    "ptk_ticket",
  );
  const registry = loadRegistry(root, (asset, reg) => makeSource(asset, { registry: reg, db }));
  const dispatcher = createDispatcher<{ user: string }>(registry, {
    log: { error: (...a: unknown[]) => console.error(...a) },
    rowScope: (ctx) => ({ field: "tenant", op: "eq", value: ctx.user }),
  });
  const context = (req: FastifyRequest) => {
    const user = req.headers["x-user"];
    if (typeof user !== "string") throw unauthenticatedError();
    return { user };
  };
  app = await buildApp({ dispatcher, registry, context, swagger: false });
  client = new UdcClient({ httpUrl: await listen(app), headers: { "x-user": "ana" } });
});

afterAll(async () => {
  await app?.close();
  await db.execute(sql`DROP TABLE IF EXISTS ptk_ticket, ptk_bucket`);
  if (root) rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.execute(SEED);
});

interface Drop {
  collection: string;
  orderField: string;
  scope: Record<string, string>;
  id: string;
  prevId: string | null;
  nextId: string | null;
  /** The version the board's cache holds for the moved row. */
  version: number;
  patch: Record<string, unknown>;
}

const orderOf = (row: Row | undefined, field: string) => {
  const v = row?.[field];
  return typeof v === "number" ? v : null;
};

/** `persistOrder`'s calls, one by one, recorded; the plan's neighbours read from the scope. */
async function persistOrder(drop: Drop, cached: Map<string, number | null>) {
  const calls: string[] = [];
  const { collection, orderField, scope } = drop;
  const between = (orders: Map<string, number | null>) => {
    const prev = drop.prevId ? (orders.get(drop.prevId) ?? null) : null;
    const next = drop.nextId ? (orders.get(drop.nextId) ?? null) : null;
    return { order: orderBetween(prev, next), collision: detectCollision(prev, next) };
  };
  let plan = between(cached);
  let version = drop.version;
  if (plan.collision) {
    const { updated } = await client.reindex({ collection, scope, order_field: orderField });
    calls.push(`reindex ${updated}`);
    const filter: FilterNode = {
      and: Object.entries(scope).map(([field, value]) => ({ field, op: "eq" as const, value })),
    };
    const fresh = await client.list({
      collection,
      filter,
      sort: [{ field: orderField }],
      page: { limit: 1000 },
    });
    calls.push(`list ${fresh.rows.length}`);
    plan = between(new Map(fresh.rows.map((r) => [r.__meta.id, orderOf(r, orderField)])));
    if (plan.collision) throw new Error("no room between the neighbours, even after a reindex");
    const moved = fresh.rows.find((r) => r.__meta.id === drop.id);
    if (moved) version = moved.__meta.version;
    else {
      version = (await client.read(collection, drop.id)).row.__meta.version;
      calls.push("read");
    }
  }
  const { row } = await client.mutate({
    collection,
    op: "update",
    id: drop.id,
    row: { ...drop.patch, [orderField]: plan.order },
    expected_version: version,
  });
  calls.push(`mutate ${plan.order} v${version}`);
  return { calls, row };
}

async function column(collection: string, scope: FilterNode, field = "order") {
  const { rows } = await client.list({ collection, filter: scope, sort: [{ field }] });
  return rows.map((r) => [r.title ?? r.name, r[field] ?? null, r.__meta.version]);
}

const ticketOrders = async () =>
  new Map(
    (await client.list({ collection: "tickets", page: { limit: 100 } })).rows.map((r) => [
      r.__meta.id,
      orderOf(r, "order"),
    ]),
  );

describe("persistOrder over a postgres_table kanban", () => {
  it("describe offers reindex on both collections", async () => {
    for (const name of ["tickets", "buckets"]) {
      const res = await client.describe(name);
      expect(res.capabilities).toMatchObject({ mutate: true, reindex: true });
    }
  });

  it("a card dropped into another column between two that leave no room: reindex, list, mutate", async () => {
    // y (order NULL) from Doing into To do between t1 (100) and t2 (101).
    const { calls, row } = await persistOrder(
      {
        collection: "tickets",
        orderField: "order",
        scope: { bucket_id: B.todo },
        id: T.y,
        prevId: T.t1,
        nextId: T.t2,
        version: 1,
        patch: { bucket_id: B.todo },
      },
      await ticketOrders(),
    );
    // The moved card was outside the scope: its version is read, the reindex left it at 1.
    expect(calls).toEqual(["reindex 3", "list 3", "read", "mutate 150 v1"]);
    expect(row).toMatchObject({ bucket_id: B.todo, order: 150, __meta: { id: T.y, version: 2 } });
    expect(await column("tickets", { field: "bucket_id", op: "eq", value: B.todo })).toEqual([
      ["t1", 100, 2],
      ["y", 150, 2],
      ["t2", 200, 2],
      ["t3", 300, 2],
    ]);
    // Doing keeps x; bob's card in the same bucket id is untouched.
    expect(await column("tickets", { field: "bucket_id", op: "eq", value: B.doing })).toEqual([
      ["x", 100, 1],
    ]);
    const theirs = await db.execute<{ order: number; version: number }>(
      sql`SELECT "order", version FROM ptk_ticket WHERE id = ${T.theirs}::uuid`,
    );
    expect(theirs.rows).toEqual([{ order: 100, version: 1 }]);
  });

  it("a card moved within its column: the reindex bumped its version, the mutate sends the fresh one", async () => {
    // t3 up between t1 (100) and t2 (101): the cache holds t3 at version 1.
    const { calls, row } = await persistOrder(
      {
        collection: "tickets",
        orderField: "order",
        scope: { bucket_id: B.todo },
        id: T.t3,
        prevId: T.t1,
        nextId: T.t2,
        version: 1,
        patch: {},
      },
      await ticketOrders(),
    );
    expect(calls).toEqual(["reindex 3", "list 3", "mutate 150 v2"]);
    expect(row.__meta.version).toBe(3);
    expect(await column("tickets", { field: "bucket_id", op: "eq", value: B.todo })).toEqual([
      ["t1", 100, 2],
      ["t3", 150, 3],
      ["t2", 200, 2],
    ]);
  });

  it("the cached version after a reindex is refused with version_conflict", async () => {
    await client.reindex({ collection: "tickets", scope: { bucket_id: B.todo } });
    const err = await client
      .mutate({
        collection: "tickets",
        op: "update",
        id: T.t3,
        row: { order: 150 },
        expected_version: 1,
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(UdcError);
    expect((err as UdcError).code).toBe("version_conflict");
  });

  it("a column header dragged between two buckets that leave no room (the board's scope)", async () => {
    const buckets = new Map(
      (await client.list({ collection: "buckets" })).rows.map((r) => [
        r.__meta.id,
        orderOf(r, "order"),
      ]),
    );
    // Done between To do (100) and Doing (101).
    const { calls } = await persistOrder(
      {
        collection: "buckets",
        orderField: "order",
        scope: { board_id: "board1" },
        id: B.done,
        prevId: B.todo,
        nextId: B.doing,
        version: 1,
        patch: {},
      },
      buckets,
    );
    expect(calls).toEqual(["reindex 3", "list 3", "mutate 150 v2"]);
    expect(await column("buckets", { field: "board_id", op: "eq", value: "board1" })).toEqual([
      ["To do", 100, 2],
      ["Done", 150, 3],
      ["Doing", 200, 2],
    ]);
  });

  it("the list the board reads is sorted with NULLs last, ties by id", async () => {
    // As a host writes: the version column bumped with the order.
    await db.execute(sql`UPDATE ptk_ticket SET "order" = NULL, version = version + 1
      WHERE id = ${T.t1}::uuid`);
    await db.execute(sql`UPDATE ptk_ticket SET "order" = 102, version = version + 1
      WHERE id = ${T.t2}::uuid`);
    expect(await column("tickets", { field: "board_id", op: "eq", value: "board1" })).toEqual([
      ["x", 100, 1],
      ["t2", 102, 2],
      ["t3", 102, 1],
      ["t1", null, 2],
      ["y", null, 1],
    ]);
  });
});
