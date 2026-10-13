import path from 'node:path'

import { makeAdapter } from '@livestore/adapter-node'
import { liveStoreVersion } from '@livestore/common'
import type { LiveStoreSchema } from '@livestore/common/schema'
import { createStore, queryDb, Schema } from '@livestore/livestore'
import { makeWsSync } from '@livestore/sync-cf/client'
import { Effect, Layer, Option, References, Stream } from '@livestore/utils/effect'
import { Cli, PlatformNode } from '@livestore/utils/node'
import { OtelLiveHttp } from '@livestore/utils-dev/node'

const storeIdOption = Cli.Flag.String('store-id').pipe(Cli.Flag.withDefault('default'))
const baseDirectoryOption = Cli.Flag.String('storage-fs-base-directory').pipe(Cli.Flag.withDefault(''))
const schemaPathOption = Cli.Flag.String('schema-path')
const enableDevtoolsOption = Cli.Flag.Boolean('enable-devtools').pipe(Cli.Flag.withDefault(false))
const adapterTypeOption = Cli.Flag.Literals('storage', ['fs', 'in-memory']).pipe(Cli.Flag.withDefault('fs'))

const syncPayloadOption = Cli.Flag.String('sync-payload').pipe(
  Cli.Flag.withSchema(Schema.fromJsonString(Schema.Json)),
  Cli.Flag.optional,
)

const pull = Cli.Command.make('pull', {}, () => Effect.log('Pulling...'))
const push = Cli.Command.make('push', {}, () => Effect.log('Pushing...'))
const live = Cli.Command.make(
  'live',
  {
    baseDirectory: baseDirectoryOption,
    storeId: storeIdOption,
    schemaPath: schemaPathOption,
    enableDevtools: enableDevtoolsOption,
    adapterType: adapterTypeOption,
    syncPayload: syncPayloadOption,
  },
  ({ baseDirectory, storeId, schemaPath, enableDevtools, adapterType, syncPayload }) =>
    Effect.gen(function* () {
      const relativeSchemaPath = path.isAbsolute(schemaPath) ? schemaPath : path.resolve(process.cwd(), schemaPath)
      // console.log('relativeSchemaPath', relativeSchemaPath)
      const schema: LiveStoreSchema = yield* Effect.promise(() => import(relativeSchemaPath).then((m) => m.schema))

      const adapter = makeAdapter({
        storage: adapterType === 'fs' ? { type: 'fs', baseDirectory } : { type: 'in-memory' },
        devtools: { schemaPath },
        sync: { backend: makeWsSync({ url: 'ws://localhost:8787' }) },
      })

      const store = yield* createStore({
        adapter,
        schema,
        storeId,
        disableDevtools: !enableDevtools,
        syncPayload: Option.getOrUndefined(syncPayload),
      })

      const firstTable = schema.state.sqlite.tables.values().next().value!

      const queries$ = queryDb(firstTable.orderBy('id', 'desc').limit(10))

      yield* store.subscribeStream(queries$).pipe(
        Stream.tap((result) => Effect.log('query', result)),
        Stream.runDrain,
      )

      // while (true) {
      //   const prompt = yield* Cli.Prompt.text({ message: 'run mutation\n' })
      //   Effect.log('prompt', prompt).pipe(Effect.provide(runtime), Effect.runSync)
      //   // console.log('res', res)
      //   store.commit(tables.todo.insert({ id: nanoid(), title: prompt }))
      // }

      // yield* Effect.sleep(400)

      // yield* FiberSet.clear(fiberSet)

      // TODO get rid of this sleep in better handle initial boot/interruption of worker thread
      // const res = store.query(tables.todo.query)
      // console.log('res', res)
    }).pipe(Effect.scoped, Effect.withSpan('@livestore/examples/cli:main')),
)

const client = Cli.Command.make('client').pipe(Cli.Command.withSubcommands([pull, push, live]))

const start = Cli.Command.make('start', {}, () =>
  Effect.gen(function* () {
    yield* Effect.log('Starting...')
    yield* Effect.never
  }),
)

const server = Cli.Command.make('server').pipe(Cli.Command.withSubcommands([start]))

const otelLayer = OtelLiveHttp({ serviceName: 'livestore-cli', skipLogUrl: false, traceNodeBootstrap: true })

const command = Cli.Command.make('livestore').pipe(
  Cli.Command.withSubcommands([client, server]),
  Cli.Command.provide(otelLayer),
)

const cli = Cli.Command.run(command, { version: liveStoreVersion })

const layer = Layer.mergeAll(
  PlatformNode.NodeServices.layer,
  Layer.succeed(References.MinimumLogLevel, 'Debug'),
)

cli.pipe(
  Effect.annotateLogs({ thread: 'cli-main' }),
  Effect.provide(layer),
  PlatformNode.NodeRuntime.runMain,
)
