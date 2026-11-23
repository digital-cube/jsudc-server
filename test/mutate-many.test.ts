// `mutate_many` through the dispatcher, on postgres_jsonb, postgres_table (both native, one
// transaction) and memory (the generic fallback): by ids, by filter, by filter with
// except_ids, update and delete, under two request contexts held to `tenant = ctx.tenant`;
// the patch checked before anything is written, and the cap on rows per request.
import {
  type FilterNode,
  type MutateManyResponse,
  type Row,
  requestKind,
  type SchemaDocInput,
  SchemaDocSchema,
  ViewConfigSchema,
} from "@jsudc/core";
import { sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCollectionTableSql } from "../src/db/schema.js";
import { createDispatcher, type Dispatcher } from "../src/dispatcher.js";
import { DEFAULT_MUTATE_MANY_LIMIT } from "../src/index.js";
import { PostgresTableSource } from "../src/postgres.js";
import { CollectionRegistry } from "../src/registry.js";
import { MemorySource } from "../src/sources/memory.js";
import { PostgresJsonbSource } from "../src/sources/postgres-jsonb.js";
import type { Source } from "../src/sources/source.js";
import { useTestDb } from "./helpers.js";

const { db } = useTestDb();

const jsonbSchemaJson: SchemaDocInput = {
  version: "v1",
  fields: {
    tenant: { type: "string" },
    subject: { type: "string", required: true },
    folder: { type: "string" },
    size: { type: "integer", min: 0 },
    archived: { type: "bool" },
  },
};
const jsonbSchema = SchemaDocSchema.parse(jsonbSchemaJson);
/** The table's schema: a column `created_at` the requests may not write. */
const schema = SchemaDocSchema.parse({
  ...jsonbSchemaJson,
  fields: { ...jsonbSchemaJson.fields, created_at: { type: "datetime" } },
});

const view = ViewConfigSchema.parse({ columns: [{ field: "subject" }] });

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A = [uuid(1), uuid(2), uuid(3), uuid(4)] as const;
const B = [uuid(11), uuid(12)] as const;
const MISSING = uuid(99);

const ROWS = [
  { id: A[0], tenant: "a", subject: "one", folder: "inbox", size: 1, archived: false },
  { id: A[1], tenant: "a", subject: "two", folder: "inbox", size: 2, archived: false },
  { id: A[2], tenant: "a", subject: "three", folder: "inbox", size: 3, archived: false },
  { id: A[3], tenant: "a", subject: "four", folder: "sent", size: 4, archived: false },
  { id: B[0], tenant: "b", subject: "five", folder: "inbox", size: 5, archived: false },
  { id: B[1], tenant: "b", subject: "six", folder: "inbox", size: 6, archived: false },
];

interface Ctx {
  tenant: string | null;
}

function rowScope(ctx: Ctx): FilterNode | undefined {
  return ctx.tenant === null ? undefined : { field: "tenant", op: "eq", value: ctx.tenant };
}

interface Backend {
  name: "postgres_jsonb" | "postgres_table" | "memory";
  make(): Promise<Source>;
}

const BACKENDS: Backend[] = [
  {
    name: "postgres_jsonb",
    async make() {
      await db.execute(sql`TRUNCATE mm_message`);
      await db.execute(sql`
        INSERT INTO mm_message (id, data)
        SELECT (value->>'id')::uuid, value - 'id'
        FROM jsonb_array_elements(${JSON.stringify(ROWS)}::jsonb)`);
      return new PostgresJsonbSource({ db, table: "mm_message", initialSchema: jsonbSchema });
    },
  },
  {
    name: "postgres_table",
    async make() {
      await db.execute(sql`TRUNCATE mm_message_t`);
      for (const r of ROWS) {
        await db.execute(sql`
          INSERT INTO mm_message_t (id, tenant, subject, folder, size, archived)
          VALUES (${r.id}::uuid, ${r.tenant}, ${r.subject}, ${r.folder}, ${r.size}, ${r.archived})`);
      }
      return new PostgresTableSource({
        db,
        schema,
        table: "mm_message_t",
        versionColumn: "row_version",
        fields: { created_at: { readOnly: true } },
      });
    },
  },
  {
    name: "memory",
    async make() {
      return new MemorySource({
        schema: jsonbSchema,
        rows: ROWS.map(({ id, ...data }) => ({ __meta: { id }, ...data })),
      });
    },
  },
];

beforeAll(async () => {
  await db.execute(sql.raw(createCollectionTableSql("mm_message")));
  await db.execute(sql`DROP TABLE IF EXISTS mm_message_t`);
  await db.execute(sql`
    CREATE TABLE mm_message_t (
      id uuid PRIMARY KEY, tenant text, subject text NOT NULL, folder text, size integer,
      archived boolean, row_version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now())`);
});

