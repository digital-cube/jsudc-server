import {
  ACTIONS,
  type CollectionsResponse,
  errKind,
  type HostAction,
  type HostActionReply,
  type HostActionRequest,
  isHostAction,
  isUdcError,
  type ListResponse,
  type MutateManyResponse,
  okKind,
  parseKind,
  type ReadResponse,
  sourceGroup,
  UdcError,
  type UdcMessage,
} from "@jsudc/core";
import type { z } from "zod";
import { assertLookupTarget } from "./links.js";
import type { CollectionRegistry } from "./registry.js";
import { openCollection, type RowScopeOptions, ScopedCollection } from "./scope.js";
import { DEFAULT_MUTATE_MANY_LIMIT } from "./sources/bulk.js";
import type { Source } from "./sources/source.js";

export interface DispatchLogger {
  error(obj: unknown, msg?: string): void;
}

/**
 * An action's handler: the validated payload, and the request context (what
 * the plugin's `context` hook answered; `undefined` without one, or when
 * `dispatch` was called without it). A one-argument handler is fine.
 */
type Handler<S extends z.ZodType, Ctx> = (payload: z.output<S>, ctx: Ctx) => unknown;

/**
 * The handler of a host action (`defineHostAction` of `@jsudc/core`): the
 * payload as its request schema outputs it, the request context, and what
 * it answers typed by its response schema.
 */
export type HostActionHandler<A extends HostAction, Ctx = unknown> = (
  payload: HostActionRequest<A>,
  ctx: Ctx,
) => HostActionReply<A> | Promise<HostActionReply<A>>;

interface Registered {
  schema: z.ZodType;
  /** The answer's schema, when the action was registered with one (a host action): documented, not enforced. */
  response?: z.ZodType | undefined;
  handle: (payload: unknown, ctx: unknown) => unknown;
}

/** What a `Dispatcher` is built with: the logger, and the host's row scope and access hooks. */
export interface DispatcherOptions<Ctx = unknown> extends RowScopeOptions<Ctx> {
  log: DispatchLogger;
  /**
   * The most rows one `mutate_many` request may touch (by `ids`, or by
   * `filter` minus `except_ids`); more is a `validation_error` with
   * `details.reason: "too_many_rows"`, before anything is written. Default
   * 10 000 (`DEFAULT_MUTATE_MANY_LIMIT`).
   */
  mutateManyLimit?: number | undefined;
}

/**
 * Turns a request envelope into its `.ok` / `.err` answer. Actions are
 * registered with the Zod schema of their payload; the dispatcher validates,
 * calls the handler, and maps every failure onto the closed error-code set.
 */
export class Dispatcher {
  private readonly handlers = new Map<string, Registered>();
  private readonly log: DispatchLogger;
  /** The host's `rowScope`, `access` and `showScopeFields`, for the routes that reach rows outside `dispatch`. */
  readonly scopeOptions: RowScopeOptions;

  constructor(opts: DispatcherOptions) {
    this.log = opts.log;
    // Bound, so a host may pass an object whose hooks are prototype methods.
    this.scopeOptions = {
      ...(opts.rowScope ? { rowScope: opts.rowScope.bind(opts) } : {}),
      ...(opts.access ? { access: opts.access.bind(opts) } : {}),
      ...(opts.showScopeFields ? { showScopeFields: opts.showScopeFields } : {}),
    };
  }

  /** An action by name with the Zod schema of its payload. */
  register<S extends z.ZodType, Ctx = unknown>(
    action: string,
    schema: S,
    handle: Handler<S, Ctx>,
  ): this;
  /**
   * A host action defined once with `defineHostAction`: validated with its
   * request schema, the handler typed from it (and given the request
   * context), its response schema in the OpenAPI document.
   */
  register<A extends HostAction, Ctx = unknown>(action: A, handle: HostActionHandler<A, Ctx>): this;
  register(
    action: string | HostAction,
    schemaOrHandle: z.ZodType | ((payload: never, ctx: never) => unknown),
    maybeHandle?: (payload: never, ctx: never) => unknown,
  ): this {
    if (typeof action !== "string") {
      if (!isHostAction(action)) throw new Error("Dispatcher.register: not a host action");
      this.handlers.set(action.name, {
        schema: action.request,
        response: action.response,
        handle: schemaOrHandle as (payload: unknown, ctx: unknown) => unknown,
      });
      return this;
    }
    this.handlers.set(action, {
      schema: schemaOrHandle as z.ZodType,
      handle: maybeHandle as (payload: unknown, ctx: unknown) => unknown,
    });
    return this;
  }

