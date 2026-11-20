import { ShutdownChannel } from '@livestore/common/leader-thread'
import type { Effect, Scope } from '@livestore/utils/effect'
import { WebChannel } from '@livestore/utils/effect'

// Once we'll implement multi-threading for the Expo adapter, we'll need to implement a multi-threaded version of this
export const makeShutdownChannel = (
  storeId: string,
): Effect.Effect<
  WebChannel.WebChannel<typeof ShutdownChannel.All.Type, typeof ShutdownChannel.All.Type>,
  never,
  Scope.Scope
> =>
  WebChannel.sameThreadChannel({
    channelName: `livestore.shutdown.${storeId}`,
    schema: ShutdownChannel.All,
  })
