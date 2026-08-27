import { describe, expect, it } from 'vitest'

import {
  emptyGatewayTelemetrySnapshot,
  type GatewayTelemetrySnapshot,
} from './gateway-telemetry.ts'
import { schemaVersion } from './journal.ts'
import { evaluateReadiness, type ReadinessStatus } from './readiness.ts'

const baseGateway = emptyGatewayTelemetrySnapshot('activation-a')
const readyGateway: GatewayTelemetrySnapshot = {
  lifetime: { ...baseGateway.lifetime, identifies: 1, lastReadyAt: 1_000 },
  current: {
    ...baseGateway.current,
    state: 'ready',
    attempt: 1,
    connectedAt: 1_000,
    lastReadyAt: 1_000,
  },
}
const readyStatus: ReadinessStatus = {
  journalSchemaVersion: schemaVersion,
  health: {
    supervisor: 'ready',
    sessionPresent: true,
    gateway: readyGateway,
    lastError: null,
    releaseId: 'sha256:release',
    workerVersionId: 'cf-version-1',
  },
}

describe('gateway-aware readiness', () => {
  it('is ready only when the journal, supervisor, session, and telemetry checks all pass', () => {
    expect(evaluateReadiness(readyStatus)).toEqual({
      ready: true,
      releaseId: 'sha256:release',
      workerVersionId: 'cf-version-1',
      checks: {
        journalCurrent: true,
        supervisorReady: true,
        sessionPresent: true,
        gatewayHealthy: true,
        errorFree: true,
      },
    })
  })

  it('withdraws readiness for stale, terminal, and errored gateway health', () => {
    const withCurrent = (
      patch: Partial<NonNullable<ReadinessStatus['health']['gateway']>['current']>,
    ): ReadinessStatus => ({
      ...readyStatus,
      health: {
        ...readyStatus.health,
        gateway: {
          ...readyGateway,
          current: { ...readyGateway.current, ...patch },
        },
      },
    })

    // Lifetime history deliberately remains ready: only this activation's
    // establishment is allowed to satisfy readiness.
    expect(evaluateReadiness(withCurrent({ lastReadyAt: null })).ready).toBe(false)
    expect(evaluateReadiness(withCurrent({
      state: 'terminal',
      terminalCloseCode: 4_014,
      lastError: 'terminal-close',
    })).ready).toBe(false)
    expect(evaluateReadiness({
      ...readyStatus,
      health: { ...readyStatus.health, lastError: 'gateway loop failed' },
    }).ready).toBe(false)
  })

  it('withdraws on disconnect and restores only after the current activation resumes', () => {
    const disconnectedGateway: GatewayTelemetrySnapshot = {
      ...readyGateway,
      current: {
        ...readyGateway.current,
        state: 'disconnected',
        connectedAt: null,
        lastDisconnectedAt: 1_050,
        lastError: 'disconnected',
      },
    }
    const disconnected: ReadinessStatus = {
      ...readyStatus,
      health: {
        ...readyStatus.health,
        gateway: disconnectedGateway,
      },
    }
    expect(evaluateReadiness(readyStatus).ready).toBe(true)
    expect(evaluateReadiness(disconnected).ready).toBe(false)
    expect(evaluateReadiness({
      ...disconnected,
      health: {
        ...disconnected.health,
        gateway: {
          ...disconnectedGateway,
          current: {
            ...disconnectedGateway.current,
            state: 'ready',
            connectedAt: 1_100,
            lastResumedAt: 1_100,
            lastError: null,
          },
        },
      },
    }).ready).toBe(true)
  })

  it('accepts RESUMED as the first current-activation establishment observation', () => {
    expect(evaluateReadiness({
      ...readyStatus,
      health: {
        ...readyStatus.health,
        gateway: {
          ...readyGateway,
          current: {
            ...readyGateway.current,
            lastReadyAt: null,
            lastResumedAt: 1_100,
          },
        },
      },
    }).ready).toBe(true)
  })

  it.each([
    ['journal is stale', { journalSchemaVersion: schemaVersion - 1 }],
    ['supervisor is disconnected', { health: { ...readyStatus.health, supervisor: 'disconnected' as const } }],
    ['session is absent', { health: { ...readyStatus.health, sessionPresent: false } }],
  ])('is not ready when the %s', (_label, patch) => {
    expect(evaluateReadiness({ ...readyStatus, ...patch }).ready).toBe(false)
  })
})
