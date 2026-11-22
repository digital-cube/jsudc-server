import type { ServerResponse } from "node:http";
import {
  CHANGE_EVENT,
  CHANGES_READY_EVENT,
  CHANGES_ROUTE,
  type ChangeEvent,
  type ErrorPayload,
  type FilterNode,
  isUdcError,
  isUnauthenticated,
} from "@jsudc/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ChangeFeed } from "./changes.js";
import type { CollectionRegistry } from "./registry.js";
import { openCollection, type RowScopeOptions } from "./scope.js";

/** The request context and the host's scope hooks, as `udcPlugin` passes them. */
export interface ChangesRouteOptions {
  /** The plugin's `context`: a `UdcError` it throws answers 401 (unauthenticated) or 403. */
  context?: ((request: FastifyRequest) => unknown) | undefined;
  /** The dispatcher's `rowScope` / `access` / `showScopeFields` (`Dispatcher.scopeOptions`). */
  scope?: RowScopeOptions | undefined;
}

/** The most collections one stream may ask for. */
export const MAX_CHANGE_COLLECTIONS = 100;

function refuse(reply: FastifyReply, status: number, payload: ErrorPayload) {
  return reply.code(status).send(payload);
}

/** `collections=a,b` (or repeated `collections=`), trimmed and deduplicated. */
function collectionsOf(query: unknown): string[] {
  const raw = (query as { collections?: unknown } | undefined)?.collections;
  const parts = (Array.isArray(raw) ? raw : [raw])
    .filter((v): v is string => typeof v === "string")
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  return [...new Set(parts)];
}

/**
 * `GET /udc/changes?collections=a,b`: the change feed as Server-Sent Events.
 * The request context is resolved once (401 / 403 when it refuses, a plain
 * HTTP answer and no stream); every collection must be one this request may
 * `list` (else 404, as for one that does not exist), and its row scope is
 * fixed for the stream. Then: a `retry:` hint, a `ready` event, a `change`
 * event per change this request may see, a heartbeat comment every
 * `feed.heartbeatMs`. The listener is removed when the client goes away and
 * every stream is ended when the server closes. No replay: a client
 * refetches after it reconnects.
 */
export function registerChangesRoute(
  app: FastifyInstance,
  registry: CollectionRegistry,
  feed: ChangeFeed,
  opts: ChangesRouteOptions = {},
): void {
  const open = new Set<ServerResponse>();
  // An open stream would hold `close()` until the client leaves: end them first.
  app.addHook("preClose", (done) => {
    for (const res of open) res.end();
    open.clear();
    done();
  });

  app.get(CHANGES_ROUTE, { schema: { hide: true } }, async (request, reply) => {
    const names = collectionsOf(request.query);
    if (names.length === 0) {
      return refuse(reply, 400, { code: "validation_error", message: "collections is required" });
    }
    if (names.length > MAX_CHANGE_COLLECTIONS) {
      return refuse(reply, 400, {
        code: "validation_error",
        message: `at most ${MAX_CHANGE_COLLECTIONS} collections per stream`,
      });
    }
    let ctx: unknown;
    if (opts.context) {
      try {
        ctx = await opts.context(request);
      } catch (err) {
        if (isUdcError(err)) {
          return refuse(reply, isUnauthenticated(err) ? 401 : 403, err.toPayload());
        }
        request.log.error({ err }, "udc context failed");
        return refuse(reply, 500, { code: "internal", message: "internal error" });
      }
    }
    const scopes = new Map<string, FilterNode | undefined>();
    for (const name of names) {
      try {
        // Being told a collection changed is reading it: the access rule of `list`.
        const s = openCollection(registry, opts.scope ?? {}, "list", name, ctx);
        scopes.set(s.collection.name, s.rowScope);
      } catch (err) {
        if (isUdcError(err)) return refuse(reply, 404, err.toPayload());
        throw err;
      }
    }

    const res = reply.raw;
    reply.hijack();
    // Headers a host's hooks set on the reply (CORS, say) travel with the stream.
    const headers: Record<string, string | number | string[]> = {};
    for (const [k, v] of Object.entries(reply.getHeaders())) if (v !== undefined) headers[k] = v;
    res.writeHead(200, {
      ...headers,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // nginx: do not buffer this response.
      "x-accel-buffering": "no",
    });
    open.add(res);
    const write = (chunk: string) => {
      if (!res.writableEnded) res.write(chunk);
    };
    const unsubscribe = feed.subscribe({
      scopes,
      send: (event: ChangeEvent) =>
        write(`event: ${CHANGE_EVENT}\ndata: ${JSON.stringify(event)}\n\n`),
    });
    const heartbeat = setInterval(() => write(": heartbeat\n\n"), feed.heartbeatMs);
    heartbeat.unref?.();
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      unsubscribe();
      open.delete(res);
    };
    res.on("close", cleanup);
    res.on("error", cleanup);
    write(`retry: ${feed.retryMs}\n\n`);
    write(
      `event: ${CHANGES_READY_EVENT}\ndata: ${JSON.stringify({ collections: [...scopes.keys()] })}\n\n`,
    );
  });
}
