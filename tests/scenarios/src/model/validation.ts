import { Schema } from '@livestore/utils/effect'

import {
  type ClientDefinition,
  type ParallelOperationStep,
  type ParticipantRef,
  ScenarioAst,
  type ScenarioStep,
} from './scenario.ts'

export class ScenarioValidationError extends Error {
  readonly _tag = 'ScenarioValidationError'

  constructor(message: string) {
    super(message)
    this.name = 'ScenarioValidationError'
  }
}

/** Validates both the wire shape and the cross-reference invariants of a scenario. */
export const defineScenario = (input: unknown): ScenarioAst => {
  let scenario: ScenarioAst
  try {
    scenario = Schema.decodeUnknownSync(ScenarioAst)(input)
  } catch (cause) {
    throw new ScenarioValidationError(`Invalid scenario AST: ${String(cause)}`)
  }

  const clientIds = new Set<string>()
  const participants = new Set<string>()
  for (const client of scenario.topology.clients) {
    if (clientIds.has(client.id) === true) throw new ScenarioValidationError(`Duplicate Client id: ${client.id}`)
    clientIds.add(client.id)
    if (client.sessions.length === 0) {
      throw new ScenarioValidationError(`Client ${client.id} must declare at least one session`)
    }
    for (const sessionId of client.sessions) {
      const key = participantKey({ clientId: client.id, sessionId })
      if (participants.has(key) === true) throw new ScenarioValidationError(`Duplicate participant: ${key}`)
      participants.add(key)
    }
  }

  const assertClient = (clientId: string) => {
    if (clientIds.has(clientId) === false) throw new ScenarioValidationError(`Unknown Client reference: ${clientId}`)
  }
  const assertParticipant = (participant: ParticipantRef) => {
    const key = participantKey(participant)
    if (participants.has(key) === false) throw new ScenarioValidationError(`Unknown participant reference: ${key}`)
  }

  const stepIds = new Set<string>()
  const operationIds = new Set<string>()
  const planSteps: ScenarioStep[] = []
  const validateOperation = (step: ParallelOperationStep) => {
    if (stepIds.has(step.id) === true) throw new ScenarioValidationError(`Duplicate step id: ${step.id}`)
    stepIds.add(step.id)
    operationIds.add(step.id)
    if (step._tag === 'action') assertParticipant(step.target)
    if (step._tag === 'stop-session' || step._tag === 'restart-session') assertParticipant(step.target)
    if (step._tag === 'restart-client') assertClient(step.clientId)
    if (step._tag === 'disconnect' || step._tag === 'reconnect') assertClient(step.clientId)
  }
  for (const phase of scenario.phases) {
    for (const step of phase.steps) {
      planSteps.push(step)
      if (stepIds.has(step.id) === true) throw new ScenarioValidationError(`Duplicate step id: ${step.id}`)
      stepIds.add(step.id)
      if (step._tag === 'parallel') {
        if (step.operations.length < 2) {
          throw new ScenarioValidationError(`Parallel step must contain at least two operations: ${step.id}`)
        }
        step.operations.forEach(validateOperation)
      } else {
        operationIds.add(step.id)
        switch (step._tag) {
          case 'create-client': {
            if (clientIds.has(step.client.id) === true) {
              throw new ScenarioValidationError(`Duplicate Client id: ${step.client.id}`)
            }
            if (step.client.sessions.length === 0) {
              throw new ScenarioValidationError(`Client ${step.client.id} must declare at least one session`)
            }
            clientIds.add(step.client.id)
            for (const sessionId of step.client.sessions) {
              const key = participantKey({ clientId: step.client.id, sessionId })
              if (participants.has(key) === true) throw new ScenarioValidationError(`Duplicate participant: ${key}`)
              participants.add(key)
            }
            break
          }
          case 'add-session': {
            assertClient(step.target.clientId)
            const key = participantKey(step.target)
            if (participants.has(key) === true) throw new ScenarioValidationError(`Duplicate participant: ${key}`)
            participants.add(key)
            break
          }
          case 'action':
            assertParticipant(step.target)
            break
          case 'workload':
            if (step.targets.length === 0) {
              throw new ScenarioValidationError(`Workload must select at least one target: ${step.id}`)
            }
            if (step.count <= 0 || step.count > 10_000) {
              throw new ScenarioValidationError(`Workload count must be between 1 and 10000: ${step.id}`)
            }
            step.targets.forEach(assertParticipant)
            break
          case 'stop-session':
          case 'restart-session':
            assertParticipant(step.target)
            break
          case 'restart-client':
          case 'disconnect':
          case 'reconnect':
            assertClient(step.clientId)
            break
          case 'backend-unavailable':
          case 'backend-available':
          case 'settle':
            break
        }
      }
      if (step._tag === 'settle') {
        if (step.timeoutMs <= 0) throw new ScenarioValidationError(`Settle timeout must be positive: ${step.id}`)
        step.participants.forEach(assertParticipant)
        step.healDisconnectedClients.forEach(assertClient)
      }
    }
  }

  const snapshotOracleParticipants = new Set<string>()
  for (const oracle of scenario.oracles) {
    if (oracle._tag === 'operation-history') {
      if (oracle.operationIds.length === 0) {
        throw new ScenarioValidationError(`Operation-history oracle must select at least one operation: ${oracle.id}`)
      }
      if (oracle.requireOverlap === true && oracle.operationIds.length < 2) {
        throw new ScenarioValidationError(
          `Operation-history oracle requires at least two operations to check overlap: ${oracle.id}`,
        )
      }
      for (const operationId of oracle.operationIds) {
        if (operationIds.has(operationId) === false) {
          throw new ScenarioValidationError(`Unknown operation reference: ${operationId}`)
        }
      }
    } else if (oracle._tag === 'confirmed-eventlog-prefix') {
      if (oracle.participants.length === 0) {
        throw new ScenarioValidationError(
          `Confirmed-eventlog-prefix oracle must select at least one participant: ${oracle.id}`,
        )
      }
      const selectedParticipants = new Set<string>()
      for (const participant of oracle.participants) {
        assertParticipant(participant)
        const key = participantKey(participant)
        if (selectedParticipants.has(key) === true) {
          throw new ScenarioValidationError(
            `Confirmed-eventlog-prefix oracle selects participant more than once: ${key}`,
          )
        }
        selectedParticipants.add(key)
      }
    } else {
      for (const participant of oracle.participants) {
        assertParticipant(participant)
        snapshotOracleParticipants.add(participantKey(participant))
      }
    }
  }

  if (snapshotOracleParticipants.size > 0) {
    const terminalStep = planSteps.at(-1)
    if (terminalStep?._tag !== 'settle') {
      throw new ScenarioValidationError(
        'Snapshot-based oracles require a terminal Settlement as the final Scenario step',
      )
    }
    const settledParticipants = new Set(terminalStep.participants.map(participantKey))
    const missingParticipants = [...snapshotOracleParticipants].filter(
      (participant) => settledParticipants.has(participant) === false,
    )
    if (missingParticipants.length > 0) {
      throw new ScenarioValidationError(
        `Terminal Settlement is missing snapshot-oracle participants: ${missingParticipants.join(', ')}`,
      )
    }
  }

  return scenario
}

/** Returns the complete topology declared by startup definitions and ordered addition steps. */
export const deriveScenarioTopology = (scenario: ScenarioAst): ReadonlyArray<ClientDefinition> => {
  const clients = new Map(
    scenario.topology.clients.map((client) => [client.id, { ...client, sessions: [...client.sessions] }]),
  )
  for (const step of scenario.phases.flatMap((phase) => phase.steps)) {
    if (step._tag === 'create-client') {
      clients.set(step.client.id, { ...step.client, sessions: [...step.client.sessions] })
    } else if (step._tag === 'add-session') {
      const client = clients.get(step.target.clientId)
      if (client !== undefined) {
        clients.set(client.id, { ...client, sessions: [...client.sessions, step.target.sessionId] })
      }
    }
  }
  return [...clients.values()]
}

export const participantKey = ({ clientId, sessionId }: ParticipantRef): string => `${clientId}/${sessionId}`
