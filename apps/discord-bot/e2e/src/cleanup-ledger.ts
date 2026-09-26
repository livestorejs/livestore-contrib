import { closeSync, fchmodSync, openSync, readFileSync, writeSync } from 'node:fs'

import type { Snowflake } from './model.ts'
import type { E2ETransport } from './transport.ts'

export type CleanupEntryKind = 'message' | 'thread' | 'response'
export type CleanupEntryStatus = 'open' | 'resolved'

/**
 * Identity of one Discord artifact owned by a run. `messageId` carries the
 * artifact's own id (the thread id for thread entries, the response id for
 * response entries) so recovery can act on exact ids without content matching.
 */
export interface CleanupLedgerIdentity {
  readonly runId: string
  readonly scenario: string | undefined
  readonly kind: CleanupEntryKind
  readonly guildId: Snowflake
  readonly channelId: Snowflake
  readonly messageId: Snowflake
}

export interface CleanupLedgerEntry extends CleanupLedgerIdentity {
  readonly _tag: 'artifact'
  readonly schemaVersion: 1
  readonly status: CleanupEntryStatus
}

export interface CleanupMessageIntent {
  readonly _tag: 'intent'
  readonly schemaVersion: 2
  readonly status: CleanupEntryStatus
  readonly runId: string
  readonly kind: 'message-intent'
  readonly guildId: Snowflake
  readonly channelId: Snowflake
  readonly marker: string
}

export type RecoverableEntry = CleanupLedgerEntry | CleanupMessageIntent
export type MessageIntentInput = Pick<CleanupMessageIntent, 'runId' | 'guildId' | 'channelId' | 'marker'>

/**
 * Crash-resumable per-run ledger. A create-message intent precedes the send;
 * once correlated, its exact artifact identity is recorded before the intent
 * closes. Exact identities resolve only after deletion succeeds.
 */
export interface CleanupLedgerWriter {
  /** Appends an open-status line; writeSync makes it visible to any subsequent process before returning. */
  readonly record: (identity: CleanupLedgerIdentity) => void
  /** Persist correlation scope before the official-client gesture can send a message. */
  readonly recordMessageIntent: (input: MessageIntentInput) => void
  readonly resolveMessageIntent: (input: MessageIntentInput) => void
  /** Appends a resolved-status line after successful deletion. */
  readonly resolve: (identity: CleanupLedgerIdentity) => void
  readonly close: () => void
}

export interface UnresolvedEntries {
  readonly unresolved: ReadonlyArray<RecoverableEntry>
  readonly warnings: ReadonlyArray<string>
}

export type RecoveryOutcome =
  | { readonly entry: RecoverableEntry; readonly outcome: 'deleted' }
  | { readonly entry: RecoverableEntry; readonly outcome: 'already-gone' }
  | { readonly entry: RecoverableEntry; readonly outcome: 'failed'; readonly error: unknown }

/** Transport-level signal that an exact Discord artifact vanished between validation and deletion. */
export class CleanupArtifactNotFoundError extends Error {
  override readonly name = 'CleanupArtifactNotFoundError'
}

const kinds: Record<string, true> = { message: true, thread: true, response: true }

const entryOf = (identity: CleanupLedgerIdentity, status: CleanupEntryStatus): CleanupLedgerEntry => ({
  _tag: 'artifact',
  schemaVersion: 1,
  runId: identity.runId,
  scenario: identity.scenario,
  kind: identity.kind,
  guildId: identity.guildId,
  channelId: identity.channelId,
  messageId: identity.messageId,
  status,
})

const entryKey = (entry: RecoverableEntry): string =>
  entry._tag === 'intent'
    ? [entry.runId, entry.kind, entry.guildId, entry.channelId, entry.marker].join('\u0000')
    : [entry.runId, entry.kind, entry.guildId, entry.channelId, entry.messageId].join('\u0000')

/** Owner-only access regardless of umask or looser pre-existing bits. */
const appendFd = (filePath: string): number => {
  const fd = openSync(filePath, 'a', 0o600)
  fchmodSync(fd, 0o600)
  return fd
}

const appendLine = (fd: number, entry: RecoverableEntry): void => {
  writeSync(fd, `${JSON.stringify(entry)}\n`)
}

