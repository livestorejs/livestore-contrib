/**
 * ElectricSQL Test Provider
 *
 * This provider writes events directly to Postgres and reads them through ElectricSQL's HTTP API.
 * This is the expected ElectricSQL architecture: applications write to Postgres, and Electric
 * automatically syncs and serves that data through its shape-based replication system.
 *
 * Note: There may be a small delay between writing to Postgres and Electric discovering/syncing
 * the new data, especially for newly created tables. This is normal ElectricSQL behavior.
 */
import http from 'node:http'
import path from 'node:path'

import postgres from 'postgres'

import { UnknownError } from '@livestore/common'
import type { LiveStoreEvent } from '@livestore/livestore'
import { nanoid, Schema } from '@livestore/livestore'
import * as ElectricSync from '@livestore/sync-electric'
import { DockerCompose } from '@livestore/utils-dev/node'
import {
  type Cause,
  ChildProcessSpawner,
  Effect,
  HttpClient,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  Layer,
  type PlatformError,
} from '@livestore/utils/effect'
import { getFreePort, PlatformNode } from '@livestore/utils/node'

import { SyncProviderImpl, type SyncProviderLayer } from '../types.ts'

// Also support scenarios where Docker is not running locally but via a Docker remote context (@schickling needs this)
const dockerHostName = process.env.DOCKER_CONTEXT ?? 'localhost'

export const name = 'ElectricSQL'

const DockerComposeLive = DockerCompose.layer({ cwd: path.join(import.meta.dirname, 'electric') })
const streamResponseHeaders = (headers: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => ['content-length', 'transfer-encoding', 'connection'].includes(name.toLowerCase()) === false,
    ),
  )

export const prepare: Effect.Effect<
  void,
  PlatformError.PlatformError | DockerCompose.DockerComposeError,
  ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const dockerCompose = yield* DockerCompose.DockerCompose
  yield* dockerCompose.pull
}).pipe(Effect.provide(DockerComposeLive), Effect.withSpan('electric-provider:prepare'))

export const getProviderSpecific = (provider: SyncProviderImpl['Service']) =>
  provider.providerSpecific as {
    getDbForTesting: (storeId: string) => {
      migrate: Effect.Effect<void, Cause.UnknownError>
      disconnect: Effect.Effect<void, Cause.UnknownError>
      sql: any
      tableName: string
    }
  }

export const layer: SyncProviderLayer = Layer.effect(
  SyncProviderImpl,
  Effect.gen(function* () {
    const { endpointPort, postgresPort } = yield* startElectricApi

    return {
      makeProvider: ElectricSync.makeSyncBackend({ endpoint: `http://localhost:${endpointPort}` }),
      turnBackendOffline: Effect.log('TODO implement turnBackendOffline'),
      turnBackendOnline: Effect.log('TODO implement turnBackendOnline'),
      push: () => Effect.log('TODO implement push'),
      providerSpecific: {
        getDbForTesting: (storeId: string) => {
          const db = makeDb({ storeId, postgresPort })
          return {
            migrate: db.migrate,
            disconnect: db.disconnect,
            sql: db.sql,
            tableName: db.tableName,
          }
        },
      },
    }
  }),
).pipe(
  Layer.provide(DockerComposeLive),
  Layer.provide(PlatformNode.NodeServices.layer),
  UnknownError.mapToUnknownErrorLayer,
)

const startElectricApi = Effect.gen(function* () {
  const electricPort = yield* getFreePort
  const postgresPort = yield* getFreePort
  // Use a unique Docker Compose project name per test runtime to avoid collisions
  const projectName = process.env.COMPOSE_PROJECT_NAME ?? `ls_electric_${nanoid().toLowerCase()}`

  // Start Docker Compose services (postgres + electric)
  const healthCheckUrl = `http://${dockerHostName}:${electricPort}/v1/health`
  yield* Effect.logDebug('Health check URL:', healthCheckUrl)
  yield* Effect.logDebug('Electric port:', electricPort)
  yield* Effect.logDebug('Postgres port:', postgresPort)
  yield* Effect.logDebug('Compose project name:', projectName)

  const dockerCompose = yield* DockerCompose.DockerCompose
  yield* dockerCompose.start({
    healthCheck: { url: healthCheckUrl },
    env: {
      // Ensure each test runtime uses its own isolated compose project
      COMPOSE_PROJECT_NAME: projectName,
      ELECTRIC_PORT: electricPort.toString(),
      POSTGRES_PORT: postgresPort.toString(),
    },
    // forwardLogs: true,
  })

  // Ensure resources are cleaned up on scope exit (containers and networks)
  yield* Effect.addFinalizer(() =>
    dockerCompose.down({ env: { COMPOSE_PROJECT_NAME: projectName }, volumes: true }).pipe(Effect.orDie),
  )

  // Get a free port for our HTTP API server
  const endpointPort = yield* getFreePort

  // Start the HTTP server in the background
  yield* HttpRouter.serve(makeRouter({ electricPort, postgresPort })).pipe(
    Layer.provide(PlatformNode.NodeHttpServer.layer(() => http.createServer(), { port: endpointPort })),
    Layer.launch,
    Effect.tapCauseLogPretty,
    Effect.forkScoped,
  )

  return { endpointPort, postgresPort }
}).pipe(Effect.withSpan('electric-provider:startElectricApi'))

