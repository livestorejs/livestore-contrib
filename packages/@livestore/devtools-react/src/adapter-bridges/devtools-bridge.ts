import type { Devtools, UnknownError } from '@livestore/common'
import type { Effect, HashSet, Scope, Subscribable } from '@livestore/utils/effect'
import type * as Webmesh from '@livestore/webmesh'

export type DevtoolsBridge = {
  connect: (
    clientInfo: Devtools.SessionInfo.SessionInfo,
  ) => Effect.Effect<void, UnknownError, Scope.Scope>
  clientSessions: Subscribable.Subscribable<HashSet.HashSet<Devtools.SessionInfo.SessionInfo>>
  meshNode: Webmesh.MeshNode
  meshChannelMode: 'direct' | 'proxy'
  copyToClipboard?: (text: string) => Effect.Effect<void>
  sendEscapeKey?: Effect.Effect<void>
}
