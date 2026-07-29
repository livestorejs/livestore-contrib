import type { BootStatus } from '@livestore/common'
import { Devtools, provideOtel } from '@livestore/common'
import * as LiveStore from '@livestore/livestore'
import * as LiveStoreReact from '@livestore/react'
import { Effect, Exit, References, Schema, Scope, Stream } from '@livestore/utils/effect'
import { createFileRoute } from '@tanstack/react-router'
import React from 'react'
import { unstable_batchedUpdates as batchUpdates } from 'react-dom'

import { useApiContext } from '../api-context.js'
import { ClientSessionList } from '../components/ClientSessionList.js'
import { ButtonSm } from '../components/DevToolsButtons.tsx'
import { AllTabs } from '../components/Tabs/AllTabs.js'
import { VersionMismatchOverlay } from '../components/VersionMismatchOverlay.js'
import type { VersionMismatchStatus } from '../devtools-api.js'
import { makeDevtoolsStateAdapter } from '../devtools-state-adapter.ts'
import { DevtoolsStoreContext, useDevtoolsStore } from '../devtools-store-context.js'
import { backgroundWork } from '../effect/background.js'
import LiveStoreWorker from '../livestore/livestore.worker?worker&inline'
import { schema } from '../livestore/schema.js'
import { useRootContext } from '../root-context.js'
import { SessionContext, useSessionContext } from '../session-context.js'

const RouteComponent: React.FC = () => {
  const { storeId, clientId, sessionId, schemaAlias, mode } = Route.useParams()
  const { options, appSchemas, onBoot } = useRootContext()
  const { api } = useApiContext()
  const [session, setSession] = React.useState<SessionContext | undefined>(undefined)
  const [status, setStatus] = React.useState<'connected' | 'disconnected'>('connected')
  const [versionMismatch, setVersionMismatch] = React.useState<VersionMismatchStatus | undefined>(
    undefined,
  )
  const [error, setError] = React.useState<string | undefined>(undefined)
  const [devtoolsStore, setDevtoolsStore] = React.useState<
    (LiveStore.Store<typeof schema> & LiveStoreReact.ReactApi) | undefined
  >(undefined)
  const [bootStatus, setBootStatus] = React.useState<BootStatus>({ stage: 'loading' })

  React.useEffect(() => {
    Effect.gen(function* () {
      const apiSession = yield* api.connect(
        Devtools.SessionInfo.SessionInfo.make({
          storeId,
          clientId,
          sessionId,
          schemaAlias,
          isLeader: true,
          origin: typeof window !== 'undefined' ? window.location.origin : undefined,
        }),
      )

      yield* apiSession.status.pipe(
        Stream.tapSync((_) => setStatus(_._tag)),
        Stream.runDrain,
        Effect.forkScoped,
      )

      yield* apiSession.versionMismatch.pipe(
        Stream.tapSync((_) => setVersionMismatch(_)),
        Stream.runDrain,
        Effect.forkScoped,
      )

      const aliases = new Set(appSchemas.map((schema) => schema.devtools.alias))
      if (appSchemas.length > 1 && aliases.size !== appSchemas.length) {
        setError(
          `You have configured multiple schemas. Please make sure all schemas have a unique option for 'makeSchema({ devtools: { alias: 'unique-alias' } })'. Found aliases: ${Array.from(aliases).join(', ')}`,
        )
        return
      }

      const appSchema = appSchemas.find((schema) => schema.devtools.alias === schemaAlias)

      if (appSchema === undefined) {
        setError(
          `Could not find schema with hash ${schemaAlias}. Please make sure you have provided the schema in "schemaPath". Found aliases: ${Array.from(aliases).join(', ')}`,
        )
        return
      }

      setSession({ apiSession, appSchema })

      return yield* Effect.never
    }).pipe(
      Effect.scoped,
      Effect.tapCauseLogPretty,
      Effect.provideService(References.MinimumLogLevel, 'Debug'),
      Effect.runCallback,
    )
  }, [api, clientId, sessionId, storeId, appSchemas, schemaAlias])

  const adapter = React.useMemo(
    () =>
      makeDevtoolsStateAdapter({
        mode,
        storeId,
        worker: LiveStoreWorker,
        options,
      }),
    [options, storeId, mode],
  )

  React.useEffect(() => {
    const storeScope = Scope.make().pipe(Effect.runSync)

    Effect.gen(function* () {
      const store = yield* LiveStore.createStore({
        schema,
        adapter,
        batchUpdates,
        storeId: `livestore-devtools-${storeId}`,
        disableDevtools: true,
        confirmUnsavedChanges: false,
        ...(onBoot !== undefined
          ? {
              boot: (store) => onBoot(store as LiveStore.Store),
            }
          : {}),
        onBootStatus: setBootStatus,
      }).pipe(provideOtel({}), Effect.provideService(References.MinimumLogLevel, 'Debug'))

      setDevtoolsStore(LiveStoreReact.withReactApi(store))
    }).pipe(
      Scope.provide(storeScope),
      Effect.tapCauseLogPretty,
      Effect.forkIn(storeScope),
      Effect.runFork,
    )

    return () => {
      Scope.close(storeScope, Exit.void).pipe(Effect.tapCauseLogPretty, Effect.runFork)
      setDevtoolsStore(undefined)
    }
  }, [adapter, storeId, onBoot])

  if (error) {
    return (
      <div className="p-3 text-sm">
        <div className="text-red-500 font-mono">{error}</div>
      </div>
    )
  }

  if (session === undefined) {
    // Show version mismatch overlay even while connecting/before session is established
    if (versionMismatch?._tag === 'mismatch') {
      return <VersionMismatchOverlay versionMismatch={versionMismatch} />
    }

    return (
      <div className="p-3 text-sm">
        <div>
          Connecting to session ({storeId}-{clientId}-{sessionId}-{schemaAlias})...
        </div>
        <div className="flex gap-2 mt-4">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="px-2 py-0.5 bg-black text-white rounded"
          >
            Reload
          </button>
        </div>
        <div className="mt-4">
          <ClientSessionList />
        </div>
      </div>
    )
  }

  // Show version mismatch overlay
  if (versionMismatch?._tag === 'mismatch') {
    return <VersionMismatchOverlay versionMismatch={versionMismatch} />
  }

  // Show loading state while store is booting
  if (devtoolsStore === undefined) {
    return <div id="loading">{bootStatusToString(bootStatus)}</div>
  }

  return (
    <SessionContext.Provider value={session}>
      <DevtoolsStoreContext.Provider value={devtoolsStore}>
        <ListenToMutations />
        {status === 'disconnected' && <DisconnectedOverlay session={session} />}
        <AllTabs />
      </DevtoolsStoreContext.Provider>
    </SessionContext.Provider>
  )
}

