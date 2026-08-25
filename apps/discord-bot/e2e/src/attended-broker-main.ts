#!/usr/bin/env -S node --experimental-strip-types

import { openCleanupLedger, type CleanupLedgerIdentity } from './cleanup-ledger.ts'
import {
  dispatchBrokerOperation,
  makeDfxBrokerCorrelator,
  parseBrokerInvocation,
  type AttendedBrokerDeps,
  type AttendedBrokerDriver,
  makeDfxRecoveryTransport,
  type BrokerLedgerInput,
  type GesturePerformer,
} from './attended-broker.ts'
import { makeHttpCaptureBrokerDriver } from './attended-broker-driver.ts'
import { recoverCleanupLedger } from './cleanup-ledger.ts'
import type { Snowflake } from './model.ts'

// The bundled driver is browser automation over an authenticated official
// client, so the honest default attestation is not 'human'; a human-operated
// deployment sets LIVESTORE_DISCORD_E2E_BROKER_PERFORMER=human explicitly.
const readPerformer = (): GesturePerformer => {
  const value = process.env.LIVESTORE_DISCORD_E2E_BROKER_PERFORMER
  if (value === 'human') return 'human'
  if (value === undefined || value === 'official-client-session') return 'official-client-session'
  throw new Error(`unknown LIVESTORE_DISCORD_E2E_BROKER_PERFORMER value: ${value}`)
}

const args = process.argv.slice(2)
const invocation = parseBrokerInvocation(args)

const readFlag = (name: string): string | undefined => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

if (args[0] === 'recover-ledger') {
  const ledgerPath = readFlag('--ledger')
  if (ledgerPath === undefined) {
    process.stderr.write('Usage: livestore-discord-e2e-broker recover-ledger --ledger FILE\n')
    process.exitCode = 2
  } else {
    try {
      const token = process.env.LIVESTORE_DISCORD_E2E_ACTOR_TOKEN
      if (token === undefined || token.trim() === '') {
        throw new Error('LIVESTORE_DISCORD_E2E_ACTOR_TOKEN must be injected through op-proxy')
      }
      const outcomes = await recoverCleanupLedger({
        filePath: ledgerPath,
        transport: makeDfxRecoveryTransport({ actorBotToken: token }),
      })
      for (const outcome of outcomes) {
        process.stdout.write(`${outcome.outcome} ${outcome.entry.kind}:${outcome.entry.messageId}\n`)
      }
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : 'recovery failed'}\n`)
      process.exitCode = 1
    }
  }
} else if (invocation._tag === 'UsageError') {
  process.stderr.write(`${invocation.message}\n`)
  process.exitCode = 2
} else {
  try {
    const token = process.env.LIVESTORE_DISCORD_E2E_ACTOR_TOKEN
    if (token === undefined || token.trim() === '') {
      throw new Error('LIVESTORE_DISCORD_E2E_ACTOR_TOKEN must be injected through op-proxy')
    }
    const driver: AttendedBrokerDriver = makeHttpCaptureBrokerDriver()
    const deps: AttendedBrokerDeps = {
      driver,
      correlator: makeDfxBrokerCorrelator({ actorBotToken: token }),
      performer: readPerformer(),
      openLedger: ({ filePath, runId }) => {
        const writer = openCleanupLedger({ filePath, runId })
        const identity = (entry: BrokerLedgerInput): CleanupLedgerIdentity => ({
          runId,
          scenario: undefined,
          kind: entry.kind,
          guildId: entry.guildId as Snowflake,
          channelId: entry.channelId as Snowflake,
          messageId: entry.messageId as Snowflake,
        })
        return {
          record: (entry) => writer.record(identity(entry)),
          resolve: (entry) => writer.resolve(identity(entry)),
          close: () => writer.close(),
        }
      },
    }

    const result = await dispatchBrokerOperation(invocation.value, deps)
    process.stdout.write(`${JSON.stringify(result.payload)}\n`)
    if (result.declineExitCode !== undefined) process.exitCode = result.declineExitCode
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'broker operation failed'}\n`)
    process.exitCode = 1
  }
}
