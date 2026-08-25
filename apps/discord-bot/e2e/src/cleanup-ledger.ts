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
  readonly schemaVersion: 1
  readonly status: CleanupEntryStatus
}

/**
 * Crash-resumable per-run ledger. Every artifact must be recorded before the
 * caller acknowledges it to Discord, and resolved only after its deletion
 * succeeded, so a crash can never orphan an untracked staging artifact.
 */
export interface CleanupLedgerWriter {
  /** Appends an open-status line; writeSync makes it visible to any subsequent process before returning. */
  readonly record: (identity: CleanupLedgerIdentity) => void
  /** Appends a resolved-status line after successful deletion. */
  readonly resolve: (identity: CleanupLedgerIdentity) => void
  readonly close: () => void
}

export interface UnresolvedEntries {
  readonly unresolved: ReadonlyArray<CleanupLedgerEntry>
  readonly warnings: ReadonlyArray<string>
}

export type RecoveryOutcome =
  | { readonly entry: CleanupLedgerEntry; readonly outcome: 'deleted' }
  | { readonly entry: CleanupLedgerEntry; readonly outcome: 'already-gone' }
  | { readonly entry: CleanupLedgerEntry; readonly outcome: 'failed'; readonly error: unknown }

const kinds: Record<string, true> = { message: true, thread: true, response: true }

const entryOf = (identity: CleanupLedgerIdentity, status: CleanupEntryStatus): CleanupLedgerEntry => ({
  schemaVersion: 1,
  runId: identity.runId,
  scenario: identity.scenario,
  kind: identity.kind,
  guildId: identity.guildId,
  channelId: identity.channelId,
  messageId: identity.messageId,
  status,
})

const entryKey = (entry: CleanupLedgerEntry): string => `${entry.runId}\u0000${entry.kind}\u0000${entry.messageId}`

/** Owner-only access regardless of umask or looser pre-existing bits. */
const appendFd = (filePath: string): number => {
  const fd = openSync(filePath, 'a', 0o600)
  fchmodSync(fd, 0o600)
  return fd
}

const appendLine = (fd: number, entry: CleanupLedgerEntry): void => {
  writeSync(fd, `${JSON.stringify(entry)}\n`)
}

const isSnowflakeString = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{17,20}$/u.test(value) === true

const decodeSnowflake = (value: unknown): Snowflake | undefined => (isSnowflakeString(value) === true ? (value as Snowflake) : undefined)

const decodeEntry = (value: unknown): CleanupLedgerEntry | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value) === true) return undefined
  const decoded = value as Record<string, unknown>
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
  const assertRun = (identity: CleanupLedgerIdentity): void => {
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
  const openEntries: CleanupLedgerEntry[] = []
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
      // Threads are exactly addressable through their source message id.
      const thread = await transport.findThreadForMessage(entry.guildId, entry.messageId)
      return thread !== undefined && thread.id === entry.messageId
    }
    case 'message':
    case 'response': {
      // The transport exposes no exact-ID read for these kinds; channel
      // reachability is the strongest available gate and fails closed so an
      // unreachable channel never turns into a speculative delete.
      await transport.inspectChannel(entry.channelId)
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
      return transport.deleteResponse(entry.messageId)
  }
}

/**
 * Replays every unresolved ledger entry against the live transport using only
 * exact ids recorded before the artifact was acknowledged — never content
 * matching — marking each entry resolved after its deletion succeeded. An
 * entry that cannot be validated or deleted stays unresolved and the rest
 * continue, so one bad artifact never blocks recovery of the others.
 */
export const recoverCleanupLedger = async (input: {
  filePath: string
  transport: E2ETransport
}): Promise<ReadonlyArray<RecoveryOutcome>> => {
  const { unresolved } = readUnresolvedEntries(input.filePath)
  const outcomes: RecoveryOutcome[] = []
  if (unresolved.length === 0) return outcomes
  const fd = appendFd(input.filePath)
  try {
    for (const entry of unresolved) {
      try {
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
        outcomes.push({ entry, outcome: 'failed', error })
      }
    }
  } finally {
    closeSync(fd)
  }
  return outcomes
}
