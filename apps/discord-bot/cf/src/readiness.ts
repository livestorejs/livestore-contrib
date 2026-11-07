import type { AutomaticDiagnosticsSnapshot } from './automatic-diagnostics.ts'
import type { GatewayTelemetrySnapshot } from './gateway-telemetry.ts'
import { schemaVersion } from './journal.ts'
import type { SupervisorState } from './supervisor.ts'
import type { WorkerGatewayReport } from './worker-gateway-state.ts'

export interface GatewayHealthSummary {
  readonly supervisor: SupervisorState
  readonly workerGateway?: WorkerGatewayReport
  readonly sessionPresent: boolean
  /** Bounded, content-free lifetime soak totals and current-activation health. */
  readonly gateway: GatewayTelemetrySnapshot | null
  /** Journal or supervision-loop failure outside the gateway state machine. */
  readonly lastError: string | null
  readonly releaseId: string
  /** Cloudflare Worker version assigned to the gateway Durable Object. */
  readonly workerVersionId: string | null
}

/** Pending cold boot is a distinct health state, not a Discord REST error. */
export const awaitingAlarmBuildHealth = (input: {
  readonly sinceMs: number
  readonly lastBuildFailure: string | undefined
  readonly releaseId: string
  readonly workerVersionId: string | undefined
}): GatewayHealthSummary => ({
  supervisor: 'disconnected',
  sessionPresent: false,
  gateway: null,
  lastError: `awaiting alarm build since ${new Date(input.sinceMs).toISOString()}${
    input.lastBuildFailure === undefined ? '' : `; last build failure: ${input.lastBuildFailure}`
  }`,
  releaseId: input.releaseId,
  workerVersionId: input.workerVersionId ?? null,
})

export interface ReadinessStatus {
  readonly health: GatewayHealthSummary
  readonly workerGatewayHealthy?: boolean
  readonly journalSchemaVersion: number
  readonly automaticDiagnostics?: AutomaticDiagnosticsSnapshot | undefined
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
export const evaluateReadiness = (status: ReadinessStatus, now = Date.now()): ReadinessReport => {
  const { health } = status
  const frames = status.automaticDiagnostics?.gatewayFrames
  const interval = frames?.heartbeatIntervalMs
  const ack = frames?.lastHeartbeatAckAt
  const hello = frames?.lastHelloAt
  // The first ACK may arrive after a randomized initial heartbeat. Permit a
  // bounded two-interval handshake grace, then require a fresh ACK from this
  // socket; a prior socket's ACK cannot extend its successor's grace.
  const heartbeatAnchor =
    hello === null || hello === undefined ? null : ack !== null && ack !== undefined && ack >= hello ? ack : hello
  const heartbeatHealthy =
    interval !== undefined &&
    interval !== null &&
    heartbeatAnchor !== null &&
    now >= heartbeatAnchor &&
    now - heartbeatAnchor <= 2 * interval
  const checks = {
    journalCurrent: status.journalSchemaVersion === schemaVersion,
    supervisorReady: health.supervisor === 'ready',
    sessionPresent: health.sessionPresent,
    gatewayHealthy:
      status.workerGatewayHealthy ??
      (health.gateway !== null &&
        health.gateway.current.state === 'ready' &&
        health.gateway.current.connectedAt !== null &&
        (health.gateway.current.lastReadyAt !== null || health.gateway.current.lastResumedAt !== null) &&
        health.gateway.current.terminalCloseCode === null &&
        health.gateway.current.lastError === null &&
        health.lastError === null &&
        heartbeatHealthy),
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
