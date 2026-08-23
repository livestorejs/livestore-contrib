import { useEffect, useState, useSyncExternalStore } from 'react'

import type { PresenceClient } from '@livestore/sync-cf/presence'
import { makePresenceClient } from '@livestore/sync-cf/presence/client'
import type { PresenceSnapshot } from '@livestore/sync-cf/presence'
import { Effect, Fiber, Stream, SubscriptionRef } from '@livestore/utils/effect'

const emptySnapshot: PresenceSnapshot = { storeId: '', clients: [] }

const emptySnapshotRef = Effect.runSync(SubscriptionRef.make<PresenceSnapshot>(emptySnapshot))

/** Subscribes to the presence room snapshot, re-rendering on every change. */
export const usePresence = (client: PresenceClient): PresenceSnapshot =>
  useSyncExternalStore(
    (onChange) => {
      const ref = client.snapshot ?? emptySnapshotRef
      const fiber = Effect.runFork(
        SubscriptionRef.changes(ref).pipe(
          Stream.runForEach(() => Effect.sync(onChange)),
        ),
      )
      return () => {
        Effect.runFork(Fiber.interrupt(fiber))
      }
    },
    () => (client.snapshot ?? emptySnapshotRef).value,
    () => emptySnapshot,
  )

/** Presence states of all peers (excludes the local client). */
export const usePresencePeers = (client: PresenceClient) =>
  usePresence(client).clients.filter((c) => c.clientId !== client.clientId)

/**
 * Number of clients in the room. The room prunes silent peers by TTL, so this
 * tracks live connections.
 */
export const useOnlineCount = (client: PresenceClient) =>
  usePresence(client).clients.filter((c) => c.online === true).length

/** Live cursor positions of all *peers* (your own mouse is already visible). */
export const usePresenceCursors = (client: PresenceClient) =>
  usePresence(client).clients.flatMap((c) =>
    c.clientId !== client.clientId && c.cursor !== undefined
      ? [{ clientId: c.clientId, name: c.name, cursor: c.cursor }]
      : [],
  )

/** Users currently typing (excluding the local client). */
export const useTypingUsers = (client: PresenceClient) =>
  usePresence(client).clients.filter((c) => c.clientId !== client.clientId && c.typing === true)

/** Peers currently dragging a card (PartyKit-style live drag). */
export const usePresenceDragging = (client: PresenceClient) =>
  usePresence(client).clients.flatMap((c) =>
    c.dragging !== undefined ? [{ clientId: c.clientId, name: c.name, dragging: c.dragging }] : [],
  )

/**
 * Hook returning a presence client attached to the sync party, scoped to the
 * component lifecycle.
 *
 * The client's socket + Snapshots stream live in a `Scope` kept open by a
 * never-completing fiber; interrupting that fiber on unmount disconnects.
 */
export const usePresenceWsClient = (options: Parameters<typeof makePresenceClient>[0]): PresenceClient => {
  const [client, setClient] = useState<PresenceClient | undefined>(undefined)
  useEffect(() => {
    const fiber = Effect.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          const c = yield* makePresenceClient(options)
          yield* Effect.sync(() => setClient(c))
          yield* Effect.never
        }),
      ),
    )
    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [options])
  return client ?? emptyClient
}

const emptyClient = {
  storeId: '',
  clientId: '',
  snapshot: emptySnapshotRef,
  snapshots: Stream.empty,
  setState: () => Effect.void,
  setCursor: () => Effect.void,
  setTyping: () => Effect.void,
  setTextCursor: () => Effect.void,
  setName: () => Effect.void,
  setDragging: () => Effect.void,
  leave: Effect.void,
} as unknown as PresenceClient