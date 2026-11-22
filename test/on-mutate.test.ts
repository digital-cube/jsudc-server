// The `onMutate` hook on both Postgres sources: what it sees, SQL it runs on the same
// transaction, what another connection sees while it runs, its failures (a UdcError as it
// is, anything else `internal`), a row it returns, and the database refusals before it.
import {
  type Row,
  requestKind,
  type SchemaDocInput,
  SchemaDocSchema,
  UdcError,
  ViewConfigSchema,
} from "@jsudc/core";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { connect } from "../src/db/client.js";
import { createDispatcher } from "../src/dispatcher.js";
import {
  type OnMutateHook,
  PostgresJsonbSource,
  PostgresTableSource,
  type RowChange,
} from "../src/index.js";
import { CollectionRegistry } from "../src/registry.js";
import type { Source, SourceContext } from "../src/sources/source.js";
import {
  companiesSchema,
  insertRows,
  rejectsWith,
  resetTables,
  TEST_DATABASE_URL,
  useTestDb,
} from "./helpers.js";

const { db } = useTestDb();
/** Another connection, outside the hook's transaction. */
const other = connect(TEST_DATABASE_URL);
afterAll(() => other.close());

const tableSchema = SchemaDocSchema.parse({
  version: "v1",
  fields: {
    name: { type: "string", required: true },
    city: { type: "string" },
    employees: { type: "integer", min: 0 },
  },
} satisfies SchemaDocInput);

interface Backend {
  name: string;
  make(onMutate: OnMutateHook): Source;
  reset(): Promise<void>;
  seed(rows: Record<string, unknown>[]): Promise<string[]>;
  /** The city of row `id` as another connection sees it; `undefined` when there is no row. */
  cityOutside(id: string): Promise<string | null | undefined>;
  countOutside(): Promise<number>;
}

const BACKENDS: Backend[] = [
  {
    name: "postgres_jsonb",
    make: (onMutate) =>
      new PostgresJsonbSource({ db, table: "companies", initialSchema: companiesSchema, onMutate }),
    reset: () => resetTables(db),
    seed: (rows) => insertRows(db, rows),
    cityOutside: async (id) =>
      (
        await other.db.execute<{ city: string | null }>(
          sql`SELECT data->>'city' AS city FROM companies WHERE id = ${id}::uuid`,
        )
      ).rows[0]?.city,
    countOutside: async () =>
      (await other.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM companies`)).rows[0]
        ?.n ?? -1,
  },
  {
    name: "postgres_table",
    make: (onMutate) =>
      new PostgresTableSource({
        db,
        schema: tableSchema,
        table: "om_company",
        versionColumn: "row_version",
        onMutate,
      }),
    reset: async () => {
      await db.execute(sql`TRUNCATE om_company`);
    },
    seed: async (rows) => {
      const ids: string[] = [];
      for (const r of rows) {
        const res = await db.execute<{ id: string }>(sql`
          INSERT INTO om_company (name, city, employees)
          VALUES (${r.name}, ${r.city ?? null}, ${r.employees ?? null}) RETURNING id::text`);
        ids.push(res.rows[0]?.id as string);
      }
      return ids;
    },
    cityOutside: async (id) =>
      (
        await other.db.execute<{ city: string | null }>(
          sql`SELECT city FROM om_company WHERE id = ${id}::uuid`,
        )
      ).rows[0]?.city,
    countOutside: async () =>
      (await other.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM om_company`))
        .rows[0]?.n ?? -1,
  },
];

const logged = async () =>
  (await db.execute<{ op: string; row_id: string }>(sql`SELECT op, row_id FROM om_log ORDER BY id`))
    .rows;

const sctx: SourceContext = { ctx: { user: "u1" }, collection: "company" };

beforeAll(async () => {
  await db.execute(sql`DROP TABLE IF EXISTS om_company, om_log`);
  await db.execute(sql`
    CREATE TABLE om_company (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, city text,
      employees integer, row_version integer NOT NULL DEFAULT 1)`);
  await db.execute(sql`CREATE TABLE om_log (id serial PRIMARY KEY, op text, row_id text)`);
});

