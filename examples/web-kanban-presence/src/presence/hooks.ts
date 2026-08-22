import { useEffect, useState, useSyncExternalStore } from 'react'

import { Effect, Fiber, Stream, SubscriptionRef } from '@livestore/utils/effect'

import type { PresenceClient } from './client.ts'
import { makePresenceClient } from './client.ts'
import type { PresenceSnapshot } from './schema.ts'

const emptySnapshot: PresenceSnapshot = { storeId: '', clients: [] }

/** Subscribes to the presence room snapshot, re-rendering on every change. */
export const usePresence = (client: PresenceClient): PresenceSnapshot =>
  useSyncExternalStore(
    (onChange) => {
      const fiber = Effect.runFork(
        SubscriptionRef.changes(client.snapshot).pipe(
          Stream.runForEach(() => Effect.sync(onChange)),
        ),
      )
      return () => Effect.runFork(Fiber.interrupt(fiber))
    },
    () => client.snapshot.value,
    () => emptySnapshot,
  )

/** Presence states of all peers (excludes the local client). */
export const usePresencePeers = (client: PresenceClient) =>
  usePresence(client).clients.filter((c) => c.clientId !== client.clientId)

/** Number of online users in the room (including the local client). */
export const useOnlineCount = (client: PresenceClient) =>
  usePresence(client).clients.filter((c) => c.online === true).length

/** Live cursor positions of all peers. */
export const usePresenceCursors = (client: PresenceClient) =>
  usePresence(client).clients.flatMap((c) =>
    c.cursor !== undefined ? [{ clientId: c.clientId, name: c.name, cursor: c.cursor }] : [],
  )

/** Users currently typing (excluding the local client). */
export const useTypingUsers = (client: PresenceClient) =>
  usePresence(client).clients.filter((c) => c.clientId !== client.clientId && c.typing === true)

/**
 * Hook returning a PresenceClient scoped to the component lifecycle.
 * Connects lazily on first render and disconnects on unmount.
 */
export const usePresenceClient = (options: Parameters<typeof makePresenceClient>[0]): PresenceClient => {
  const [client] = useState(() => Effect.runSync(makePresenceClient(options)))
  useEffect(() => {
    return () => {
      Effect.runFork(client.leave)
    }
  }, [client])
  return client
}