  has(action: string): boolean {
    return this.handlers.has(action);
  }

  actions(): string[] {
    return [...this.handlers.keys()];
  }

  /** The answer schema of a registered host action (the OpenAPI document); `undefined` for any other. */
  responseOf(action: string): z.ZodType | undefined {
    return this.handlers.get(action)?.response;
  }

  /** The payload schema of a registered action (used for the OpenAPI document). */
  schemaOf(action: string): z.ZodType | undefined {
    return this.handlers.get(action)?.schema;
  }

  /**
   * Answer one request envelope. `ctx` is the request context, handed to the
   * handler and, through it, to the row scope, the access hook and every
   * source method; a dispatcher driven without HTTP passes its own.
   */
  async dispatch(msg: UdcMessage, ctx?: unknown): Promise<UdcMessage> {
    const parsed = parseKind(msg.kind);
    const action = parsed?.status === "request" ? parsed.action : msg.kind;
    try {
      const registered = parsed?.status === "request" ? this.handlers.get(action) : undefined;
      if (!registered) {
        throw new UdcError("unsupported_op", `unsupported action: ${action}`, { action });
      }
      const payload = registered.schema.safeParse(msg.payload ?? {});
      if (!payload.success) {
        throw new UdcError("validation_error", `invalid ${action} payload`, {
          issues: payload.error.issues,
        });
      }
      const result = await registered.handle(payload.data, ctx);
      return { kind: okKind(action), id: msg.id, payload: result };
    } catch (err) {
      if (isUdcError(err)) return { kind: errKind(action), id: msg.id, payload: err.toPayload() };
      this.log.error({ err, action, id: msg.id }, "udc action failed");
      return {
        kind: errKind(action),
        id: msg.id,
        payload: { code: "internal", message: "internal error" },
      };
    }
  }
}

/** The source of a collection whose schema may be edited, or `unsupported_op`. */
function schemaEditable(s: ScopedCollection, action: string): Source {
  s.assertTenantWide(action);
  const c = s.collection;
  if (!c.source.capabilities.schema_edit) {
    throw new UdcError(
      "unsupported_op",
      `collection ${c.name} does not support schema edits (schema_edit: false)`,
      { collection: c.name },
    );
  }
  return c.source;
}

/** The source of a collection that renumbers orders, or `unsupported_op`. */
function reindexable(s: ScopedCollection): ScopedCollection {
  const c = s.collection;
  const { source } = c;
  if (!source.capabilities.reindex || !source.reindex) {
    throw new UdcError(
      "unsupported_op",
      `collection ${c.name} does not support reindex (reindex: false)`,
      { collection: c.name },
    );
  }
  return s;
}

/** The source of a collection that moves tree nodes, or `unsupported_op`. */
function reparentable(s: ScopedCollection): ScopedCollection {
  const c = s.collection;
  const { source } = c;
  if (!source.capabilities.tree_reparent || !source.reparent) {
    throw new UdcError(
      "unsupported_op",
      `collection ${c.name} does not support tree.reparent (tree_reparent: false)`,
      { collection: c.name },
    );
  }
  return s;
}

/** The collection, when it changes many rows at once (`capabilities.mutate_many`), or `unsupported_op`. */
function bulkMutable(s: ScopedCollection): ScopedCollection {
  if (!s.capabilities().mutate_many) {
    const name = s.collection.name;
    throw new UdcError(
      "unsupported_op",
      `collection ${name} does not support mutate_many (mutate_many: false)`,
      { collection: name },
    );
  }
  return s;
}

/** The source of a collection read from a file the UI may show, or `unsupported_op`. */
function sourceReadable(s: ScopedCollection): Source & Required<Pick<Source, "readSource">> {
  s.assertTenantWide("source.read");
  const c = s.collection;
  const { source } = c;
  if (!source.capabilities.source_yaml || !source.readSource) {
    throw new UdcError(
      "unsupported_op",
      `collection ${c.name} has no source file to show (source_yaml: false)`,
      { collection: c.name },
    );
  }
  return source as Source & Required<Pick<Source, "readSource">>;
}

/**
 * A dispatcher with every action wired to the registry. With `rowScope`,
 * every action holds each request to its row filter whatever the source
 * (see `ScopedCollection`); with `access`, a host hides collections and lets
 * a scoped request edit a schema. Without them, nothing changes.
 */