const isSnowflakeString = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{17,20}$/u.test(value) === true

const decodeSnowflake = (value: unknown): Snowflake | undefined =>
  isSnowflakeString(value) === true ? (value as Snowflake) : undefined

const decodeEntry = (value: unknown): RecoverableEntry | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value) === true) return undefined
  const decoded = value as Record<string, unknown>
  if (
    decoded.schemaVersion === 2 &&
    decoded.kind === 'message-intent' &&
    (decoded.status === 'open' || decoded.status === 'resolved') &&
    typeof decoded.runId === 'string' &&
    decodeSnowflake(decoded.guildId) !== undefined &&
    decodeSnowflake(decoded.channelId) !== undefined &&
    typeof decoded.marker === 'string' &&
    decoded.marker.length > 0
  ) {
    return {
      _tag: 'intent',
      schemaVersion: 2,
      status: decoded.status,
      runId: decoded.runId,
      kind: 'message-intent',
      guildId: decoded.guildId as Snowflake,
      channelId: decoded.channelId as Snowflake,
      marker: decoded.marker,
    }
  }
  if (decoded.schemaVersion !== 1) return undefined
  if (decoded.status !== 'open' && decoded.status !== 'resolved') return undefined
  if (typeof decoded.runId !== 'string') return undefined
  if (decoded.scenario !== undefined && typeof decoded.scenario !== 'string') return undefined
  if (typeof decoded.kind !== 'string' || kinds[decoded.kind] !== true) return undefined
  const guildId = decodeSnowflake(decoded.guildId)
  const channelId = decodeSnowflake(decoded.channelId)
  const messageId = decodeSnowflake(decoded.messageId)
  if (guildId === undefined || channelId === undefined || messageId === undefined) return undefined
  return {
    _tag: 'artifact',
    schemaVersion: 1,
    runId: decoded.runId,
    scenario: decoded.scenario,
    kind: decoded.kind as CleanupEntryKind,
    guildId,
    channelId,
    messageId,
    status: decoded.status,
  }
}

/**
 * Ledger files live in a per-run workspace, so scoping writes to the opening
 * run keeps a stray caller from polluting another run's recovery set.
 */
export const openCleanupLedger = (input: { filePath: string; runId: string }): CleanupLedgerWriter => {
  const fd = appendFd(input.filePath)
  const assertRun = (identity: { readonly runId: string }): void => {
    if (identity.runId !== input.runId) {
      throw new Error(`Cleanup ledger ${input.filePath} is scoped to run ${input.runId}`)
    }
  }
  return {
    record: (identity) => {
      assertRun(identity)
      appendLine(fd, entryOf(identity, 'open'))
    },
    resolve: (identity) => {
      assertRun(identity)
      appendLine(fd, entryOf(identity, 'resolved'))
    },
    recordMessageIntent: (intent) => {
      assertRun(intent)
      appendLine(fd, { ...intent, _tag: 'intent', schemaVersion: 2, kind: 'message-intent', status: 'open' })
    },
    resolveMessageIntent: (intent) => {
      assertRun(intent)
      appendLine(fd, { ...intent, _tag: 'intent', schemaVersion: 2, kind: 'message-intent', status: 'resolved' })
    },
    close: () => closeSync(fd),
  }
}

/**
 * A missing file means nothing was ever recorded; malformed lines are skipped
 * with a warning rather than poisoning recovery of the well-formed entries.
 */
export const readUnresolvedEntries = (filePath: string): UnresolvedEntries => {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { unresolved: [], warnings: [] }
    throw error
  }
  const warnings: string[] = []
  const resolvedKeys = new Set<string>()
  const openEntries: RecoverableEntry[] = []
  for (const [index, line] of raw.split('\n').entries()) {
    if (line.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      warnings.push(`line ${index + 1}: invalid JSON`)
      continue
    }
    const entry = decodeEntry(parsed)
    if (entry === undefined) {
      warnings.push(`line ${index + 1}: unknown cleanup-ledger entry shape`)
      continue
    }
    if (entry.status === 'resolved') resolvedKeys.add(entryKey(entry))
    else openEntries.push(entry)
  }
  // Matching is order-independent so a torn crash between resolve-append and fs flush still resolves.
  return { unresolved: openEntries.filter((entry) => resolvedKeys.has(entryKey(entry)) === false), warnings }
}