export const Route = createFileRoute('/$mode/$storeId/$clientId/$sessionId/$schemaAlias')({
  params: {
    parse: (params) =>
      Schema.decodeUnknownSync(
        Schema.Struct({
          mode: Schema.Union([Devtools.DevtoolsModeTag, Schema.Literal('mock')]),
          storeId: Schema.String,
          clientId: Schema.String,
          sessionId: Schema.String,
          schemaAlias: Schema.String,
        }),
      )(params),
  },
  component: RouteComponent,
  head: (ctx) => ({
    meta: [
      {
        title: `LiveStore Devtools (${ctx.params.storeId}-${ctx.params.clientId}-${ctx.params.sessionId})`,
      },
    ],
  }),
})

const ListenToMutations: React.FC = () => {
  const { options } = useRootContext()
  const { appSchema, apiSession } = useSessionContext()
  const store = useDevtoolsStore()

  React.useEffect(
    () =>
      backgroundWork({ apiSession, options, store: store as LiveStore.Store, appSchema }).pipe(
        Effect.scoped,
        Effect.runCallback,
      ),
    [store, apiSession, appSchema, options],
  )

  return null
}

const bootStatusToString = (bootStatus: BootStatus) => {
  switch (bootStatus.stage) {
    case 'loading': {
      return 'Loading LiveStore...'
    }
    case 'migrating': {
      return `Migrating tables (${bootStatus.progress.done}/${bootStatus.progress.total})`
    }
    case 'rehydrating': {
      return `Rehydrating state (${bootStatus.progress.done}/${bootStatus.progress.total})`
    }
    case 'syncing': {
      return `Syncing state (${bootStatus.progress.done}/${bootStatus.progress.total})`
    }
    case 'done': {
      return 'LiveStore ready'
    }
    case 'warning': {
      return `Warning: ${bootStatus.message}`
    }
  }
}

const DisconnectedOverlay: React.FC<{ session: SessionContext }> = ({ session }) => {
  const { storeId, clientId, sessionId, schemaAlias } = session.apiSession.clientInfo

  return (
    <div className="absolute inset-0 bg-red-500/80 flex flex-col items-center justify-center z-[9999] space-y-2">
      <div className="text-black">
        Connection to app lost ({storeId}-{clientId}-{sessionId}-{schemaAlias})
      </div>
      <ClientSessionList />
      <ButtonSm className="text-neutral-300" onClick={() => window.location.reload()}>
        Reload
      </ButtonSm>
    </div>
  )
}
