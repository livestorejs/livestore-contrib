import * as Cloudflare from 'alchemy/Cloudflare'
import { WorkerEnvironment } from 'alchemy/Cloudflare'

import * as Config from 'effect/Config'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'

import { AdminToken, makeAdminRouter, runAdminRouter, toFetchHandler } from './admin.ts'
import { readSecret } from './env.ts'
import { BotState } from './bot-state.ts'
import { evaluateReadiness } from './readiness.ts'
import { releaseIdConfig } from './release.ts'

const configuredWorkerName = process.env['CF_WORKER_NAME']?.trim()


/**
 * Discord bot Worker — the main module. Hosts one Durable Object class
 * (SQLite-backed by default for new classes), binds five secrets, attaches a
 * 1-minute cron trigger, and dispatches fetches between the authenticated
 * admin plane (`POST /admin/rpc/*`, `GET|PUT /admin/config`,
 * `POST /admin/commands-sync`) and the readiness probe (`/readyz`).
 */
export class DiscordBot extends Cloudflare.Worker<DiscordBot>()(
  'DiscordBot',
  {
    // This module is its own entry; rolldown bundles it before upload.
    main: import.meta.url,
    // Remote stacks pin the existing script name before adopting local state
    // into Cloudflare state. Local workerd keeps Alchemy's generated name.
    ...(configuredWorkerName === undefined || configuredWorkerName === ''
      ? {}
      : { name: configuredWorkerName }),
    // nodejs_compat must stay OFF: the worker graph is node-builtin-free by
    // construction and bundle-check.unit.test.ts enforces it (source recrawl
    // plus post-build dist scan when dist/ exists).
    // Local workerd binaries lag the edge; ALCHEMY_LOCAL=1 clamps the date
    // so credential-free local runs work. Flags stay empty either way.
    ...(process.env['ALCHEMY_LOCAL'] === '1'
      ? { compatibility: { date: '2026-07-11', flags: [] } }
      : { compatibility: { date: '2026-08-01', flags: [] } }),
    env: {
      // Redacted configs become secret_text bindings. RELEASE_ID is a
      // non-secret plain-text binding and is mandatory outside local workerd.
      DISCORD_BOT_TOKEN: Config.redacted('DISCORD_BOT_TOKEN'),
      OPENAI_API_KEY: Config.redacted('OPENAI_API_KEY'),
      DOCS_CORRELATION_KEY: Config.redacted('DOCS_CORRELATION_KEY'),
      E2E_ACTOR_TOKEN: Config.redacted('E2E_ACTOR_TOKEN'),
      ADMIN_TOKEN: Config.redacted('ADMIN_TOKEN'),
      RELEASE_ID: releaseIdConfig(process.env['ALCHEMY_LOCAL'] === '1'),
      // The gateway DO reports the version it is actually assigned during a
      // Cloudflare versions deployment; singleton rollout is therefore
      // observable even though percentages are not a meaningful bot canary.
      CF_VERSION_METADATA: Cloudflare.Workers.VersionMetadata(),
    },
  },
  Effect.gen(function* () {
    // Yielding the DO class here binds it to this same Worker (same-worker
    // host); the class migration is derived from bindings automatically.
    const botState = yield* BotState

    const env = yield* WorkerEnvironment
    // Secret reads stay lazy: the deploy phase evaluates this init with
    // placeholder bindings, so ADMIN_TOKEN resolves on first request. Every
    // admin operation delegates into the gateway DO, which owns the runtime
    // (config store, journal, thread workflow, command sync).
    let adminHandler: ((request: globalThis.Request) => Promise<Response>) | undefined
    const getAdminHandler = () => {
      if (adminHandler === undefined) {
        const gateway = botState.getByName('gateway')
        adminHandler = toFetchHandler(
          runAdminRouter(makeAdminRouter({
            runtimeStatus: () => gateway.status(),
            threadCreate: (payload) => gateway.threadCreate(payload),
            configGet: gateway.configGet(),
            configPut: (payload) => gateway.configPut(payload),
            commandsSync: (payload) => gateway.commandsSync(payload),
            threadReconcile: (payload) => gateway.threadReconcile(payload),
          })),
          Context.make(AdminToken, { token: readSecret(env, 'ADMIN_TOKEN') }),
        )
      }
      return adminHandler
    }

    yield* Cloudflare.Workers.cron('* * * * *', () =>
      Effect.asVoid(botState.getByName('gateway').tick())).pipe(
        Effect.provide(Cloudflare.Workers.CronEventSourceLive),
      )

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        // Local workerd may deliver a non-absolute request URL; normalize so
        // URL parsing and the web-Request bridge always see an absolute form.
        const requestUrl = new URL(request.url, 'http://localhost').toString()
        const pathname = new URL(requestUrl).pathname

        if (pathname === '/readyz') {
          // Public-minimal projection: release/version identity and boolean
          // checks only. Error text, session identifiers, and spend remain
          // behind the authenticated admin plane.
          const report = evaluateReadiness(yield* botState.getByName('gateway').status())
          return HttpServerResponse.text(JSON.stringify(report), {
            status: report.ready === true ? 200 : 503,
            contentType: 'application/json',
          })
        }

        // The whole /admin plane (rpc operations, config GET/PUT, command
        // sync) is bearer-authenticated by the router's global middleware.
        if (pathname.startsWith('/admin/') === true) {
          // A malformed incoming request degrades to a plain 400 instead of
          // leaking the driver's parse-error channel through fetch.
          const response = yield* Effect.matchEffect(HttpServerRequest.toWeb({ ...request, url: requestUrl }), {
            onFailure: () => Effect.succeed(new Response('bad request', { status: 400 })),
            onSuccess: (web) => Effect.promise(() => getAdminHandler()(web)),
          })
          return HttpServerResponse.fromWeb(response)
        }

        return HttpServerResponse.text('not found', { status: 404 })
      }),
    }
  }),
) {}

// The local runtime and bundler import the entrypoint as the module's
// default export.
export default DiscordBot

// Re-exported so the bundled worker module keeps the DO class in its export
// surface for Cloudflare's runtime to discover.
export { BotState }
