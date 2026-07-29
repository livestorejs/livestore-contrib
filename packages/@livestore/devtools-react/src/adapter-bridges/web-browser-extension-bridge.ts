import { Devtools } from '@livestore/common'
import { ChromeExtension, CopyToClipboard } from '@livestore/devtools-common'
import { shouldNeverHappen } from '@livestore/utils'
// biome-ignore lint/correctness/noUnusedImports: needed for typescript: `cannot be named without a reference to '../../node_modules/@livestore/utils/src/effect/Subscribable.ts'. This is likely not portable. A type annotation is necessary.`
import { Subscribable as __Subscribable, Effect, Schema } from '@livestore/utils/effect'
import { WebChannelBrowser } from '@livestore/utils/effect/browser'
import * as Webmesh from '@livestore/webmesh'

import type { DevtoolsBridge } from './devtools-bridge.js'

// NOTE this code is running inside the devtools iframe, so will be re-running from scratch if the iframe is reloaded
// TODO make sure this also works reliably for HMR
export const makeWebBrowserExtensionDevtoolsBridge = Effect.gen(function* () {
  // TODO ensure this code is running in a browser extension context

  const tabId = getTabId()

  const meshNode = yield* Webmesh.makeMeshNode(ChromeExtension.makeNodeName.devtools({ tabId }))
  globalThis.__debugWebmeshNode = meshNode

  const iframeWindow = window
  const iframeWindowChannel = yield* WebChannelBrowser.windowChannel({
    listenWindow: iframeWindow,
    sendWindow: iframeWindow.parent,
    schema: Webmesh.WebmeshSchema.Packet,
    ids: { own: 'devtools', other: 'devtools-panel' },
  })

  yield* meshNode
    .addEdge({
      edgeChannel: iframeWindowChannel,
      target: ChromeExtension.makeNodeName.panel({ tabId }),
    })
    .pipe(Effect.orDie)

  const backgroundChannel = yield* meshNode.makeChannel({
    target: ChromeExtension.makeNodeName.extensionWorker(),
    channelName: ChromeExtension.makeChannelName.clipboard({ tabId }),
    schema: { send: CopyToClipboard, listen: Schema.Void },
    mode: 'direct',
  })

  // Important: Do not rely on BroadcastChannel for the DevTools browser extension session discovery.
  // BroadcastChannel is origin-scoped, while the extension environment may span multiple app origins.
  // Subscribe on the mesh SessionInfo channel and filter by `origin` carried in messages.
  const sessionInfoChannel = yield* Devtools.makeSessionInfoBroadcastChannel(meshNode, {
    origin: window.location.origin,
  })

  const clientSessions = yield* Devtools.SessionInfo.requestSessionInfoSubscription({
    webChannel: sessionInfoChannel,
  })

  const connect: DevtoolsBridge['connect'] = () => Effect.void

  // Write directly to clipboard in the panel context for reliability (Electron),
  // and also attempt to notify background (Chrome offscreen doc path).
  const copyToClipboard = (text: string) =>
    Effect.all([
      Effect.sync(() => {
        void navigator.clipboard.writeText(text)
      }).pipe(Effect.ignore({ log: true })),
      backgroundChannel.send(CopyToClipboard.make({ text })).pipe(Effect.ignore({ log: true })),
    ])

  return {
    connect,
    clientSessions,
    meshNode: meshNode,
    meshChannelMode: 'direct',
    copyToClipboard,
  } satisfies DevtoolsBridge
})

const getTabId = () => {
  const tabId = sessionStorage.getItem('livestore-devtools-tab-id')
  if (tabId === null) {
    return shouldNeverHappen(`No tabId found in sessionStorage`)
  }
  return Number(tabId)
}