describe.each(BACKENDS)("onMutate on $name", (backend) => {
  let hook: OnMutateHook = () => undefined;
  let source: Source;
  let id: string;

  beforeEach(async () => {
    await backend.reset();
    await db.execute(sql`TRUNCATE om_log`);
    hook = () => undefined;
    source = backend.make((ctx, change, tx) => hook(ctx, change, tx));
    [id] = (await backend.seed([{ name: "Alfa", city: "Niš", employees: 3 }])) as [string];
  });

  it("sees the context, the collection, before, after and the patch of each op", async () => {
    const seen: { ctx: unknown; change: RowChange }[] = [];
    hook = (ctx, change) => {
      seen.push({ ctx, change });
    };
    const original = await source.read(id);
    const updated = await source.mutate(
      { op: "update", id, row: { city: "Pirot" }, expected_version: 1 },
      sctx,
    );
    const inserted = await source.mutate(
      { op: "insert", row: { name: "Beta", __meta: { id: "x", version: 3 } } },
      sctx,
    );
    const deleted = await source.mutate({ op: "delete", id: inserted.__meta.id }, sctx);
    expect(deleted).toEqual(inserted);
    expect(seen).toEqual([
      {
        ctx: { user: "u1" },
        change: {
          op: "update",
          collection: "company",
          id,
          before: original,
          after: updated,
          patch: { city: "Pirot" },
        },
      },
      {
        ctx: { user: "u1" },
        change: {
          op: "insert",
          collection: "company",
          id: inserted.__meta.id,
          before: null,
          after: inserted,
          patch: { name: "Beta" },
        },
      },
      {
        ctx: { user: "u1" },
        change: {
          op: "delete",
          collection: "company",
          id: inserted.__meta.id,
          before: inserted,
          after: null,
          patch: null,
        },
      },
    ]);
    expect(updated).toMatchObject({ city: "Pirot", __meta: { version: 2 } });
  });

  it("without a request context: ctx undefined, the collection is the table", async () => {
    let got: { ctx: unknown; collection: string } | undefined;
    hook = (ctx, change) => {
      got = { ctx, collection: change.collection };
    };
    await source.mutate({ op: "update", id, row: { city: "Bor" } });
    expect(got?.ctx).toBeUndefined();
    expect(got?.collection).toMatch(/^(companies|om_company)$/);
  });

  it("SQL it runs through tx commits with the row", async () => {
    hook = async (_ctx, change, tx) => {
      await tx.execute(sql`INSERT INTO om_log (op, row_id) VALUES (${change.op}, ${change.id})`);
    };
    await source.mutate({ op: "update", id, row: { city: "Pirot" } });
    const ins = await source.mutate({ op: "insert", row: { name: "Gama" } });
    expect(await logged()).toEqual([
      { op: "update", row_id: id },
      { op: "insert", row_id: ins.__meta.id },
    ]);
    expect(await backend.cityOutside(id)).toBe("Pirot");
  });

  it("while it runs, another connection does not see the change, and the row is locked", async () => {
    const outside: unknown[] = [];
    hook = async (_ctx, change) => {
      if (change.op === "insert") outside.push(await backend.countOutside());
      else outside.push(await backend.cityOutside(change.id));
      if (change.op === "update") {
        // Another writer cannot take the row while the hook holds the transaction.
        const lock = await other.db
          .execute(
            backend.name === "postgres_jsonb"
              ? sql`SELECT 1 FROM companies WHERE id = ${id}::uuid FOR UPDATE NOWAIT`
              : sql`SELECT 1 FROM om_company WHERE id = ${id}::uuid FOR UPDATE NOWAIT`,
          )
          .catch((e: { cause?: { code?: string }; code?: string }) => e.cause?.code ?? e.code);
        outside.push(lock);
      }
    };
    await source.mutate({ op: "update", id, row: { city: "Pirot" } });
    await source.mutate({ op: "insert", row: { name: "Gama" } });
    await source.mutate({ op: "delete", id });
    // Old city, then the lock refused (55P03 lock_not_available), one row before the
    // insert commits, and the deleted row still there.
    expect(outside).toEqual(["Niš", "55P03", 1, "Pirot"]);
    expect(await backend.countOutside()).toBe(1);
  });

  it("a UdcError it throws reaches the caller unchanged; the row and its SQL are rolled back", async () => {
    const refusal = new UdcError("forbidden", "the mail server refused the flag", {
      reason: "imap",
    });
    hook = async (_ctx, change, tx) => {
      await tx.execute(sql`INSERT INTO om_log (op, row_id) VALUES (${change.op}, ${change.id})`);
      throw refusal;
    };
    const before = await source.read(id);
    for (const op of [
      { op: "update" as const, id, row: { city: "Pirot" }, expected_version: 1 },
      { op: "delete" as const, id },
      { op: "insert" as const, row: { name: "Gama" } },
    ]) {
      const err = await source.mutate(op, sctx).catch((e: unknown) => e);
      expect(err).toBe(refusal);
    }
    expect(await source.read(id)).toEqual(before);
    expect(await backend.countOutside()).toBe(1);
    expect(await logged()).toEqual([]);
  });

  it("anything else it throws is answered as internal, logged, and nothing is written", async () => {
    hook = async (_ctx, change, tx) => {
      await tx.execute(sql`INSERT INTO om_log (op, row_id) VALUES (${change.op}, ${change.id})`);
      throw new Error("ECONNRESET talking to the mail server");
    };
    const registry = new CollectionRegistry();
    registry.register({ name: "company", source, view: ViewConfigSchema.parse({}) });
    const log = { error: vi.fn() };
    const dispatcher = createDispatcher(registry, { log });
    const res = await dispatcher.dispatch({
      kind: requestKind("mutate"),
      id: "7",
      payload: { collection: "company", op: "update", id, row: { city: "Pirot" } },
    });
    expect(res).toEqual({
      kind: `${requestKind("mutate")}.err`,
      id: "7",
      payload: { code: "internal", message: "internal error" },
    });
    expect(log.error).toHaveBeenCalledOnce();
    expect(await backend.cityOutside(id)).toBe("Niš");
    expect(await logged()).toEqual([]);
  });

  it("a row it returns is what mutate answers; the source does not write it", async () => {
    hook = (_ctx, change) =>
      change.after ? { ...change.after, city: "as the host sees it" } : undefined;
    const row = await source.mutate({ op: "update", id, row: { employees: 9 } });
    expect(row).toMatchObject({ city: "as the host sees it", employees: 9 });
    expect(await backend.cityOutside(id)).toBe("Niš");
    // Without __meta it keeps the written row's id and version.
    hook = () => ({ name: "bare" }) as unknown as Row;
    const bare = await source.mutate({ op: "update", id, row: { employees: 10 } });
    expect(bare).toEqual({ name: "bare", __meta: { id, version: 3 } });
  });

  it("a database refusal comes first: not_found, version_conflict and validation never reach it", async () => {
    const calls = vi.fn();
    hook = calls;
    await rejectsWith(
      source.mutate({ op: "update", id, row: { city: "x" }, expected_version: 5 }),
      "version_conflict",
    );
    await rejectsWith(
      source.mutate({ op: "delete", id: "00000000-0000-4000-8000-000000000000" }),
      "not_found",
    );
    await rejectsWith(
      source.mutate({ op: "update", id, row: { employees: -1 } }),
      "validation_error",
    );
    await rejectsWith(
      source.mutate(
        { op: "update", id, row: { city: "x" } },
        { ctx: null, collection: "company", rowScope: { field: "city", op: "eq", value: "Bor" } },
      ),
      "not_found",
    );
    expect(calls).not.toHaveBeenCalled();
    expect(await source.read(id)).toMatchObject({ city: "Niš", __meta: { version: 1 } });
  });
});

describe("postgres_jsonb without onMutate", () => {
  it("keeps today's single statements: no transaction is opened", async () => {
    await resetTables(db);
    const [id] = (await insertRows(db, [{ name: "Alfa", city: "Niš" }])) as [string];
    const plain = new PostgresJsonbSource({
      db,
      table: "companies",
      initialSchema: companiesSchema,
    });
    const spy = vi.spyOn(db, "transaction");
    try {
      await plain.mutate({ op: "update", id, row: { city: "Pirot" }, expected_version: 1 });
      const row = await plain.mutate({ op: "insert", row: { name: "Beta" } });
      await plain.mutate({ op: "delete", id: row.__meta.id });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
