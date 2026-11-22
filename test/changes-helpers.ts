import type { AddressInfo } from "node:net";
import type { ChangeEvent } from "@jsudc/core";
import { UdcClient } from "@jsudc/core/client";
import type { FastifyInstance } from "fastify";
import { expect, vi } from "vitest";

/** Listen on a free port; the base URL to reach it. */
export async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** One open change stream (through core's client), collecting what it receives. */
export interface OpenStream {
  events: ChangeEvent[];
  opens: boolean[];
  /** Settles with the client's own promise: resolves on stop, rejects on a refusal. */
  done: Promise<void>;
  stop(): Promise<void>;
}

/** Open a stream as `headers` say and wait for its `ready`. */
export async function openStream(
  baseUrl: string,
  collections: string[],
  headers: Record<string, string> = {},
  more: { prefix?: string } = {},
): Promise<OpenStream> {
  const client = new UdcClient({ httpUrl: `${baseUrl}${more.prefix ?? ""}`, headers });
  const ctl = new AbortController();
  const events: ChangeEvent[] = [];
  const opens: boolean[] = [];
  let ready: () => void = () => {};
  const isReady = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const done = client.changes({
    collections,
    onChange: (e) => events.push(e),
    onOpen: ({ reconnected }) => {
      opens.push(reconnected);
      ready();
    },
    signal: ctl.signal,
    minDelayMs: 20,
    maxDelayMs: 100,
  });
  // A refusal settles `done`; the caller inspects it.
  await Promise.race([isReady, done.catch(() => {})]);
  return {
    events,
    opens,
    done,
    stop: async () => {
      ctl.abort();
      await done.catch(() => {});
    },
  };
}

/** Wait until `stream` has received an event matching `expected` (as `toMatchObject`). */
export async function received(stream: OpenStream, expected: Partial<ChangeEvent>): Promise<void> {
  await vi.waitFor(
    () => {
      expect(stream.events).toContainEqual(expect.objectContaining(expected));
    },
    { timeout: 3000, interval: 10 },
  );
}
