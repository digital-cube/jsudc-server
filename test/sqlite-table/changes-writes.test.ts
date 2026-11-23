// sqlite_table's writes notify the change feed — the `mutate_many` and `mutate`
// scenarios of test/changes-writes.test.ts on SQLite: one notice after the commit
// (another connection already sees the change when it is published), each stream told
// only the rows its scope sees (the source hands them to `changedRows`), and none when
// the request failed or an `onMutate` hook threw.
import {
  type ChangeEvent,
  type FilterNode,
  requestKind,
  type SchemaDocInput,
  SchemaDocSchema,
  UdcError,
  type UdcMessage,
  ViewConfigSchema,
} from "@jsudc/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ChangeNotice, createChangeFeed, MemoryChangeBus } from "../../src/changes.js";
import { createDispatcher, type Dispatcher } from "../../src/dispatcher.js";
import { CollectionRegistry } from "../../src/registry.js";
import {
  type SqliteDatabase,
  type SqliteOnMutateHook,
  SqliteTableSource,
} from "../../src/sqlite.js";
import { openWith, SETUPS, tempFile } from "./helpers.js";

const schema = SchemaDocSchema.parse({
  version: "v1",
  fields: {
    tenant: { type: "string" },
    subject: { type: "string", required: true },
    order: { type: "integer" },
  },
} satisfies SchemaDocInput);
const view = ViewConfigSchema.parse({ columns: [{ field: "subject" }] });

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ID = { a1: uuid(1), a2: uuid(2), a3: uuid(3), b1: uuid(11), b2: uuid(12) };
const ROWS = [
  [ID.a1, "a", "one", 30],
  [ID.a2, "a", "two", 10],
  [ID.a3, "a", "three", 20],
  [ID.b1, "b", "four", 10],
  [ID.b2, "b", "five", 20],
] as const;

const DDL = `
  CREATE TABLE chg_task (
    id TEXT PRIMARY KEY, tenant TEXT, subject TEXT NOT NULL, "order" INTEGER,
    row_version INTEGER NOT NULL DEFAULT 1);
  ${ROWS.map(([id, t, s, o]) => `INSERT INTO chg_task (id, tenant, subject, "order") VALUES ('${id}', '${t}', '${s}', ${o});`).join("\n")}
`;

interface Ctx {
  tenant: string | null;
}
const A: Ctx = { tenant: "a" };
const B: Ctx = { tenant: "b" };
const ADMIN: Ctx = { tenant: null };

function rowScope(ctx: Ctx): FilterNode | undefined {
  return ctx.tenant === null ? undefined : { field: "tenant", op: "eq", value: ctx.tenant };
}

/** A memory bus that records every notice and, when asked, what another connection reads then. */
class RecordingBus extends MemoryChangeBus {
  notices: ChangeNotice[] = [];
  seen: (string | null)[] = [];
  check: ((n: ChangeNotice) => Promise<string | null>) | undefined;

  override async publish(notice: ChangeNotice): Promise<void> {
    this.notices.push(notice);
    if (this.check) this.seen.push(await this.check(notice));
    super.publish(notice);
  }
}

