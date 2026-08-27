/**
 * Admin HTTP plane for the Cloudflare Worker: authenticated HTTPS routes
 * mirroring `BotControlOperationNames` from src/control/contract.ts.
 *
 * Response bodies use the encoded `ControlResult` JSON `_tag` shapes the CLI
 * parses today (`Success` / `AlreadySatisfied` / …), so operation semantics
 * are unchanged — only the transport moves from Unix-socket RPC to HTTPS.
 * Payloads are validated server-side against the SAME schemas the CLI encodes
 * with (src/control/schema.ts); validation failures return a decodable
 * `InvalidControlInput` body (status 422), matching the socket-RPC contract.
 *
 * Runtime-agnostic: no node builtins — the identical module runs inside a
 * Cloudflare Worker, Bun, or Node.
 */
import { Context, Effect, Layer, Schema } from 'effect'

import { HttpRouter, HttpServerRequest, HttpServerError } from 'effect/unstable/http'
import { HttpMiddleware, HttpServerResponse } from 'effect/unstable/http'

import { EmptyPayload } from '../../src/control/schema.ts'
import { CommandsSyncPayload, OperatorThreadCreatePayload } from './admin-ops.ts'
import type { ControlResult } from '../../src/control/schema.ts'
import { schemaVersion as journalSchemaVersion } from './journal.ts'
import type { AdminOperationOutcome } from './admin-ops.ts'
import type { RuntimeConfigSummary } from './runtime-config.ts'
import { evaluateReadiness, type GatewayHealthSummary } from './readiness.ts'

// ---------------------------------------------------------------------------
// Bridge: worker fetch Request <-> Effect HttpRouter
// ---------------------------------------------------------------------------

/** Standard `Request` -> `HttpServerRequest`: method/url/headers/body carried over unchanged. */
export const fromWorkerRequest = (request: globalThis.Request): HttpServerRequest.HttpServerRequest =>
  HttpServerRequest.fromWeb(request)

/**
 * Wraps an assembled `HttpRouter` as a worker-compatible fetch handler.
 *
 * `services` is REQUIRED: it is the request-time context for everything the
 * routes need (e.g. AdminToken). Passing an incomplete context surfaces as a
 * deterministic auth failure, never as silently dropped services.
 *
 * Router failures are mapped through `HttpServerError.causeResponse`, so
 * unmatched routes become 404 and handler errors keep their status codes.
 * Every >=400 response with an empty body gets a decodable ControlError JSON
 * body so CLI clients can always parse the failure shape.
 */
export const toFetchHandler = (
  router: HttpRouter.HttpRouter,
  services: Context.Context<never>,
): ((request: globalThis.Request) => Promise<Response>) => {
  const app = Effect.scoped(router.asHttpEffect())
  return (request) =>
    Effect.runPromise(
      app.pipe(
        Effect.provide(services),
        Effect.provideService(HttpServerRequest.HttpServerRequest, fromWorkerRequest(request)),
        Effect.map(HttpServerResponse.toWeb),
        Effect.catchCause((cause) =>
          Effect.map(
            HttpServerError.causeResponse(cause),
            ([response]) => HttpServerResponse.toWeb(withDecodableErrorBody(response)),
          )
        ),
      ),
    )
}

/** Fills empty error bodies with the encoded ControlError shapes clients decode. */
const withDecodableErrorBody = (response: HttpServerResponse.HttpServerResponse): HttpServerResponse.HttpServerResponse => {
  if (response.body._tag !== 'Empty' || response.status < 400) return response
  if (response.status === 404) {
    return errorJson({ _tag: 'InvalidControlInput', message: 'No such admin operation route' }, 404)
  }
  if (response.status >= 500) {
    return errorJson({ _tag: 'ControlApplicationFailure', message: 'Admin plane internal error' }, response.status)
  }
  return errorJson({ _tag: 'InvalidControlInput', message: 'Malformed admin request' }, response.status)
}

const errorJson = (body: Record<string, unknown>, status: number): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(JSON.stringify(body), { status, contentType: 'application/json' })

// ---------------------------------------------------------------------------
// Auth: constant-time bearer token
// ---------------------------------------------------------------------------