type Answer =
  | { ok: true; payload: MutateManyResponse }
  | { ok: false; payload: { code: string; message: string; details?: Record<string, unknown> } };

describe.each(BACKENDS)("mutate_many on $name", (backend) => {
  let source: Source;
  let dispatcher: Dispatcher;
  const log = { error: vi.fn() };

  function build(limit?: number): Dispatcher {
    const registry = new CollectionRegistry();
    registry.register({ name: "message", source, view });
    return createDispatcher<Ctx>(registry, {
      log,
      rowScope,
      ...(limit === undefined ? {} : { mutateManyLimit: limit }),
    });
  }

  beforeEach(async () => {
    source = await backend.make();
    dispatcher = build();
  });

  async function call(tenant: string | null, payload: object, d = dispatcher): Promise<Answer> {
    const res = await d.dispatch(
      { kind: requestKind("mutate_many"), id: "m", payload: { collection: "message", ...payload } },
      { tenant },
    );
    return res.kind === "udc.mutate_many.ok"
      ? { ok: true, payload: res.payload as MutateManyResponse }
      : { ok: false, payload: res.payload as Extract<Answer, { ok: false }>["payload"] };
  }

  async function ok(tenant: string | null, payload: object, d = dispatcher) {
    const res = await call(tenant, payload, d);
    expect(res.ok, JSON.stringify(res.payload)).toBe(true);
    return res.payload as MutateManyResponse;
  }

  async function err(tenant: string | null, payload: object, d = dispatcher) {
    const res = await call(tenant, payload, d);
    expect(res.ok, JSON.stringify(res.payload)).toBe(false);
    return res.payload as Extract<Answer, { ok: false }>["payload"];
  }

  /** Every row as it is now, by id, unscoped. */
  async function rows(): Promise<Map<string, Row>> {
    const res = await source.list({ page: { limit: 100 } });
    return new Map(res.rows.map((r) => [r.__meta.id, r]));
  }

  it("says capabilities.mutate_many in describe and collections", async () => {
    const d = await dispatcher.dispatch(
      { kind: requestKind("describe"), id: "d", payload: { collection: "message" } },
      { tenant: "a" },
    );
    expect((d.payload as { capabilities: { mutate_many: boolean } }).capabilities.mutate_many).toBe(
      true,
    );
  });

  it("updates by ids, bumping each version; the rest untouched", async () => {
    const res = await ok("a", { op: "update", ids: [A[0], A[1]], row: { archived: true } });
    expect(res).toEqual({ updated: 2, failed: [] });
    const now = await rows();
    for (const id of [A[0], A[1]]) {
      expect(now.get(id)).toMatchObject({ archived: true, __meta: { version: 2 } });
    }
    for (const id of [A[2], A[3], B[0], B[1]]) {
      expect(now.get(id)).toMatchObject({ archived: false, __meta: { version: 1 } });
    }
  });

  it("deletes by ids", async () => {
    expect(await ok("a", { op: "delete", ids: [A[2], A[3]] })).toEqual({ updated: 2, failed: [] });
    const now = await rows();
    expect(now.has(A[2])).toBe(false);
    expect(now.has(A[3])).toBe(false);
    expect(now.size).toBe(4);
  });

  it("reports a missing id, a malformed one, and counts a repeated one once", async () => {
    const res = await ok("a", {
      op: "update",
      ids: [A[0], MISSING, A[0], "not-a-uuid"],
      row: { folder: "done" },
    });
    expect(res.updated).toBe(1);
    expect(res.failed.map((f) => [f.id, f.code])).toEqual([
      [MISSING, "not_found"],
      ["not-a-uuid", "not_found"],
    ]);
    expect((await rows()).get(A[0])?.__meta.version).toBe(2);
  });

  it("updates by filter, inside the scope only", async () => {
    const res = await ok("a", {
      op: "update",
      filter: { field: "folder", op: "eq", value: "inbox" },
      row: { folder: "archive" },
    });
    expect(res).toEqual({ updated: 3, failed: [] });
    const now = await rows();
    expect([A[0], A[1], A[2]].map((id) => now.get(id)?.folder)).toEqual([
      "archive",
      "archive",
      "archive",
    ]);
    expect(now.get(A[3])?.folder).toBe("sent");
    // b's inbox is not a's to touch.
    expect([B[0], B[1]].map((id) => now.get(id)?.folder)).toEqual(["inbox", "inbox"]);
  });

  it("updates by filter except some ids", async () => {
    const res = await ok("a", {
      op: "update",
      filter: { field: "folder", op: "eq", value: "inbox" },
      except_ids: [A[1], MISSING],
      row: { archived: true },
    });
    expect(res).toEqual({ updated: 2, failed: [] });
    const now = await rows();
    expect(now.get(A[0])?.archived).toBe(true);
    expect(now.get(A[1])?.archived).toBe(false);
    expect(now.get(A[2])?.archived).toBe(true);
  });

  it("deletes by filter except some ids; { and: [] } is every row in scope", async () => {
    const res = await ok("a", { op: "delete", filter: { and: [] }, except_ids: [A[3]] });
    expect(res).toEqual({ updated: 3, failed: [] });
    expect([...(await rows()).keys()].sort()).toEqual([A[3], B[0], B[1]].sort());
  });

  it("an empty match changes nothing", async () => {
    expect(
      await ok("a", { op: "delete", filter: { field: "folder", op: "eq", value: "spam" } }),
    ).toEqual({ updated: 0, failed: [] });
    expect(await ok("a", { op: "delete", ids: [] })).toEqual({ updated: 0, failed: [] });
    expect((await rows()).size).toBe(6);
  });

  describe("two contexts", () => {
    it("the other tenant's ids come back as not_found and are untouched", async () => {
      const res = await ok("b", { op: "update", ids: [B[0], A[0], A[1]], row: { size: 50 } });
      expect(res.updated).toBe(1);
      expect(res.failed).toEqual([
        { id: A[0], code: "not_found", message: expect.any(String) },
        { id: A[1], code: "not_found", message: expect.any(String) },
      ]);
      const now = await rows();
      expect(now.get(B[0])?.size).toBe(50);
      expect(now.get(A[0])).toMatchObject({ size: 1, __meta: { version: 1 } });
      expect(now.get(A[1])).toMatchObject({ size: 2, __meta: { version: 1 } });
    });

    it("a delete by the other tenant's ids deletes nothing of theirs", async () => {
      const res = await ok("b", { op: "delete", ids: [A[0], A[1]] });
      expect(res.updated).toBe(0);
      expect(res.failed.map((f) => f.id)).toEqual([A[0], A[1]]);
      expect((await rows()).size).toBe(6);
    });

    it("a filter touches only the caller's rows", async () => {
      const res = await ok("b", { op: "delete", filter: { field: "size", op: "gte", value: 0 } });
      expect(res).toEqual({ updated: 2, failed: [] });
      expect([...(await rows()).keys()].sort()).toEqual([...A].sort());
    });

    it("a patch naming the scope field keeps the caller's value (the pin)", async () => {
      await ok("a", { op: "update", ids: [A[0]], row: { subject: "moved" } });
      const res = await call("a", { op: "update", ids: [A[0]], row: { tenant: "b" } });
      // The scope field is hidden from a scoped request: refused like an unknown field.
      expect(res.ok).toBe(false);
      expect((res.payload as { code: string }).code).toBe("validation_error");
      expect((await rows()).get(A[0])?.tenant).toBe("a");
    });

    it("refuses the hidden scope field in the filter", async () => {
      const e = await err("a", {
        op: "delete",
        filter: { field: "tenant", op: "eq", value: "b" },
      });
      expect(e.code).toBe("validation_error");
      expect((await rows()).size).toBe(6);
    });

    it("an unscoped context reaches every row", async () => {
      const res = await ok(null, {
        op: "update",
        filter: { field: "folder", op: "eq", value: "inbox" },
        row: { archived: true },
      });
      expect(res.updated).toBe(5);
    });
  });

  describe("the patch", () => {
    it("an invalid patch writes nothing", async () => {
      const e = await err("a", {
        op: "update",
        filter: { and: [] },
        row: { size: -1 },
      });
      expect(e.code).toBe("validation_error");
      const now = await rows();
      expect([...now.values()].every((r) => r.__meta.version === 1)).toBe(true);
    });

    it("an unknown field writes nothing", async () => {
      const e = await err("a", { op: "update", ids: [A[0], A[1]], row: { nope: 1 } });
      expect(e.code).toBe("validation_error");
      expect((await rows()).get(A[0])?.__meta.version).toBe(1);
    });

    it("an update without a row, or both ids and filter, is a validation_error", async () => {
      expect((await err("a", { op: "update", ids: [A[0]] })).code).toBe("validation_error");
      expect((await err("a", { op: "delete", ids: [A[0]], filter: { and: [] } })).code).toBe(
        "validation_error",
      );
    });

    it("an unknown filter field writes nothing", async () => {
      const e = await err("a", {
        op: "delete",
        filter: { field: "nope", op: "eq", value: 1 },
      });
      expect(e.code).toBe("validation_error");
      expect((await rows()).size).toBe(6);
    });
  });

  describe("the cap", () => {
    it("defaults to 10 000", () => {
      expect(DEFAULT_MUTATE_MANY_LIMIT).toBe(10_000);
    });

    it("refuses a filter reaching more rows, before anything is written", async () => {
      const capped = build(2);
      const e = await err(
        "a",
        { op: "update", filter: { field: "folder", op: "eq", value: "inbox" }, row: { size: 9 } },
        capped,
      );
      expect(e.code).toBe("validation_error");
      expect(e.details).toMatchObject({ reason: "too_many_rows", limit: 2, by: "filter" });
      const now = await rows();
      expect([...now.values()].every((r) => r.__meta.version === 1)).toBe(true);
    });

    it("counts after except_ids, and in scope only", async () => {
      const capped = build(2);
      const res = await ok(
        "a",
        {
          op: "update",
          filter: { field: "folder", op: "eq", value: "inbox" },
          except_ids: [A[2]],
          row: { size: 9 },
        },
        capped,
      );
      expect(res.updated).toBe(2);
      // b has two inbox rows: exactly the cap.
      expect((await ok("b", { op: "delete", filter: { and: [] } }, capped)).updated).toBe(2);
    });

    it("refuses more ids than the cap", async () => {
      const capped = build(2);
      const e = await err("a", { op: "delete", ids: [A[0], A[1], A[2]] }, capped);
      expect(e.details).toMatchObject({ reason: "too_many_rows", limit: 2, by: "ids" });
      expect((await rows()).size).toBe(6);
    });

    it("refuses a bad cap when the dispatcher is built", () => {
      expect(() => build(0)).toThrow(/mutateManyLimit/);
    });
  });
});