const makeRouter = ({ electricPort, postgresPort }: { electricPort: number; postgresPort: number }) => {
  const electricHost = `http://${dockerHostName}:${electricPort}`
  const apiSecret = 'change-me-electric-secret'

  return HttpRouter.use((router) =>
    Effect.gen(function* () {
      // GET / (pull)
      yield* router.add(
        'GET',
        '/',
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest

          // HEAD / (ping): v4 HttpRouter serves unmatched HEAD requests via the GET handler,
          // so proxy the reachability probe to Electric before running the pull logic.
          if (request.method === 'HEAD') {
            const electricResponse = yield* HttpClient.head(electricHost)

            return HttpServerResponse.empty().pipe(
              HttpServerResponse.setStatus(electricResponse.status),
              HttpServerResponse.setHeaders(streamResponseHeaders(electricResponse.headers)),
            )
          }

          const { url, storeId, needsInit /* payload */ } = ElectricSync.makeElectricUrl({
            electricHost,
            searchParams: new URL(request.url, `http://localhost`).searchParams,
            apiSecret,
          })

          // Validate auth token (for testing purposes)
          // if ((payload as any)?.authToken !== 'insecure-token-change-me') {
          //   return yield* HttpServerResponse.json({ error: 'Invalid auth token' }).pipe(
          //     Effect.andThen(HttpServerResponse.setStatus(401)),
          //   )
          // }

          if (needsInit === true) {
            const db = makeDb({ storeId, postgresPort })
            yield* db.migrate
            yield* db.disconnect
          }

          const electricResponse = yield* HttpClient.get(url)

          return HttpServerResponse.stream(electricResponse.stream, {
            headers: streamResponseHeaders(electricResponse.headers),
            status: electricResponse.status,
          })
        }),
      )

      // POST / (push)
      yield* router.add(
        'POST',
        '/',
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const body = yield* request.json
          const parsedPayload = yield* Schema.decodeUnknownEffect(ElectricSync.ApiSchema.PushPayload)(body)

          const db = makeDb({ storeId: parsedPayload.storeId, postgresPort })

          yield* db.migrate
          yield* db.createEvents(parsedPayload.batch)
          yield* db.disconnect

          return yield* HttpServerResponse.json({ success: true })
        }),
      )

    }),
  )
}

const makeDb = ({ storeId, postgresPort }: { storeId: string; postgresPort: number }) => {
  const tableName = ElectricSync.toTableName(storeId)

  const sql = postgres({
    database: 'electric',
    user: 'postgres',
    password: 'password',
    host: dockerHostName,
    port: postgresPort,
  })

  const migrate = Effect.tryPromise(
    () =>
      sql`
    CREATE TABLE IF NOT EXISTS ${sql(tableName)} (
      "seqNum" INTEGER PRIMARY KEY,
      "parentSeqNum" INTEGER,
      "name" TEXT NOT NULL,
      "args" JSONB NOT NULL,
      "clientId" TEXT NOT NULL,
      "sessionId" TEXT NOT NULL
    )
  `,
  ).pipe(Effect.withSpan('electric-provider:migrate'))

  const createEvents = (events: ReadonlyArray<LiveStoreEvent.Global.Encoded>) =>
    Effect.tryPromise(async () => {
      // For postgres library, we need to use the exact column names as properties
      // Since our columns are quoted in the CREATE TABLE, we need to match them
      for (const event of events) {
        await sql`
          INSERT INTO ${sql(tableName)} ("seqNum", "parentSeqNum", "name", "args", "clientId", "sessionId")
          VALUES (${event.seqNum}, ${event.parentSeqNum}, ${event.name}, ${sql.json(event.args)}, ${event.clientId}, ${event.sessionId})
        `
      }
    }).pipe(Effect.withSpan('electric-provider:createEvents'))

  const disconnect = Effect.tryPromise(() => sql.end()).pipe(Effect.withSpan('electric-provider:disconnect'))

  return { migrate, createEvents, disconnect, sql, tableName }
}
