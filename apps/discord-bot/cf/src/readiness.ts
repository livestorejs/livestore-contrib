import { schemaVersion } from './journal.ts'
import type { SupervisorState } from './supervisor.ts'
import type { GatewayTelemetrySnapshot } from './gateway-telemetry.ts'

export interface GatewayHealthSummary {
  readonly supervisor: SupervisorState
  readonly sessionPresent: boolean
  /** Bounded, content-free lifetime soak totals and current-activation health. */
  readonly gateway: GatewayTelemetrySnapshot | null
  /** Journal or supervision-loop failure outside the gateway state machine. */
  readonly lastError: string | null
  readonly releaseId: string
  /** Cloudflare Worker version assigned to the gateway Durable Object. */
  readonly workerVersionId: string | null
}

export interface ReadinessStatus {
  readonly health: GatewayHealthSummary
  readonly journalSchemaVersion: number
}

export interface ReadinessReport {
  readonly ready: boolean
  readonly releaseId: string
  readonly workerVersionId: string | undefined
  readonly checks: {
    readonly journalCurrent: boolean
    readonly supervisorReady: boolean
    readonly sessionPresent: boolean
    readonly gatewayHealthy: boolean
    readonly errorFree: boolean
  }
}

/** Public, non-sensitive readiness projection used by `/readyz`. */
export const evaluateReadiness = (status: ReadinessStatus): ReadinessReport => {
  const { health } = status
  const checks = {
    journalCurrent: status.journalSchemaVersion === schemaVersion,
    supervisorReady: health.supervisor === 'ready',
    sessionPresent: health.sessionPresent,
    gatewayHealthy:
      health.gateway !== null &&
      health.gateway.current.state === 'ready' &&
      health.gateway.current.connectedAt !== null &&
      (health.gateway.current.lastReadyAt !== null ||
        health.gateway.current.lastResumedAt !== null) &&
      health.gateway.current.terminalCloseCode === null &&
      health.gateway.current.lastError === null &&
      health.lastError === null,
    errorFree: health.lastError === null,
  }

  return {
    ready:
      checks.journalCurrent &&
      checks.supervisorReady &&
      checks.sessionPresent &&
      checks.gatewayHealthy &&
      checks.errorFree,
    releaseId: health.releaseId,
    workerVersionId: health.workerVersionId ?? undefined,
    checks,
  }
}
