import { evaluateFilter, type FilterNode, type FilterOp, type Row } from "@jsudc/core";
import { beforeAll, describe, expect, it } from "vitest";
import { seedCollection } from "../src/seed.js";
import {
  companiesSchema,
  companiesSchemaJson,
  companiesSeed,
  companiesSource,
  ids,
  resetTables,
  useTestDb,
} from "./helpers.js";

const { db } = useTestDb();
const source = companiesSource(db);
let all: Row[];

beforeAll(async () => {
  await resetTables(db);
  await seedCollection(db, {
    table: "companies",
    schema: companiesSchemaJson,
    rows: companiesSeed,
  });
  all = (await source.list({ page: { limit: 1000 } })).rows;
});

function prng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = prng(42);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
const FIELDS = companiesSchema.field_order;
const OPS: FilterOp[] = [
  "eq",
  "neq",
  "in",
  "not_in",
  "contains",
  "starts_with",
  "ends_with",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "is_null",
  "is_not_null",
];

/** A random condition whose value is taken from a real row, so it can match. */
function randomCondition(): FilterNode {
  const field = pick(FIELDS);
  const op = pick(OPS);
  const sample = () => pick(companiesSeed)[field];
  const ci = rand() < 0.3;
  switch (op) {
    case "is_null":
    case "is_not_null":
      return { field, op };
    case "in":
    case "not_in":
      return { field, op, value: [sample(), sample(), sample()] };
    case "between": {
      const [lo, hi] = [sample(), sample()].sort((a, b) =>
        typeof a === "number" ? a - (b as number) : String(a) < String(b) ? -1 : 1,
      );
      return { field, op, value: [lo, hi] };
    }
    case "contains":
    case "starts_with":
    case "ends_with": {
      const text = String(sample());
      const at = Math.floor(rand() * text.length);
      const part =
        op === "starts_with"
          ? text.slice(0, at + 1)
          : op === "ends_with"
            ? text.slice(at)
            : text.slice(at, at + 3);
      return { field, op, value: ci ? part.toUpperCase() : part, case_insensitive: ci };
    }
    default:
      return { field, op, value: sample() };
  }
}

function randomFilter(depth = 0): FilterNode {
  const r = rand();
  if (depth >= 2 || r < 0.5) return randomCondition();
  if (r < 0.7) return { and: [randomFilter(depth + 1), randomFilter(depth + 1)] };
  if (r < 0.9) return { or: [randomFilter(depth + 1), randomFilter(depth + 1)] };
  return { not: randomFilter(depth + 1) };
}

const FILTERS = Array.from({ length: 30 }, () => randomFilter());

describe("SQL vs evaluateFilter parity over the fixture seed", () => {
  it.each(FILTERS.map((f) => [JSON.stringify(f), f] as const))("%s", async (_, filter) => {
    const res = await source.list({ filter, page: { limit: 1000 } });
    const expected = all.filter((r) => evaluateFilter(filter, r));
    expect(ids(res.rows).sort()).toEqual(ids(expected).sort());
    expect(res.total).toBe(expected.length);
  });

  it("generates filters that actually discriminate", async () => {
    const counts = FILTERS.map((f) => all.filter((r) => evaluateFilter(f, r)).length);
    expect(counts.some((n) => n > 0 && n < all.length)).toBe(true);
    expect(counts.filter((n) => n > 0).length).toBeGreaterThan(10);
  });
});
