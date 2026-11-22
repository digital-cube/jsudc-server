// The change feed without HTTP: the scope rule (`eventFor`), what of a row it keeps
// (`scopeValues`), `notify`'s inputs and its refusal, the memory bus, and failures that are
// logged rather than thrown into a committed write.
import type { ChangeEvent, FilterNode } from "@jsudc/core";
import { describe, expect, it, vi } from "vitest";
import {
  type ChangeBus,
  type ChangeNotice,
  createChangeFeed,
  eventFor,
  MemoryChangeBus,
  scopeValues,
} from "../src/changes.js";

const tenantA: FilterNode = { field: "tenant", op: "eq", value: "a" };

describe("eventFor", () => {
  const notice: ChangeNotice = {
    collection: "m",
    op: "update",
    ids: ["1", "2", "3"],
    match: [
      { ids: ["1"], values: { tenant: "a" } },
      { ids: ["2"], values: { tenant: "b" } },
      { ids: ["3"], values: { tenant: "a" } },
    ],
  };

  it("no scope: every id; a scope: only the rows it holds for", () => {
    expect(eventFor(notice, undefined)).toEqual({ op: "update", ids: ["1", "2", "3"] });
    expect(eventFor(notice, tenantA)).toEqual({ op: "update", ids: ["1", "3"] });
    expect(eventFor(notice, { field: "tenant", op: "eq", value: "c" })).toBeNull();
  });

  it("a notice with nothing to test never crosses a scope", () => {
    expect(eventFor({ collection: "m", op: "insert", ids: ["1"] }, tenantA)).toBeNull();
    expect(eventFor({ collection: "m", op: "insert" }, undefined)).toEqual({ op: "insert" });
  });

  it("values without ids stand for the notice's ids, or the whole collection", () => {
    const pins: ChangeNotice = {
      collection: "m",
      op: "insert",
      ids: ["9"],
      match: [{ values: { tenant: "a" } }],
    };
    expect(eventFor(pins, tenantA)).toEqual({ op: "insert", ids: ["9"] });
    expect(eventFor({ ...pins, ids: undefined }, tenantA)).toEqual({ op: "insert" });
  });

  it("a scope that cannot be evaluated on the values tells nothing", () => {
    const bad = { field: "tenant", op: "nope", value: 1 } as unknown as FilterNode;
    expect(eventFor(notice, bad)).toBeNull();
  });
});

describe("scopeValues", () => {
  it("keeps scalars and short scalar arrays, the row id as id; drops the rest", () => {
    const long = "x".repeat(257);
    expect(
      scopeValues({
        __meta: { id: "r1", version: 3 },
        tenant: "a",
        n: 3,
        ok: false,
        none: null,
        labels: ["x", "y"],
        body: long,
        nested: { a: 1 },
        many: Array.from({ length: 65 }, () => "z"),
        mixed: ["a", { b: 1 }],
      }),
    ).toEqual({ tenant: "a", n: 3, ok: false, none: null, labels: ["x", "y"], id: "r1" });
    expect(scopeValues({ __meta: { id: "r1" }, id: "own" })).toEqual({ id: "own" });
    expect(scopeValues({ tenant: "a" })).toEqual({ tenant: "a" });
  });
});

describe("ChangeFeed.notify", () => {
  function listen(feed: ReturnType<typeof createChangeFeed>, scope: FilterNode | undefined) {
    const got: ChangeEvent[] = [];
    feed.subscribe({ scopes: new Map([["m", scope]]), send: (e) => got.push(e) });
    return got;
  }

  it("defaults op to update; rows without __meta.id: no ids, even ids given", async () => {
    const feed = createChangeFeed({ coalesce: false });
    const a = listen(feed, tenantA);
    await feed.notify("m", { rows: [{ tenant: "a" }, { tenant: "b" }] });
    await feed.notify("m", { op: "delete", ids: ["7"], rows: [{ tenant: "a" }] });
    expect(a).toEqual([
      { collection: "m", op: "update" },
      { collection: "m", op: "delete" },
    ]);
  });

  it("never hands a scope the ids of another scope's rows", async () => {
    const feed = createChangeFeed({ coalesce: false, maxIds: 2 });
    const a = listen(feed, tenantA);
    // Rows that name no id, with ids given: the ids are not sent.
    await feed.notify("m", { ids: ["mine", "theirs"], rows: [{ tenant: "a" }, { tenant: "b" }] });
    // A match whose own ids are too many: no ids anywhere.
    await feed.publish({
      collection: "m",
      op: "update",
      ids: ["1"],
      match: [
        { ids: ["1", "2", "3"], values: { tenant: "a" } },
        { ids: ["4"], values: { tenant: "b" } },
      ],
    });
    // A notice without ids: the matches' own ids still say which rows.
    await feed.publish({
      collection: "m",
      op: "delete",
      match: [
        { ids: ["5"], values: { tenant: "a" } },
        { ids: ["6"], values: { tenant: "b" } },
      ],
    });
    expect(a).toEqual([
      { collection: "m", op: "update" },
      { collection: "m", op: "update" },
      { collection: "m", op: "delete", ids: ["5"] },
    ]);
  });

  it("without a dispatcher every collection is unscoped", async () => {
    const feed = createChangeFeed({ coalesce: false });
    const all = listen(feed, undefined);
    await feed.notify("m");
    await feed.notify("m", { ctx: { user: 1 } });
    expect(all).toEqual([
      { collection: "m", op: "update" },
      { collection: "m", op: "update" },
    ]);
  });

  it("asks the row scope without a context whether the collection has one", async () => {
    const feed = createChangeFeed();
    feed.attach({
      rowScope: (ctx: unknown, collection: string) => {
        if (collection === "open") return undefined;
        if (collection === "throws")
          return { field: "tenant", op: "eq", value: (ctx as { t: string }).t };
        return tenantA;
      },
    });
    await expect(feed.notify("open")).resolves.toBeUndefined();
    await expect(feed.notify("throws")).rejects.toThrow(/row scope/);
    await expect(feed.notify("scoped")).rejects.toThrow(/pass the ctx/);
    await expect(feed.notify("scoped", { rows: [] })).resolves.toBeUndefined();
  });

  it("logs a bus that fails to publish and a stream that fails to send, never throws", async () => {
    const error = vi.fn();
    const broken: ChangeBus = {
      publish: () => {
        throw new Error("down");
      },
      subscribe: () => () => {},
    };
    const feed = createChangeFeed({ bus: broken, log: { error } });
    await expect(feed.notify("m")).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ collection: "m" }),
      expect.stringMatching(/publish/),
    );

    const log = { error: vi.fn() };
    const ok = createChangeFeed({ coalesce: false });
    ok.attach({}, log);
    ok.subscribe({
      scopes: new Map([["m", undefined]]),
      send: () => {
        throw new Error("socket gone");
      },
    });
    const after = listen(ok, undefined);
    await ok.notify("m");
    expect(log.error).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/send/));
    expect(after).toEqual([{ collection: "m", op: "update" }]);
  });

  it("has the documented defaults and stops listening on close", async () => {
    const bus = new MemoryChangeBus();
    const feed = createChangeFeed({ bus });
    expect(feed.heartbeatMs).toBe(15_000);
    expect(feed.retryMs).toBe(3000);
    const off = feed.subscribe({ scopes: new Map(), send: () => {} });
    expect(feed.listenerCount).toBe(1);
    expect(bus.size).toBe(1);
    off();
    expect(feed.listenerCount).toBe(0);
    await feed.close();
    expect(bus.size).toBe(0);
    await feed.close();
  });
});
