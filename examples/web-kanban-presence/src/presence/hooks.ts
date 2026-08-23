import { useEffect, useState, useSyncExternalStore } from 'react'

import type { PresenceClient } from '@livestore/sync-cf/presence'
import { makePresenceClient } from '@livestore/sync-cf/presence/client'
import { makePresenceWsClient } from '@livestore/sync-cf/presence/ws-client'
import { Effect, Fiber, Stream, SubscriptionRef } from '@livestore/utils/effect'

import type { PresenceSnapshot } from '@livestore/sync-cf/presence'

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
      return () => Effect.runFork(Fiber.interrupt(fiber))
    },
    () => (client.snapshot ?? emptySnapshotRef).value,
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

/** Peers currently dragging a card, keyed by clientId (PartyKit-style live drag). */
export const usePresenceDragging = (client: PresenceClient) =>
  usePresence(client).clients.flatMap((c) =>
    c.dragging !== undefined
      ? [{ clientId: c.clientId, name: c.name, dragging: c.dragging }]
      : [],
  )

/**
 * Hook returning a presence client backed by the Cloudflare presence DO,
 * scoped to the component lifecycle. Disconnects on unmount.
 */
export const usePresenceWsClient = (options: Parameters<typeof makePresenceWsClient>[0]): PresenceClient => {
  const [client, setClient] = useState<PresenceClient | undefined>(undefined)
  useEffect(() => {
    const fiber = Effect.runFork(
      makePresenceWsClient(options).pipe(
        Effect.tap((c) => Effect.sync(() => setClient(c))),
        Effect.scoped,
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
  setDragging: () => Effect.void,
  leave: Effect.void,
} as unknown as PresenceClient

/**
 * Hook returning a plain WebSocket presence client, scoped to the component
 * lifecycle (used for local dev against the Node presence server).
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