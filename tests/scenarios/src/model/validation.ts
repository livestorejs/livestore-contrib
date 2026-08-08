import { Schema } from '@livestore/utils/effect'

import { expandScenarioAuthoring, scenarioAuthoring, type ScenarioDefinitionFactory } from './authoring.ts'
import { type ClientDefinition, type ParallelOperationStep, type ParticipantRef, ScenarioAst } from './scenario.ts'

export class ScenarioValidationError extends Error {
  readonly _tag = 'ScenarioValidationError'

  constructor(message: string) {
    super(message)
    this.name = 'ScenarioValidationError'
  }
}

/** Validates both the wire shape and the cross-reference invariants of a scenario. */
export function defineScenario(input: ScenarioDefinitionFactory): ScenarioAst
export function defineScenario(input: unknown): ScenarioAst
export function defineScenario(input: unknown): ScenarioAst {
  let scenario: ScenarioAst
  try {
    const authored = typeof input === 'function' ? (input as ScenarioDefinitionFactory)(scenarioAuthoring) : input
    const expanded =
      typeof input === 'function'
        ? expandScenarioAuthoring(authored as ReturnType<ScenarioDefinitionFactory>)
        : authored
    scenario = Schema.decodeUnknownSync(ScenarioAst)(expanded)
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

  const instructionIds = new Set<string>()
  const operationIds = new Set<string>()
  const validateOperation = (operation: ParallelOperationStep) => {
    if (instructionIds.has(operation.id) === true) {
      throw new ScenarioValidationError(`Duplicate instruction id: ${operation.id}`)
    }
    instructionIds.add(operation.id)
    operationIds.add(operation.id)
    if (operation._tag === 'action') assertParticipant(operation.target)
    if (operation._tag === 'stop-session' || operation._tag === 'restart-session') {
      assertParticipant(operation.target)
    }
    if (operation._tag === 'restart-client') assertClient(operation.clientId)
    if (operation._tag === 'disconnect' || operation._tag === 'reconnect') assertClient(operation.clientId)
  }
  for (const instruction of scenario.instructions) {
    if (instructionIds.has(instruction.id) === true) {
      throw new ScenarioValidationError(`Duplicate instruction id: ${instruction.id}`)
    }
    instructionIds.add(instruction.id)
    if (instruction._tag === 'parallel') {
      if (instruction.operations.length < 2) {
        throw new ScenarioValidationError(
          `Parallel instruction must contain at least two operations: ${instruction.id}`,
        )
      }
      instruction.operations.forEach(validateOperation)
    } else {
      if (instruction._tag !== 'annotation') operationIds.add(instruction.id)
      switch (instruction._tag) {
        case 'annotation':
          break
        case 'create-client': {
          if (clientIds.has(instruction.client.id) === true) {
            throw new ScenarioValidationError(`Duplicate Client id: ${instruction.client.id}`)
          }
          if (instruction.client.sessions.length === 0) {
            throw new ScenarioValidationError(`Client ${instruction.client.id} must declare at least one session`)
          }
          clientIds.add(instruction.client.id)
          for (const sessionId of instruction.client.sessions) {
            const key = participantKey({ clientId: instruction.client.id, sessionId })
            if (participants.has(key) === true) throw new ScenarioValidationError(`Duplicate participant: ${key}`)
            participants.add(key)
          }
          break
        }
        case 'add-session': {
          assertClient(instruction.target.clientId)
          const key = participantKey(instruction.target)
          if (participants.has(key) === true) throw new ScenarioValidationError(`Duplicate participant: ${key}`)
          participants.add(key)
          break
        }
        case 'action':
          assertParticipant(instruction.target)
          break
        case 'action-sequence':
          if (instruction.actions.length === 0 || instruction.actions.length > 10_000) {
            throw new ScenarioValidationError(
              `Action sequence must contain between 1 and 10000 actions: ${instruction.id}`,
            )
          }
          for (const action of instruction.actions) validateOperation(action)
          break
        case 'stop-session':
        case 'restart-session':
          assertParticipant(instruction.target)
          break
        case 'restart-client':
        case 'disconnect':
        case 'reconnect':
          assertClient(instruction.clientId)
          break
        case 'backend-unavailable':
        case 'backend-available':
        case 'settle':
          break
      }
    }
    if (instruction._tag === 'settle') {
      instruction.participants.forEach(assertParticipant)
      instruction.healDisconnectedClients.forEach(assertClient)
    }
  }

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
      }
    }
  }

  return scenario
}

/** Returns the complete topology declared by startup definitions and ordered addition instructions. */
export const deriveScenarioTopology = (scenario: ScenarioAst): ReadonlyArray<ClientDefinition> => {
  const clients = new Map(
    scenario.topology.clients.map((client) => [client.id, { ...client, sessions: [...client.sessions] }]),
  )
  for (const instruction of scenario.instructions) {
    if (instruction._tag === 'create-client') {
      clients.set(instruction.client.id, { ...instruction.client, sessions: [...instruction.client.sessions] })
    } else if (instruction._tag === 'add-session') {
      const client = clients.get(instruction.target.clientId)
      if (client !== undefined) {
        clients.set(client.id, { ...client, sessions: [...client.sessions, instruction.target.sessionId] })
      }
    }
  }
  return [...clients.values()]
}

export const participantKey = ({ clientId, sessionId }: ParticipantRef): string => `${clientId}/${sessionId}`

/** Snapshot properties establish one terminal stable boundary over their union. */
export const terminalStabilizationParticipants = (scenario: ScenarioAst): ReadonlyArray<ParticipantRef> => {
  const participants = new Map<string, ParticipantRef>()
  for (const oracle of scenario.oracles) {
    if (oracle._tag === 'operation-history' || oracle._tag === 'confirmed-eventlog-prefix') continue
    for (const participant of oracle.participants) participants.set(participantKey(participant), participant)
  }
  return [...participants.values()]
}
