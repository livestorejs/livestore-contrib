import { Devtools } from '@livestore/common'
// biome-ignore lint/correctness/noUnusedImports: needed for typescript: `cannot be named without a reference to '../../node_modules/@livestore/utils/src/effect/Subscribable.ts'. This is likely not portable. A type annotation is necessary.`
import { Subscribable as __Subscribable, Effect, FetchHttpClient } from '@livestore/utils/effect'
import * as Webmesh from '@livestore/webmesh'

import type { DevtoolsBridge } from './devtools-bridge.js'

export const makeNodeDevtoolsBridge = ({ url }: { url: string }) =>
  Effect.gen(function* () {
    const meshNode = yield* Webmesh.makeMeshNode(Devtools.makeNodeName.devtools.random())
    globalThis.__debugWebmeshNode = meshNode

    yield* Webmesh.connectViaWebSocket({ node: meshNode, url, openTimeout: 500 }).pipe(
      Effect.forkScoped,
    )

    const sessionInfoChannel = yield* Devtools.makeSessionInfoBroadcastChannel(meshNode, {
      origin: undefined,
    })
    const clientSessions = yield* Devtools.SessionInfo.requestSessionInfoSubscription({
      webChannel: sessionInfoChannel,
    })

    const connect: DevtoolsBridge['connect'] = () => Effect.void

    return {
      connect,
      clientSessions,
      meshNode,
      meshChannelMode: 'proxy',
    } satisfies DevtoolsBridge
  }).pipe(Effect.provide(FetchHttpClient.layer))