describe("mutate_many on postgres_table", () => {
  it("refuses a read-only field in the patch, writing nothing", async () => {
    const source = await (BACKENDS[1] as Backend).make();
    const registry = new CollectionRegistry();
    registry.register({ name: "message", source, view });
    const dispatcher = createDispatcher<Ctx>(registry, { log: { error: vi.fn() }, rowScope });
    const res = await dispatcher.dispatch(
      {
        kind: requestKind("mutate_many"),
        id: "m",
        payload: {
          collection: "message",
          op: "update",
          ids: [A[0]],
          row: { created_at: "2026-01-01T00:00:00Z", folder: "x" },
        },
      },
      { tenant: "a" },
    );
    expect(res.kind).toBe("udc.mutate_many.err");
    expect(res.payload).toMatchObject({ code: "validation_error" });
    expect((await source.read(A[0])).folder).toBe("inbox");
  });

  it("works when the collection has total_count: false", async () => {
    await (BACKENDS[1] as Backend).make();
    const source = new PostgresTableSource({
      db,
      schema,
      table: "mm_message_t",
      versionColumn: "row_version",
      totalCount: false,
      fields: { created_at: { readOnly: true } },
    });
    expect(source.capabilities.total_count).toBe(false);
    const registry = new CollectionRegistry();
    registry.register({ name: "message", source, view });
    const dispatcher = createDispatcher<Ctx>(registry, {
      log: { error: vi.fn() },
      rowScope,
      mutateManyLimit: 2,
    });
    const send = (payload: object) =>
      dispatcher.dispatch(
        {
          kind: requestKind("mutate_many"),
          id: "m",
          payload: { collection: "message", ...payload },
        },
        { tenant: "a" },
      );
    const refused = await send({ op: "delete", filter: { and: [] } });
    expect(refused.payload).toMatchObject({ details: { reason: "too_many_rows" } });
    const done = await send({ op: "delete", filter: { field: "folder", op: "eq", value: "sent" } });
    expect(done.payload).toEqual({ updated: 1, failed: [] });
  });

  it("is unsupported on a read-only source", async () => {
    const source = new PostgresTableSource({ db, schema, table: "mm_message_t", readOnly: true });
    expect(source.capabilities.mutate_many).toBe(false);
    const registry = new CollectionRegistry();
    registry.register({ name: "message", source, view });
    const dispatcher = createDispatcher(registry, { log: { error: vi.fn() } });
    const res = await dispatcher.dispatch({
      kind: requestKind("mutate_many"),
      id: "m",
      payload: { collection: "message", op: "delete", ids: [A[0]] },
    });
    expect(res.payload).toMatchObject({ code: "unsupported_op" });
  });
});
