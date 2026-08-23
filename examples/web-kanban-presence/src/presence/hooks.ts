import { useEffect, useState, useSyncExternalStore } from 'react'

import type { PresenceClient } from '@livestore/sync-cf/presence'
import { makePresenceClient } from '@livestore/sync-cf/presence/client'
import type { PresenceSnapshot } from '@livestore/sync-cf/presence'
import { Effect, Fiber, Stream } from '@livestore/utils/effect'

import type { presenceSchemas } from '../livestore/presence-schemas.ts'

type Client = PresenceClient<typeof presenceSchemas>
const CURSOR_CHANNEL = 'cursor' as keyof typeof presenceSchemas & string

const emptySnapshot: PresenceSnapshot = { storeId: '', channel: '', members: [] }

/** Subscribes to the cursor channel's room snapshot. */
export const usePresenceSnapshot = (client: Client): PresenceSnapshot =>
  useSyncExternalStore(
    (onChange) => {
      const fiber = Effect.runFork(
        client.snapshots(CURSOR_CHANNEL).pipe(
          Stream.runForEach(() => Effect.sync(onChange)),
        ),
      )
      return () => {
        Effect.runFork(Fiber.interrupt(fiber))
      }
    },
    // Synchronous read of the client's own snapshot ref.
    () => client.snapshotRef(CURSOR_CHANNEL).value,
    () => emptySnapshot,
  )

/**
 * Hook returning a presence client attached to the sync party, scoped to the
 * component lifecycle. Interrupting the holder fiber on unmount disconnects.
 */
export const usePresenceClient = (
  options: Parameters<typeof makePresenceClient>[0],
): Client => {
  const [client, setClient] = useState<Client | undefined>(undefined)
  useEffect(() => {
    let active = true
    const fiber = Effect.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          const c = yield* makePresenceClient(options)
          if (active === false) return
          yield* Effect.sync(() => setClient(c))
          yield* Effect.never
        }),
      ),
    )
    return () => {
      active = false
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [options])
  return client ?? emptyClient
}

const emptyClient: Client = {
  storeId: '',
  clientId: '',
  snapshots: (() => Stream.empty) as any,
  snapshotRef: (() => ({ value: emptySnapshot })) as any,
  setState: (() => Effect.void) as any,
  leave: Effect.void,
}