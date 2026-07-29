import { getEventDef } from '@livestore/common/schema'
import type * as LiveStore from '@livestore/livestore'
import { memoizeByRef } from '@livestore/utils'
import { Effect, Stream } from '@livestore/utils/effect'

import type { DevtoolsApiSession } from '../devtools-api.js'
import { networkState } from '../livestore/tables.js'
import type { DevtoolsOptions } from '../types.js'

export const backgroundWork = ({
  apiSession,
  options,
  store,
  appSchema,
}: {
  apiSession: DevtoolsApiSession
  options: DevtoolsOptions | undefined
  store: LiveStore.Store
  appSchema: LiveStore.LiveStoreSchema
}) =>
  Effect.gen(function* () {
    const beforeUnload = () => {
      apiSession.disconnected.pipe(Effect.runFork)
    }

    window.addEventListener('beforeunload', beforeUnload)

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        window.removeEventListener('beforeunload', beforeUnload)
      }),
    )

    yield* apiSession.networkStatus.pipe(
      Stream.tapSync((networkStatus) => {
        store.commit(
          networkState.set(
            {
              status: networkStatus,
            },
            // TODO seems like there are some unique constraints on the id field
            // maybe if the timestamp overlaps or some concurrency issues?
            // https://share.cleanshot.com/Qm4DSRV0
            networkStatus.timestampMs.toString(),
          ),
        )
      }),
      Stream.runDrain,
      Effect.tapCauseLogPretty,
      Effect.forkScoped,
    )

    yield* apiSession.syncPull.pipe(
      Stream.tapSync(({ payload }) => {
        if (payload._tag === 'upstream-rebase') {
          // TODO implement rebases in devtools
          return
        }
        for (const eventEncoded of payload.newEvents) {
          window.tmpLiveStoreMutationCount += 1
          if (options?.sound !== false && options?.sound?.mutations) {
            const eventDef = getEventDef(appSchema, eventEncoded.name)
            if (eventDef.eventDef.options.clientOnly) {
              playBlob()
            } else {
              playBlib()
            }
          }
        }
      }),
      Stream.runDrain,
      Effect.tapCauseLogPretty,
      Effect.forkScoped,
    )

    return yield* Effect.never
  })

// Call the function to play the sound
const makeAudioCtx = memoizeByRef(() => {
  const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)()
  const gainNode = audioCtx.createGain()

  return { audioCtx, gainNode }
})

const makeOscillator = (freq: number) => {
  const { audioCtx, gainNode } = makeAudioCtx()
  const oscillator = audioCtx.createOscillator()

  oscillator.type = 'sine'
  oscillator.frequency.setValueAtTime(freq, audioCtx.currentTime) // Frequency in Hz
  gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime) // Volume

  oscillator.connect(gainNode)
  gainNode.connect(audioCtx.destination)

  return { oscillator, audioCtx }
}

const playBlib = (): void => {
  const { oscillator, audioCtx } = makeOscillator(1000)
  oscillator.start()
  oscillator.stop(audioCtx.currentTime + 0.1) // Duration in seconds
}

const playBlob = (): void => {
  const { oscillator, audioCtx } = makeOscillator(700)
  oscillator.start()
  oscillator.stop(audioCtx.currentTime + 0.1) // Duration in seconds
}
