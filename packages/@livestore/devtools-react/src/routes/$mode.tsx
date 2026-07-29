import { Devtools } from '@livestore/common'
import { Effect, Logger, References, Schema } from '@livestore/utils/effect'
import { createFileRoute, Outlet } from '@tanstack/react-router'
import * as React from 'react'
import { ErrorBoundary } from 'react-error-boundary'

import { ApiContext } from '../api-context.js'
import { ErrorFallback } from '../components/ErrorFallback.js'
import { makeApi } from '../devtools-api.js'
import { useRootContext } from '../root-context.js'

const RouteComponent: React.FC = () => {
  const { mode: selectedModeTag } = Route.useParams()

  const [apiContext, setApiContext] = React.useState<ApiContext | undefined>(undefined)
  const rootContext = useRootContext()
  const search = Route.useSearch()

  if (search.tabId !== undefined) {
    sessionStorage.setItem('livestore-devtools-tab-id', search.tabId.toString())
  }

  React.useEffect(
    () =>
      Effect.gen(function* () {
        const { sharedWorker, triggerReload } = rootContext

        if (rootContext.mode !== undefined && rootContext.mode._tag !== selectedModeTag) {
          throw new Error(`Expected mode ${rootContext.mode._tag} but got ${selectedModeTag}`)
        }

        const mode = rootContext.mode ?? ({ _tag: selectedModeTag } as Devtools.DevtoolsMode)

        const api = yield* makeApi({ sharedWorker, mode, triggerReload })

        setApiContext({ api, selectedModeTag })

        return yield* Effect.never
      }).pipe(
        Effect.scoped,
        Effect.tapCauseLogPretty,
        Effect.annotateLogs({ thread: 'window(devtools)' }),
        Effect.provide(Logger.layer([Logger.consolePretty()])),
        Effect.provideService(References.MinimumLogLevel, 'Debug'),
        Effect.runCallback,
      ),
    [rootContext, selectedModeTag],
  )

  if (apiContext === undefined) {
    return <div id="loading">Loading Devtools via {selectedModeTag}...</div>
  }

  return (
    <ApiContext.Provider value={apiContext}>
      <ErrorBoundary FallbackComponent={ErrorFallback}>
        <Outlet />
      </ErrorBoundary>
    </ApiContext.Provider>
  )
}

export const Route = createFileRoute('/$mode')({
  params: {
    parse: (params) => ({
      mode: Schema.decodeUnknownSync(
        Schema.Union([Devtools.DevtoolsModeTag, Schema.Literal('mock')]),
      )(params.mode),
    }),
  },
  validateSearch: Schema.toStandardSchemaV1(
    Schema.Struct({
      // Only needed for browser-extension bridge
      tabId: Schema.optional(Schema.Finite),
    }),
  ),
  component: () => <RouteComponent />,
})