describe.each(SETUPS)("sqlite_table writes notify ($where, $driver)", ({ where, driver }) => {
  let db: SqliteDatabase;
  /** For a file: a second `SqliteDatabase` on it, as another process would have. */
  let probe: SqliteDatabase | undefined;
  let dispatcher: Dispatcher;
  let bus: RecordingBus;
  let toA: ChangeEvent[];
  let toB: ChangeEvent[];

  const committed = async (id: string): Promise<string | null> => {
    const row = await (probe ?? db).get<{ subject: string }>({
      sql: "SELECT subject FROM chg_task WHERE id = ?",
      params: [id],
    });
    return row ? row.subject : "<deleted>";
  };

  async function fresh(): Promise<void> {
    const path = where === "file" ? tempFile() : "memory";
    db = await openWith(driver, path);
    await db.exec(DDL);
    probe = where === "file" ? await openWith(driver, path) : undefined;
  }

  function build(onMutate?: SqliteOnMutateHook, more: { mutateManyLimit?: number } = {}) {
    const source = new SqliteTableSource({
      db,
      schema,
      table: "chg_task",
      versionColumn: "row_version",
      ...(onMutate ? { onMutate } : {}),
    });
    const registry = new CollectionRegistry();
    registry.register({ name: "chg_task", source, view });
    bus = new RecordingBus();
    const feed = createChangeFeed({ bus, coalesce: false });
    dispatcher = createDispatcher<Ctx>(registry, {
      log: { error: vi.fn() },
      rowScope,
      changes: feed,
      ...more,
    });
    toA = [];
    toB = [];
    feed.subscribe({ scopes: new Map([["chg_task", rowScope(A)]]), send: (e) => toA.push(e) });
    feed.subscribe({ scopes: new Map([["chg_task", rowScope(B)]]), send: (e) => toB.push(e) });
  }

  beforeEach(async () => {
    await fresh();
    build();
  });

  async function run(action: string, payload: object, ctx: Ctx): Promise<UdcMessage> {
    return dispatcher.dispatch({ kind: requestKind(action), id: "t", payload }, ctx);
  }

  async function ok(action: string, payload: object, ctx: Ctx) {
    const res = await run(action, payload, ctx);
    expect(res.kind, JSON.stringify(res.payload)).toBe(`udc.${action}.ok`);
    return res.payload as Record<string, unknown>;
  }

  async function err(action: string, payload: object, ctx: Ctx) {
    const res = await run(action, payload, ctx);
    expect(res.kind, JSON.stringify(res.payload)).toBe(`udc.${action}.err`);
    return res.payload as { code: string };
  }

  it("mutate_many by ids: one notice after commit, the owner told its ids", async () => {
    bus.check = () => committed(ID.a1);
    const res = await ok(
      "mutate_many",
      { collection: "chg_task", op: "update", ids: [ID.a1, ID.a2, ID.b1], row: { subject: "x" } },
      A,
    );
    expect(res).toMatchObject({ updated: 2 });
    expect(bus.notices).toHaveLength(1);
    expect(bus.notices[0]).toMatchObject({ collection: "chg_task", op: "update" });
    expect([...(bus.notices[0]?.ids ?? [])].sort()).toEqual([ID.a1, ID.a2]);
    expect(bus.seen).toEqual(["x"]);
    expect(toA).toHaveLength(1);
    expect([...(toA[0]?.ids ?? [])].sort()).toEqual([ID.a1, ID.a2]);
    expect(toB).toEqual([]);
  });

  it("mutate_many delete by filter, as admin: each tenant told only its own rows", async () => {
    bus.check = () => committed(ID.b2);
    await ok(
      "mutate_many",
      {
        collection: "chg_task",
        op: "delete",
        filter: { field: "subject", op: "in", value: ["one", "five"] },
      },
      ADMIN,
    );
    expect(bus.notices).toHaveLength(1);
    expect(bus.seen).toEqual(["<deleted>"]);
    expect(toA).toEqual([{ collection: "chg_task", op: "delete", ids: [ID.a1] }]);
    expect(toB).toEqual([{ collection: "chg_task", op: "delete", ids: [ID.b2] }]);
  });

  it("mutate_many by filter as admin, with the hook: the rows the hook saw are what the feed tests", async () => {
    build(() => undefined);
    await ok(
      "mutate_many",
      {
        collection: "chg_task",
        op: "update",
        filter: { field: "order", op: "eq", value: 10 },
        row: { subject: "ten" },
      },
      ADMIN,
    );
    expect(toA).toEqual([{ collection: "chg_task", op: "update", ids: [ID.a2] }]);
    expect(toB).toEqual([{ collection: "chg_task", op: "update", ids: [ID.b1] }]);
  });

  it("mutate_many that matched nothing, or failed, notifies nothing", async () => {
    await ok(
      "mutate_many",
      { collection: "chg_task", op: "update", ids: [ID.b1], row: { subject: "x" } },
      A,
    );
    build(undefined, { mutateManyLimit: 1 });
    const refused = await err(
      "mutate_many",
      { collection: "chg_task", op: "delete", ids: [ID.a1, ID.a2] },
      A,
    );
    expect(refused.code).toBe("validation_error");
    build();
    await err(
      "mutate_many",
      { collection: "chg_task", op: "update", ids: [ID.a1], row: { subject: 5 } },
      A,
    );
    expect(bus.notices).toEqual([]);
    expect(toA).toEqual([]);
  });

  it("a failed mutate notifies nothing", async () => {
    await err(
      "mutate",
      { collection: "chg_task", op: "update", id: ID.a1, row: {}, expected_version: 99 },
      A,
    );
    await err("mutate", { collection: "chg_task", op: "delete", id: ID.b1 }, A);
    expect(bus.notices).toEqual([]);
  });

  it("an onMutate hook that throws rolls the write back and notifies nothing", async () => {
    build(() => {
      throw new UdcError("forbidden", "no");
    });
    for (const [action, payload] of [
      ["mutate", { collection: "chg_task", op: "update", id: ID.a1, row: { subject: "x" } }],
      [
        "mutate_many",
        { collection: "chg_task", op: "update", ids: [ID.a1], row: { subject: "x" } },
      ],
    ] as const) {
      expect((await run(action, payload, A)).kind).toBe(`udc.${action}.err`);
    }
    expect(bus.notices).toEqual([]);
    expect(await committed(ID.a1)).toBe("one");
  });

  it("a hook that succeeds: update then delete by ids, told to the owner", async () => {
    build(() => undefined);
    for (const op of ["update", "delete"] as const) {
      await ok(
        "mutate_many",
        {
          collection: "chg_task",
          op,
          ids: [ID.b1],
          ...(op === "update" ? { row: { subject: "y" } } : {}),
        },
        ADMIN,
      );
    }
    expect(toB).toEqual([
      { collection: "chg_task", op: "update", ids: [ID.b1] },
      { collection: "chg_task", op: "delete", ids: [ID.b1] },
    ]);
    expect(toA).toEqual([]);
  });
});
