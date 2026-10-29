import { ACTIONS, ErrorPayloadSchema, errKind, isActionName, requestKind } from "@jsudc/core";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { z } from "zod";
import { registerBlobRoute } from "./blob.js";
import type { Dispatcher } from "./dispatcher.js";
import type { CollectionRegistry } from "./registry.js";

const MESSAGE_ID_HEADER = "x-udc-message-id";

function messageId(header: string | string[] | undefined): string {
  return (Array.isArray(header) ? header[0] : header) ?? "";
}

/** The documented response of one action: its ok payload or the error payload, always HTTP 200. */
function envelopeDoc(action: string) {
  const ok = isActionName(action) ? ACTIONS[action].response : z.unknown();
  return z
    .object({
      kind: z.string().describe(`udc.${action}.ok | udc.${action}.err`),
      id: z.string().describe(`echo of the ${MESSAGE_ID_HEADER} header`),
      payload: z.union([ok, ErrorPayloadSchema]),
    })
    .describe("Always HTTP 200: the envelope kind says ok or err.");
}

/** The OpenAPI document and its UI; `true` takes every default. */
export interface UdcSwaggerOptions {
  /** Where the UI is served. Default `/docs`. */
  routePrefix?: string;
  title?: string;
  version?: string;
  description?: string;
}

export interface UdcPluginOptions {
  dispatcher: Dispatcher;
  /** With it, `GET /udc/files/blob` serves file previews of filesystem collections. */
  registry?: CollectionRegistry | undefined;
  /**
   * The OpenAPI document of every action and its UI at `/docs` (default on).
   * Needs the optional peers `@fastify/swagger`, `@fastify/swagger-ui` and
   * `fastify-type-provider-zod`; `false` leaves them out.
   */
  swagger?: boolean | UdcSwaggerOptions | undefined;
}

const DEFAULT_DESCRIPTION =
  "UDC envelope RPC. Every action is `POST /udc/<action>` with the payload as body; " +
  `the answer is always HTTP 200 with \`{kind, id, payload}\`. Send \`${MESSAGE_ID_HEADER}\` to correlate.`;

/** An optional peer, or an error that names what to install. */
async function peer<T>(name: string, load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (err) {
    throw new Error(
      `udcPlugin: swagger needs ${name} (npm install @fastify/swagger @fastify/swagger-ui ` +
        "fastify-type-provider-zod), or pass swagger: false",
      { cause: err },
    );
  }
}

async function registerSwagger(app: FastifyInstance, opts: UdcSwaggerOptions): Promise<void> {
  const swagger = await peer("@fastify/swagger", () => import("@fastify/swagger"));
  const swaggerUi = await peer("@fastify/swagger-ui", () => import("@fastify/swagger-ui"));
  const { jsonSchemaTransform } = await peer(
    "fastify-type-provider-zod",
    () => import("fastify-type-provider-zod"),
  );
  await app.register(swagger.default, {
    openapi: {
      info: {
        title: opts.title ?? "jsudc",
        version: opts.version ?? "0.1.0",
        description: opts.description ?? DEFAULT_DESCRIPTION,
      },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi.default, { routePrefix: opts.routePrefix ?? "/docs" });
}

/**
 * The HTTP face of the dispatcher, as a Fastify plugin: `POST /udc/:action`
 * with the payload as body, always answering HTTP 200 with the `.ok` / `.err`
 * envelope; `GET /healthz`; the file preview route; the OpenAPI docs. Mount
 * it with `app.register(udcPlugin, {dispatcher, registry})`: its validator,
 * serializer and error handler stay inside its own context.
 */
export async function udcPlugin(app: FastifyInstance, opts: UdcPluginOptions): Promise<void> {
  const { dispatcher } = opts;
  const udcPrefix = `${app.prefix}/udc/`;

  // Zod schemas on the routes document the API; the dispatcher validates, so a
  // bad payload becomes a `validation_error` envelope instead of an HTTP 400.
  app.setValidatorCompiler(() => (data) => ({ value: data }));
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));

  const swagger = opts.swagger ?? true;
  if (swagger !== false) await registerSwagger(app, swagger === true ? {} : swagger);

  const handle = async (action: string, body: unknown, header: string | string[] | undefined) =>
    dispatcher.dispatch({ kind: requestKind(action), id: messageId(header), payload: body ?? {} });

  // A body Fastify cannot parse (bad JSON, wrong content type) is still answered in-protocol.
  app.setErrorHandler((err: { statusCode?: number; message: string }, request, reply) => {
    if (!request.url.startsWith(udcPrefix)) {
      reply.code(err.statusCode ?? 500).send({ error: err.message });
      return;
    }
    const action =
      (request.params as { action?: string }).action ??
      request.url.slice(udcPrefix.length).split("/")[0] ??
      "";
    const clientError = (err.statusCode ?? 500) < 500;
    if (!clientError) request.log.error({ err }, "udc transport failed");
    reply.code(200).send({
      kind: errKind(action),
      id: messageId(request.headers[MESSAGE_ID_HEADER]),
      payload: clientError
        ? { code: "validation_error", message: err.message }
        : { code: "internal", message: "internal error" },
    });
  });

  app.get("/healthz", { schema: { hide: true } }, async () => ({ ok: true }));
  if (opts.registry) registerBlobRoute(app, opts.registry);

  for (const action of dispatcher.actions()) {
    app.post(
      `/udc/${action}`,
      {
        schema: {
          tags: ["udc"],
          operationId: action,
          body: dispatcher.schemaOf(action),
          headers: z.object({ [MESSAGE_ID_HEADER]: z.string().optional() }),
          response: { 200: envelopeDoc(action) },
        },
      },
      (request) => handle(action, request.body, request.headers[MESSAGE_ID_HEADER]),
    );
  }

  // Anything else under /udc: the dispatcher answers `unsupported_op`.
  app.post<{ Params: { action: string } }>("/udc/:action", { schema: { hide: true } }, (request) =>
    handle(request.params.action, request.body, request.headers[MESSAGE_ID_HEADER]),
  );
}

/** A Fastify instance with `udcPlugin` registered on it: the whole server in one call. */
export async function buildApp(
  opts: UdcPluginOptions & { logger?: FastifyServerOptions["logger"] },
): Promise<FastifyInstance> {
  const { logger, ...plugin } = opts;
  const app = Fastify({ logger: logger ?? false });
  await app.register(udcPlugin, plugin);
  return app;
}