export function createDispatcher<Ctx = unknown>(
  registry: CollectionRegistry,
  opts: DispatcherOptions<Ctx>,
): Dispatcher {
  const dispatcher = new Dispatcher(opts as DispatcherOptions);
  const scoping = dispatcher.scopeOptions;
  const bulkLimit = opts.mutateManyLimit ?? DEFAULT_MUTATE_MANY_LIMIT;
  if (!Number.isInteger(bulkLimit) || bulkLimit < 1) {
    throw new Error(
      `createDispatcher: mutateManyLimit must be a positive integer, not ${bulkLimit}`,
    );
  }
  const open = (action: string, collection: string, ctx: unknown) =>
    openCollection(registry, scoping, action, collection, ctx);
  return dispatcher
    .register("collections", ACTIONS.collections.request, (_, ctx): CollectionsResponse => {
      const collections = registry
        .list()
        .filter(
          (c) => scoping.access?.(ctx, { action: "collections", collection: c.name }) !== false,
        )
        .map((c) => new ScopedCollection(c, ctx, scoping));
      return {
        collections: collections.map((s) => ({
          name: s.collection.name,
          ...(s.collection.label === undefined ? {} : { label: s.collection.label }),
          default_renderer: s.collection.view.default_renderer,
          capabilities: s.capabilities(),
          source_kind: s.source.kind ?? "postgres_jsonb",
          group: sourceGroup(s.source.kind ?? "postgres_jsonb"),
        })),
      };
    })
    .register("describe", ACTIONS.describe.request, ({ collection }, ctx) =>
      open("describe", collection, ctx).describe(),
    )
    .register(
      "list",
      ACTIONS.list.request,
      ({ collection, filter, sort, page }, ctx): Promise<ListResponse> => {
        const s = open("list", collection, ctx);
        return s.list({
          filter,
          sort,
          page: { ...page, limit: page?.limit ?? s.collection.view.page_size_default },
        });
      },
    )
    .register(
      "read",
      ACTIONS.read.request,
      async ({ collection, id }, ctx): Promise<ReadResponse> => ({
        row: await open("read", collection, ctx).read(id),
      }),
    )
    .register("mutate", ACTIONS.mutate.request, async ({ collection, ...op }, ctx) => ({
      row: await open("mutate", collection, ctx).mutate(op),
    }))
    .register(
      "schema.add_field",
      ACTIONS["schema.add_field"].request,
      async ({ collection, ...req }, ctx) => {
        const s = open("schema.add_field", collection, ctx);
        const source = schemaEditable(s, "schema.add_field");
        await assertLookupTarget(registry, collection, req.name, req.fielddef);
        return { schema: await source.addField(req, s.sctx) };
      },
    )
    .register(
      "schema.update_field",
      ACTIONS["schema.update_field"].request,
      async ({ collection, ...req }, ctx) => {
        const s = open("schema.update_field", collection, ctx);
        const source = schemaEditable(s, "schema.update_field");
        await assertLookupTarget(registry, collection, req.name, req.fielddef);
        return { schema: await source.updateField(req, s.sctx) };
      },
    )
    .register(
      "schema.soft_delete_field",
      ACTIONS["schema.soft_delete_field"].request,
      async ({ collection, field }, ctx) => {
        const s = open("schema.soft_delete_field", collection, ctx);
        return {
          schema: await schemaEditable(s, "schema.soft_delete_field").softDeleteField(
            field,
            s.sctx,
          ),
        };
      },
    )
    .register("reindex", ACTIONS.reindex.request, async ({ collection, ...req }, ctx) => ({
      updated: await reindexable(open("reindex", collection, ctx)).reindex(req),
    }))
    .register("tree.reparent", ACTIONS["tree.reparent"].request, ({ collection, ...req }, ctx) =>
      reparentable(open("tree.reparent", collection, ctx)).reparent(req),
    )
    .register("source.read", ACTIONS["source.read"].request, ({ collection }, ctx) => {
      const s = open("source.read", collection, ctx);
      return sourceReadable(s).readSource(s.sctx);
    })
    .register(
      "mutate_many",
      ACTIONS.mutate_many.request,
      ({ collection, ...req }, ctx): Promise<MutateManyResponse> =>
        bulkMutable(open("mutate_many", collection, ctx)).mutateMany({ ...req, limit: bulkLimit }),
    );
}