const validatedAlive = async (transport: E2ETransport, entry: CleanupLedgerEntry): Promise<boolean> => {
  switch (entry.kind) {
    case 'thread': {
      const thread = await transport.findThreadForMessage(entry.guildId, entry.messageId)
      if (thread === undefined) return false
      if (
        thread.id !== entry.messageId ||
        thread.sourceMessageId !== entry.messageId ||
        thread.guildId !== entry.guildId ||
        thread.parentChannelId !== entry.channelId
      ) {
        throw new Error(`Cleanup ledger thread ${entry.messageId} did not match its recorded guild and parent`)
      }
      return true
    }
    case 'message':
    case 'response': {
      const channel = await transport.inspectChannel(entry.channelId)
      if (channel.id !== entry.channelId || channel.guildId !== entry.guildId) {
        throw new Error(`Cleanup ledger ${entry.kind} ${entry.messageId} did not match its recorded channel and guild`)
      }
      return true
    }
  }
}

const deleteArtifact = (transport: E2ETransport, entry: CleanupLedgerEntry): Promise<void> => {
  switch (entry.kind) {
    case 'message':
      return transport.deleteMessage(entry.channelId, entry.messageId)
    case 'thread':
      return transport.deleteThread(entry.messageId)
    case 'response':
      return transport.deleteResponse(entry.channelId, entry.messageId)
  }
}

/**
 * Replays exact artifact identities and pre-send intents. An intent is first
 * resolved to a unique human-authored message in its validated channel; the
 * exact ID is recorded before the intent closes or any deletion is attempted.
 */
export const recoverCleanupLedger = async (input: {
  filePath: string
  transport: E2ETransport
  findMessageByMarker?: (channelId: Snowflake, marker: string) => Promise<Snowflake | undefined>
}): Promise<ReadonlyArray<RecoveryOutcome>> => {
  const { unresolved } = readUnresolvedEntries(input.filePath)
  const outcomes: RecoveryOutcome[] = []
  if (unresolved.length === 0) return outcomes
  const fd = appendFd(input.filePath)
  try {
    for (const entry of unresolved) {
      try {
        if (entry._tag === 'intent') {
          if (input.findMessageByMarker === undefined) throw new Error('Marker recovery is unavailable')
          const channel = await input.transport.inspectChannel(entry.channelId)
          if (channel.id !== entry.channelId || channel.guildId !== entry.guildId)
            throw new Error('Cleanup intent channel did not match its recorded guild')
          const messageId = await input.findMessageByMarker(entry.channelId, entry.marker)
          if (messageId === undefined) throw new Error('Marked message not found; intent remains open for retry')
          const exact = entryOf({ ...entry, scenario: undefined, kind: 'message', messageId }, 'open')
          appendLine(fd, exact)
          appendLine(fd, { ...entry, status: 'resolved' })
          try {
            await input.transport.deleteMessage(entry.channelId, messageId)
            appendLine(fd, { ...exact, status: 'resolved' })
            outcomes.push({ entry, outcome: 'deleted' })
          } catch (error) {
            if (error instanceof CleanupArtifactNotFoundError) {
              appendLine(fd, { ...exact, status: 'resolved' })
              outcomes.push({ entry, outcome: 'already-gone' })
            } else throw error
          }
          continue
        }
        if ((await validatedAlive(input.transport, entry)) === false) {
          // A validated-absent artifact has nothing left to clean; resolving it
          // keeps repeated recovery passes from re-validating it forever.
          appendLine(fd, entryOf(entry, 'resolved'))
          outcomes.push({ entry, outcome: 'already-gone' })
          continue
        }
        await deleteArtifact(input.transport, entry)
        appendLine(fd, entryOf(entry, 'resolved'))
        outcomes.push({ entry, outcome: 'deleted' })
      } catch (error) {
        if (error instanceof CleanupArtifactNotFoundError && entry._tag === 'artifact') {
          appendLine(fd, entryOf(entry, 'resolved'))
          outcomes.push({ entry, outcome: 'already-gone' })
        } else {
          outcomes.push({ entry, outcome: 'failed', error })
        }
      }
    }
  } finally {
    closeSync(fd)
  }
  return outcomes
}