/** Injected admin credential; provided by the host environment (Worker secret / env var). */
export class AdminToken extends Context.Service<AdminToken, { readonly token: string }>()(
  'discord-bot/AdminToken',
) {}

export const AdminTokenLive = (token: string): Layer.Layer<AdminToken> => Layer.succeed(AdminToken, { token })

/** Byte-wise XOR comparison over the longer operand: never short-circuits on content. */
export const constantTimeEquals = (a: string, b: string): boolean => {
  const encoder = new TextEncoder()
  const left = encoder.encode(a)
  const right = encoder.encode(b)
  let diff = left.length ^ right.length
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index++) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return diff === 0
}

const bearerPrefix = 'Bearer '

/**
 * Auth middleware: requires `Authorization: Bearer <token>` matching the
 * injected AdminToken; rejects other callers with a 401 carrying the encoded
 * `ControlAuthorizationRejected` shape the CLI maps to exit code "Rejected".
 * The scheme prefix and presence checks are not secret-dependent; the
 * credential itself is only ever compared through `constantTimeEquals`.
 */
export const bearerAuth = HttpMiddleware.make((httpApp) =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
    Effect.flatMap(AdminToken, ({ token }) => {
      // Scheme comparison is case-insensitive (RFC 9110) and not
      // secret-dependent; only the credential is compared constant-time.
      const authorization = request.headers['authorization']
      const normalized = authorization?.toLowerCase()
      if (
        authorization === undefined ||
        normalized === undefined ||
        normalized.startsWith(bearerPrefix.toLowerCase()) === false ||
        constantTimeEquals(authorization.slice(bearerPrefix.length), token) === false
      ) {
        return Effect.succeed(HttpServerResponse.text(
          JSON.stringify({ _tag: 'ControlAuthorizationRejected', message: 'Missing or invalid admin token' }),
          { status: 401, contentType: 'application/json' },
        ))
      }
      return httpApp
    })))

// ---------------------------------------------------------------------------
// Payload schemas + responses
// ---------------------------------------------------------------------------

export type ControlResultJson = ControlResult

