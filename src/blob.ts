import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { isUdcError, isUnauthenticated } from "@jsudc/core";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { CollectionRegistry } from "./registry.js";
import { openCollection, type RowScopeOptions, type ScopedCollection } from "./scope.js";
import { FilesystemSource } from "./sources/filesystem.js";

export const BLOB_MAX_BYTES = 256 * 1024;
export const BLOB_ROUTE = "/udc/files/blob";

/** What a preview can show: text and images, by extension. */
export const BLOB_TYPES: Record<string, string> = {
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  json: "application/json; charset=utf-8",
  yaml: "text/yaml; charset=utf-8",
  yml: "text/yaml; charset=utf-8",
  log: "text/plain; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

/** The request context and the host's scope hooks, as `udcPlugin` passes them. */
export interface BlobRouteOptions {
  /** The plugin's `context`: a `UdcError` it throws answers 401 (unauthenticated) or 403. */
  context?: ((request: FastifyRequest) => unknown) | undefined;
  /** The dispatcher's `rowScope` / `access` / `showScopeFields` (`Dispatcher.scopeOptions`). */
  scope?: RowScopeOptions | undefined;
}

const QuerySchema = z.object({ collection: z.string().min(1), path: z.string().min(1) });

/**
 * `GET /udc/files/blob?collection=&path=`: one file of a filesystem
 * collection whose view enables `folder_options.preview`, for the preview
 * dialog. Plain HTTP (not an envelope): 404 for an unknown collection or
 * file, 400 for a traversal or a folder, 413 above 256 KB, 415 for a type the
 * preview cannot show. An SVG is sent with a sandboxing CSP.
 *
 * With `opts.context`, the request context is resolved first (401 / 403 when
 * it refuses); then `access` (action `read`) and the collection's row scope
 * hold against the file's row: a collection or file the request may not
 * reach is a 404, like one that does not exist.
 */
export function registerBlobRoute(
  app: FastifyInstance,
  registry: CollectionRegistry,
  opts: BlobRouteOptions = {},
): void {
  app.get(BLOB_ROUTE, { schema: { hide: true } }, async (request, reply) => {
    const q = QuerySchema.safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: "collection and path are required" });
    let ctx: unknown;
    if (opts.context) {
      try {
        ctx = await opts.context(request);
      } catch (err) {
        if (isUdcError(err)) {
          return reply.code(isUnauthenticated(err) ? 401 : 403).send({ error: err.message });
        }
        request.log.error({ err }, "udc context failed");
        return reply.code(500).send({ error: "internal error" });
      }
    }
    let scoped: ScopedCollection | undefined;
    try {
      scoped = openCollection(registry, opts.scope ?? {}, "read", q.data.collection, ctx);
    } catch (err) {
      if (!isUdcError(err)) throw err;
    }
    const collection = scoped?.collection;
    if (
      !collection ||
      !(collection.source instanceof FilesystemSource) ||
      !collection.view.folder_options?.preview
    ) {
      return reply.code(404).send({ error: `no file preview for ${q.data.collection}` });
    }
    let file: string;
    try {
      // The file's row must be one this request can read (its row scope, its hidden fields aside).
      if (scoped?.rowScope) await scoped.read(q.data.path);
      file = await collection.source.resolveFile(q.data.path);
    } catch (err) {
      if (isUdcError(err)) {
        return reply.code(err.code === "not_found" ? 404 : 400).send({ error: err.message });
      }
      throw err;
    }
    const st = await stat(file);
    if (!st.isFile()) return reply.code(400).send({ error: "not a file" });
    const type = BLOB_TYPES[extname(file).slice(1).toLowerCase()];
    if (!type) return reply.code(415).send({ error: "no preview for this file type" });
    if (st.size > BLOB_MAX_BYTES) {
      return reply.code(413).send({ error: `larger than ${BLOB_MAX_BYTES} bytes`, size: st.size });
    }
    reply.header("content-type", type).header("x-content-type-options", "nosniff");
    if (type.startsWith("image/svg")) reply.header("content-security-policy", "sandbox");
    return reply.send(await readFile(file));
  });
}
