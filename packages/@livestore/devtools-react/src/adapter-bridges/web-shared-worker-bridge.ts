import { type WebAdapterOptions, WorkerSchema } from '@livestore/adapter-web'
import * as DevtoolsWeb from '@livestore/adapter-web/devtools-web-channel'
import { Devtools } from '@livestore/common'
import { tryAsFunctionAndNew } from '@livestore/utils'
import type { Scope } from '@livestore/utils/effect'
import { Effect, HashSet, Layer, RpcClient, Stream, Subscribable } from '@livestore/utils/effect'
import { BrowserWorker } from '@livestore/utils/effect/browser'
import * as Webmesh from '@livestore/webmesh'
import * as WebmeshWorker from '@livestore/webmesh/worker'

import type { DevtoolsBridge } from './devtools-bridge.js'

export const makeWebDevtoolsBridge = ({
  sharedWorker: SharedWorker_,
}: {
  sharedWorker: WebAdapterOptions['sharedWorker']
}): Effect.Effect<DevtoolsBridge, never, Scope.Scope> =>
  Effect.gen(function* () {
    const meshNode = yield* Webmesh.makeMeshNode(Devtools.makeNodeName.devtools.random())
    globalThis.__debugWebmeshNode = meshNode

    // Dual-source discovery (why both):
    // - Mesh alone isn’t enough: the SharedWorker is store-scoped and not connected on the
    //   session-list view yet, so there’s no edge and mesh discovery hears nothing.
    // - BroadcastChannel alone isn’t enough: it’s origin-scoped and doesn’t work cross-origin
    //   (e.g. browser extension path). We still prefer mesh once connected.
    // We subscribe to both: BC enables early discovery; mesh provides results once connected.
    const meshSessionsChannel = yield* Devtools.makeSessionInfoBroadcastChannel(meshNode, {
      origin: window.location.origin,
    })
    const bcSessionsChannel = yield* DevtoolsWeb.makeSessionInfoBroadcastChannel

    const meshSessions = yield* Devtools.SessionInfo.requestSessionInfoSubscription({
      webChannel: meshSessionsChannel,
    })
    const bcSessions = yield* Devtools.SessionInfo.requestSessionInfoSubscription({
      webChannel: bcSessionsChannel,
    })

    const clientSessions: DevtoolsBridge['clientSessions'] = Subscribable.make({
      get: Effect.all({ a: meshSessions.get, b: bcSessions.get }).pipe(
        Effect.map(({ a, b }) => HashSet.union(a, b)),
      ),
      changes: Stream.zipLatestWith(meshSessions.changes, bcSessions.changes, (a, b) =>
        HashSet.union(a, b),
      ),
    })

    const connect: DevtoolsBridge['connect'] = ({ storeId }) =>
      Effect.gen(function* () {
        const sharedWebWorker = tryAsFunctionAndNew(SharedWorker_, {
          name: `livestore-shared-worker-${storeId}`,
        })
        const sharedWorkerClient = yield* RpcClient.make(WorkerSchema.SharedWorkerRpcs).pipe(
          Effect.provide(
            RpcClient.layerProtocolWorker({ size: 1, concurrency: 100 }).pipe(
              Layer.provide(BrowserWorker.layer(() => sharedWebWorker)),
            ),
          ),
          Effect.tapCauseLogPretty,
          Effect.withSpan('@livestore/devtools-react:makeApi:setupSharedWorker'),
          Effect.orDie,
        )

        const sharedWorker = {
          execute: (request: typeof WebmeshWorker.Schema.Request.Type) =>
            sharedWorkerClient['WebmeshWorker.CreateConnection'](request).pipe(Stream.orDie),
        }

        yield* WebmeshWorker.connectViaWorker({
          node: meshNode,
          target: `shared-worker-${storeId}`,
          worker: sharedWorker,
        })
      })

    return {
      connect,
      clientSessions,
      meshNode,
      meshChannelMode: 'direct',
    } satisfies DevtoolsBridge
  }).pipe(Effect.orDie)