const json = <TControlResult extends ControlResultJson>(
  body: TControlResult,
  status: number,
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(JSON.stringify(body), { status, contentType: 'application/json' })

/**
 * Validates a decoded JSON body against a payload schema. Returns the parsed
 * value, or fails with a 422 response carrying `InvalidControlInput` — never
 * throws and never leaks schema internals.
 */
const decodePayload = <S extends Schema.Top>(
  schema: S,
): ((body: unknown) => Effect.Effect<Schema.Schema.Type<S>, HttpServerResponse.HttpServerResponse>) => {
  // The parse effect's error channel is schema-internal (ParseIssue etc.);
  // catchIf swallows every variant and replaces it with the single decodable
  // InvalidControlInput response.
  const parse = Schema.decodeUnknownEffect(schema) as unknown as (
    body: unknown,
  ) => Effect.Effect<Schema.Schema.Type<S>, unknown>
  return (body) =>
    parse(body).pipe(
      Effect.catchIf(
        () => true,
        () =>
          Effect.fail(errorJson(
            { _tag: 'InvalidControlInput', message: 'Request payload failed schema validation' },
            422,
          )),
      ),
    ) as unknown as Effect.Effect<Schema.Schema.Type<S>, HttpServerResponse.HttpServerResponse>
}

/** Reads the JSON body, treating an absent/unparseable body as `{}` (the encoded EmptyPayload). */
const readJsonBody = (request: HttpServerRequest.HttpServerRequest): Effect.Effect<unknown, unknown> =>
  request.json.pipe(Effect.catchIf(() => true, () => Effect.succeed({})))

/**
 * Fallback when no thread-creation runtime is wired into this admin plane
 * instance (standalone use, tests of other routes): the route validates the
 * payload and reports the operation unavailable — it NEVER fabricates a
 * Success/AlreadySatisfied result for work that did not happen.
 */
const threadCreateUnavailable = errorJson(
  {
    _tag: 'ControlDependencyUnavailable',
    dependency: 'thread-creation-runtime',
    message:
      'ThreadCreate is not served by this deployment yet; use the socket control plane on the dev4 runtime',
  },
  503,
)

/** Live snapshot injected from the BotState Durable Object; absent ⇒ 503. */
export interface RuntimeStatusSnapshot {
  readonly health: GatewayHealthSummary
  readonly journalSchemaVersion: number
  readonly docsMonthlySpentUsdMicros: number
  /** Config projection (`encodeConfigSummary`); present once the runtime loaded its config. */
  readonly configSummary?: RuntimeConfigSummary | undefined
}

const runtimeStatusResponse = (
  snapshot: RuntimeStatusSnapshot,
): HttpServerResponse.HttpServerResponse => {
  const readiness = evaluateReadiness(snapshot)
  return json(
    {
      _tag: 'Success',
      summary: readiness.ready === true ? `supervisor=${snapshot.health.supervisor} session=${snapshot.health.sessionPresent} docsSpendUsdMicros=${snapshot.docsMonthlySpentUsdMicros}` : `runtime unavailable (schemaVersion=${snapshot.journalSchemaVersion})`,
      health: snapshot.health,
      ...(snapshot.configSummary === undefined ? {} : { configSummary: snapshot.configSummary }),
    },
    readiness.ready === true ? 200 : 503,
  )
}

const runtimeStatusUnavailable = errorJson(
  {
    _tag: 'ControlDependencyUnavailable',
    dependency: 'runtime-status-source',
    message: 'No runtime status source is wired into this admin plane instance',
  },
  503,
)

const parseThreadCreate = decodePayload(OperatorThreadCreatePayload)
const parseEmpty = decodePayload(EmptyPayload)
const parseCommandsSync = decodePayload(CommandsSyncPayload)

const configUnavailable = errorJson(
  {
    _tag: 'ControlDependencyUnavailable',
    dependency: 'runtime-config-store',
    message: 'No runtime config store is wired into this admin plane instance',
  },
  503,
)

const threadReconcileUnavailable = errorJson(
  {
    _tag: 'ControlDependencyUnavailable',
    dependency: 'thread-reconciliation-runtime',
    message: 'No thread reconciliation is wired into this admin plane instance',
  },
  503,
)

const commandsSyncUnavailable = errorJson(
  {
    _tag: 'ControlDependencyUnavailable',
    dependency: 'application-command-sync',
    message: 'No application-command sync is wired into this admin plane instance',
  },
  503,
)

// ---------------------------------------------------------------------------
// Router assembly
// ---------------------------------------------------------------------------

type AdminRouterEffect = Effect.Effect<
  HttpRouter.HttpRouter,
  never,
  | HttpRouter.Request.From<'GlobalRequires', AdminToken>
  | HttpRouter.Request.From<'Error', HttpServerResponse.HttpServerResponse>
>

export interface AdminRouterOptions {
  /**
   * Live runtime snapshot source, wired from the BotState Durable Object in
   * the worker. Absent (tests of other routes, standalone use) ⇒ RuntimeStatus
   * reports ControlDependencyUnavailable instead of a fabricated snapshot.
   */
  readonly runtimeStatus?: () => Effect.Effect<RuntimeStatusSnapshot>
  /**
   * Real operator thread creation through the journal-claimed thread workflow.
   * Receives the already schema-validated payload; returns the plain JSON
   * outcome (`AdminOperationOutcome`). Absent ⇒ 503 unavailable, never a
   * fabricated Success.
   */
  readonly threadCreate?: ((payload: unknown) => Effect.Effect<AdminOperationOutcome>) | undefined
  /** Storage-first config read. Absent ⇒ 503. */
  readonly configGet?: Effect.Effect<AdminOperationOutcome> | undefined
  /** Revision-guarded validated persistence and optional atomic runtime reload. Absent ⇒ 503. */
  readonly configPut?: ((payload: unknown) => Effect.Effect<AdminOperationOutcome>) | undefined
  /** Guarded plan/apply command reconciliation against the running config. Absent ⇒ 503. */
  readonly commandsSync?: ((payload: unknown) => Effect.Effect<AdminOperationOutcome>) | undefined
  /** Journal reconciliation (Plan or Apply). Absent ⇒ 503. */
  readonly threadReconcile?: ((payload: unknown) => Effect.Effect<AdminOperationOutcome>) | undefined
}

/** Renders a plain JSON operation outcome as an HTTP response. */
const outcomeResponse = (outcome: AdminOperationOutcome): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(JSON.stringify(outcome.body), { status: outcome.status, contentType: 'application/json' })


/**
 * Builds the admin router. The returned effect carries dispatch-time phantom
 * markers (global bearer auth needs AdminToken; handler failures surface as
 * response-valued errors) — they describe request-time context, not
 * construction-time work.
 */
export const makeAdminRouter = (options: AdminRouterOptions = {}): AdminRouterEffect =>
  Effect.gen(function* () {
    const router = yield* HttpRouter.make

    // Auth wraps the ENTIRE dispatch (global middleware), so unknown routes
    // answer 401 to unauthenticated callers instead of leaking route
    // existence through a 404 oracle.
    yield* router.addGlobalMiddleware(bearerAuth)
    // ThreadCreate: validated against the same schema the CLI encodes, then
    // executed by the REAL operator trigger (journal claim → Discord API →
    // outcome) when the runtime is wired; absent ⇒ 503 unavailable — never a
    // fabricated Success.
    yield* router.add('POST', '/admin/rpc/ThreadCreate', (request) =>
      Effect.flatMap(readJsonBody(request), (body) =>
        Effect.flatMap(parseThreadCreate(body), () =>
          options.threadCreate === undefined
            ? Effect.succeed(threadCreateUnavailable)
            : Effect.map(options.threadCreate(body), outcomeResponse))))
    // Real reconciliation over ambiguous journal entries (Node control-plane
    // parity); absent runtime ⇒ 503 unavailable.
    yield* router.add('POST', '/admin/rpc/ThreadReconcile', (request) =>
      Effect.flatMap(readJsonBody(request), (body) =>
        options.threadReconcile === undefined
          ? Effect.succeed(threadReconcileUnavailable)
          : Effect.map(options.threadReconcile(body), outcomeResponse)))
    yield* router.add('POST', '/admin/rpc/RuntimeStatus', (request) =>
      Effect.flatMap(readJsonBody(request), (body) =>
        Effect.flatMap(parseEmpty(body), () =>
          options.runtimeStatus === undefined
            ? Effect.succeed(runtimeStatusUnavailable)
            : Effect.map(options.runtimeStatus(), runtimeStatusResponse))))
    yield* router.add('POST', '/admin/commands-sync', (request) =>
      Effect.flatMap(readJsonBody(request), (body) =>
        Effect.flatMap(parseCommandsSync(body), (payload) =>
          options.commandsSync === undefined
            ? Effect.succeed(commandsSyncUnavailable)
            : Effect.map(options.commandsSync(payload), outcomeResponse))))

    // Policy/config plane over the SAME durable config document the handlers
    // consume: GET returns the validated summary plus the stored payload,
    // PUT validates through RuntimeConfigStore.write before persisting.
    yield* router.add('GET', '/admin/config', () =>
      options.configGet === undefined
        ? Effect.succeed(configUnavailable)
        : Effect.map(options.configGet, outcomeResponse))
    yield* router.add('PUT', '/admin/config', (request) =>
      Effect.flatMap(readJsonBody(request), (body) =>
        options.configPut === undefined
          ? Effect.succeed(configUnavailable)
          : Effect.map(options.configPut(body), outcomeResponse)))

    return router
  }).pipe(Effect.provide(Layer.succeed(HttpRouter.RouterConfig, {}))) as unknown as AdminRouterEffect

/**
 * Compile-time contract: `AdminRouterEffect` pins the exact phantom set. If a
 * future route adds another service or typed error, makeAdminRouter's
 * inferred type becomes inassignable to it and tsc fails at that call site —
 * this function is the single, explicit discharge point into a runnable value.
 */
export const runAdminRouter = (routerEffect: AdminRouterEffect): HttpRouter.HttpRouter =>
  Effect.runSync(routerEffect as unknown as Effect.Effect<HttpRouter.HttpRouter>)

export const makeAdminHandler = (
  token: string,
  options: AdminRouterOptions = {},
): ((request: globalThis.Request) => Promise<Response>) =>
  toFetchHandler(runAdminRouter(makeAdminRouter(options)), Context.make(AdminToken, { token }))
