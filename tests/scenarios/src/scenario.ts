import type { Schema } from '@livestore/utils/effect'

import { parseScenarioDurationMs } from './duration.ts'
import {
  defineScenario,
  type ParallelOperationStep,
  type ParticipantRef,
  type ScenarioAst,
  type ScenarioInstruction,
  type ScenarioOracle,
  scenarioVersion,
} from './model.ts'

const identifier = /^[A-Za-z][A-Za-z0-9_-]*$/

interface ScenarioApplicationShape {
  readonly id: string
  readonly scenarioName: string
  readonly actions: Readonly<
    Record<string, { readonly _Input?: unknown; readonly validateInput: (input: Schema.Json) => void }>
  >
  readonly inspectors: Readonly<Record<string, unknown>>
}

type ActionInput<TAction> = TAction extends { readonly _Input?: infer TInput } ? TInput : Schema.Json

export interface ScenarioClient {
  readonly _tag: 'ScenarioClient'
  readonly id: string
  readonly sessions: ReadonlyArray<ScenarioSession>
  readonly initiallyConnected: boolean
  readonly session: (sessionId: string) => ScenarioSession
  readonly withSessions: (...sessionIds: ReadonlyArray<string>) => ScenarioClient
  readonly disconnected: () => ScenarioClient
}

export interface ScenarioSession extends ParticipantRef {
  readonly _tag: 'ScenarioSession'
}

export interface ScenarioAlias {
  readonly _tag: 'ScenarioAlias'
  readonly members: ReadonlyArray<ScenarioSession>
}

export type ScenarioParticipantSelection = ScenarioSession | ScenarioAlias

interface ActionSpec {
  readonly _tag: 'action'
  readonly application: ScenarioApplicationShape
  readonly target: ScenarioSession
  readonly action: string
  readonly input: Schema.Json
}

type ParallelSpec =
  | ActionSpec
  | { readonly _tag: 'disconnect' | 'reconnect'; readonly client: ScenarioClient }
  | { readonly _tag: 'stop-session' | 'restart-session'; readonly target: ScenarioSession }
  | { readonly _tag: 'restart-client'; readonly client: ScenarioClient }
  | { readonly _tag: 'backend-unavailable' | 'backend-available' }

type SequenceRequirement =
  | 'all-finish'
  | 'first-finish'
  | 'last-finish'
  | 'first-and-last-finish'
  | {
      readonly finish: 'all' | 'first' | 'last' | 'first-and-last'
      readonly allowIndefinite?: boolean
    }

interface SequenceContext {
  readonly random: ScenarioRandomSource
}

type SequenceActions = ReadonlyArray<ScenarioAction> | ((context: SequenceContext) => ReadonlyArray<ScenarioAction>)

type InstructionSpec =
  | ActionSpec
  | { readonly _tag: 'annotation'; readonly text: string }
  | { readonly _tag: 'wait'; readonly durationMs: number }
  | Exclude<ParallelSpec, ActionSpec>
  | { readonly _tag: 'create-client'; readonly client: ScenarioClient }
  | { readonly _tag: 'add-session'; readonly target: ScenarioSession }
  | {
      readonly _tag: 'settle'
      readonly participants: ScenarioParticipantSelection
      readonly reconnect: ReadonlyArray<ScenarioClient>
    }
  | {
      readonly _tag: 'parallel'
      readonly operations: ReadonlyArray<ParallelSpec>
      readonly requirement?:
        | 'overlap'
        | 'all-finish'
        | { readonly operations: 'overlap' | 'all-finish'; readonly allowIndefinite?: boolean }
    }
  | {
      readonly _tag: 'action-sequence'
      readonly kind: 'repeat' | 'generate'
      readonly actions: SequenceActions
      readonly description?: string
      readonly delayBetweenActionsMs: number | null
      readonly requirement?: SequenceRequirement
    }

interface OracleSpec {
  readonly _tag: 'pending-resolution' | 'eventlog-convergence' | 'state-convergence' | 'state-contains-ids'
  readonly participants?: ScenarioParticipantSelection
  readonly inspector?: string
  readonly expectedIds?: ReadonlyArray<string>
}

interface ScenarioStart {
  readonly application: ScenarioApplicationReference
  readonly about?: string
  readonly seed?: number
  readonly clients: ReadonlyArray<ScenarioClient>
}

export interface ScenarioOperation {
  readonly _tag: 'ScenarioOperation'
  readonly spec: InstructionSpec
}

export interface ScenarioAction extends ScenarioOperation {
  readonly spec: ActionSpec
}

export type ScenarioActionMethods<TApplication extends ScenarioApplicationShape> = {
  readonly [TName in keyof TApplication['actions']]: (input: ActionInput<TApplication['actions'][TName]>) => {
    readonly as: (target: ScenarioSession) => ScenarioAction
  }
}

interface ScenarioApplicationReference {
  readonly _tag: 'ScenarioApplication'
  readonly definition: ScenarioApplicationShape
}

export type ScenarioApplication<TApplication extends ScenarioApplicationShape> = ScenarioApplicationReference &
  ScenarioActionMethods<TApplication>

export class ScenarioPlan {
  readonly _tag = 'ScenarioPlan'

  constructor(
    readonly start: ScenarioStart,
    readonly instructions: ReadonlyArray<InstructionSpec> = [],
    readonly expectations: ReadonlyArray<OracleSpec> | undefined = undefined,
  ) {}
}

export class ScenarioBuilder extends ScenarioPlan {
  steps(...operations: ReadonlyArray<ScenarioOperation>): ScenarioBuilder {
    return new ScenarioBuilder(this.start, [...this.instructions, ...operations.map(({ spec }) => spec)])
  }

  expect(...expectations: ReadonlyArray<OracleSpec>): ScenarioPlan {
    if (expectations.length === 0) throw new ScenarioSourceError('Explicit expectations cannot be empty')
    return new ScenarioPlan(this.start, this.instructions, expectations)
  }
}

export interface ScenarioRandom {
  /** Stable value in [0, 1) for this sequence iteration and key. */
  readonly next: (key: string) => number
  readonly integer: (key: string, maximumExclusive: number) => number
  readonly pick: <T>(key: string, values: ReadonlyArray<T>) => T
}

export interface ScenarioRandomSource {
  /** Iterations are positive and one-based. */
  readonly iteration: (iteration: number) => ScenarioRandom
}

export interface ScenarioParameter<TValue> {
  readonly _tag: 'ScenarioParameter'
  readonly kind: 'integer' | 'number' | 'string' | 'boolean'
  readonly default: TValue
}

type ScenarioParameters = Readonly<Record<string, ScenarioParameter<string | number | boolean>>>
type DecodedParameters<TParameters extends ScenarioParameters> = {
  readonly [TName in keyof TParameters]: TParameters[TName]['default']
}

export interface ParameterizedScenario<TParameters extends ScenarioParameters = ScenarioParameters> {
  readonly _tag: 'ParameterizedScenario'
  readonly parameters: TParameters
  make(parameters: DecodedParameters<TParameters>): ScenarioPlan
}

export type ScenarioSource = ScenarioPlan | ParameterizedScenario

export const isScenarioSource = (value: unknown): value is ScenarioSource =>
  typeof value === 'object' &&
  value !== null &&
  '_tag' in value &&
  (value._tag === 'ScenarioPlan' || value._tag === 'ParameterizedScenario')

export interface NormalizeScenarioOptions {
  readonly id: string
  readonly parameters?: Readonly<Record<string, string | number | boolean>>
  readonly seed?: number
}

export class ScenarioSourceError extends Error {
  readonly _tag = 'ScenarioSourceError'

  constructor(message: string) {
    super(message)
    this.name = 'ScenarioSourceError'
  }
}

export const client = (id: string): ScenarioClient => {
  assertIdentifier(id, 'Client')
  return makeClient(id, [], true)
}

const makeClient = (
  id: string,
  sessions: ReadonlyArray<ScenarioSession>,
  initiallyConnected: boolean,
): ScenarioClient => {
  const value: ScenarioClient = {
    _tag: 'ScenarioClient',
    id,
    sessions: Object.freeze([...sessions]),
    initiallyConnected,
    session: (sessionId) =>
      sessions.find((candidate) => candidate.sessionId === sessionId) ?? makeSession(id, sessionId),
    withSessions: (...sessionIds) => {
      if (sessionIds.length === 0) throw new ScenarioSourceError(`Client ${id} must declare at least one session`)
      const seen = new Set<string>()
      const declaredSessions = sessionIds.map((sessionId) => {
        if (seen.has(sessionId) === true) throw new ScenarioSourceError(`Duplicate participant '${id}/${sessionId}'`)
        seen.add(sessionId)
        return makeSession(id, sessionId)
      })
      return makeClient(id, declaredSessions, initiallyConnected)
    },
    disconnected: () => makeClient(id, sessions, false),
  }
  return Object.freeze(value)
}

const makeSession = (clientId: string, sessionId: string): ScenarioSession => {
  assertIdentifier(sessionId, 'session')
  return Object.freeze({ _tag: 'ScenarioSession', clientId, sessionId })
}

export const alias = (participants: ReadonlyArray<ScenarioSession>): ScenarioAlias => {
  if (participants.length === 0) throw new ScenarioSourceError('An alias must contain at least one session')
  const seen = new Set<string>()
  for (const participant of participants) {
    const key = participantKey(participant)
    if (seen.has(key) === true) throw new ScenarioSourceError(`Alias contains session more than once: ${key}`)
    seen.add(key)
  }
  return Object.freeze({ _tag: 'ScenarioAlias', members: [...participants] })
}

export const scenarioApplication = <const TApplication extends ScenarioApplicationShape>(
  definition: TApplication,
): ScenarioApplication<TApplication> =>
  new Proxy(
    { _tag: 'ScenarioApplication' as const, definition },
    {
      get: (target, property) => {
        if (property in target) return target[property as keyof typeof target]
        if (typeof property !== 'string' || definition.actions[property] === undefined) return undefined
        return (input: unknown) => ({
          as: (targetSession: ScenarioSession) =>
            makeOperation({
              _tag: 'action',
              application: definition,
              target: targetSession,
              action: property,
              input: assertJson(input, `Input for action '${property}'`),
            }) as ScenarioAction,
        })
      },
    },
  ) as ScenarioApplication<TApplication>

const makeOperation = <TSpec extends InstructionSpec>(spec: TSpec): ScenarioOperation & { readonly spec: TSpec } =>
  Object.freeze({ _tag: 'ScenarioOperation', spec })

export const note = (text: string): ScenarioOperation => makeOperation({ _tag: 'annotation', text })

export const wait = (duration: string | number): ScenarioOperation =>
  makeOperation({ _tag: 'wait', durationMs: compileDuration(duration) })

export const disconnect = (target: ScenarioClient): ScenarioOperation =>
  makeOperation({ _tag: 'disconnect', client: target })

export const reconnect = (target: ScenarioClient): ScenarioOperation =>
  makeOperation({ _tag: 'reconnect', client: target })

export const stopSession = (target: ScenarioSession): ScenarioOperation =>
  makeOperation({ _tag: 'stop-session', target })

export const restartSession = (target: ScenarioSession): ScenarioOperation =>
  makeOperation({ _tag: 'restart-session', target })

export const restartClient = (target: ScenarioClient): ScenarioOperation =>
  makeOperation({ _tag: 'restart-client', client: target })

export const createClient = (definition: ScenarioClient): ScenarioOperation =>
  makeOperation({ _tag: 'create-client', client: definition })

export const addSession = (target: ScenarioSession): ScenarioOperation => makeOperation({ _tag: 'add-session', target })

export const backendUnavailable = (): ScenarioOperation => makeOperation({ _tag: 'backend-unavailable' })
export const backendAvailable = (): ScenarioOperation => makeOperation({ _tag: 'backend-available' })

export const settle = (
  participants: ScenarioParticipantSelection,
  options: { readonly reconnect?: ReadonlyArray<ScenarioClient> } = {},
): ScenarioOperation =>
  makeOperation({
    _tag: 'settle',
    participants,
    reconnect: options.reconnect === undefined ? [] : [...options.reconnect],
  })

export const parallel = (
  operations: ReadonlyArray<ScenarioOperation>,
  options: {
    readonly require?:
      | 'overlap'
      | 'all-finish'
      | { readonly operations: 'overlap' | 'all-finish'; readonly allowIndefinite?: boolean }
  } = {},
): ScenarioOperation => {
  if (operations.length < 2) throw new ScenarioSourceError('Concurrency requires at least two operations')
  const specs = operations.map(({ spec }) => {
    if (
      spec._tag === 'annotation' ||
      spec._tag === 'wait' ||
      spec._tag === 'create-client' ||
      spec._tag === 'add-session' ||
      spec._tag === 'settle' ||
      spec._tag === 'parallel' ||
      spec._tag === 'action-sequence'
    ) {
      throw new ScenarioSourceError(`Unsupported concurrent operation: ${spec._tag}`)
    }
    return spec
  })
  return makeOperation({ _tag: 'parallel', operations: specs, requirement: options.require })
}

interface SequenceOptions {
  readonly description?: string
  readonly between?: string | number
  readonly require?: SequenceRequirement
}

const sequence = (
  kind: 'repeat' | 'generate',
  actions: SequenceActions,
  options: SequenceOptions = {},
): ScenarioOperation =>
  makeOperation({
    _tag: 'action-sequence',
    kind,
    actions,
    description: options.description,
    delayBetweenActionsMs: options.between === undefined ? null : compileDuration(options.between),
    requirement: options.require,
  })

export const repeat = (actions: ReadonlyArray<ScenarioAction>, options: SequenceOptions = {}): ScenarioOperation =>
  sequence('repeat', actions, options)

export const generate = (actions: SequenceActions, options: SequenceOptions = {}): ScenarioOperation =>
  sequence('generate', actions, options)

export const pendingResolved = (participants?: ScenarioParticipantSelection): OracleSpec => ({
  _tag: 'pending-resolution',
  participants,
})

export const eventlogsConverge = (participants?: ScenarioParticipantSelection): OracleSpec => ({
  _tag: 'eventlog-convergence',
  participants,
})

export const stateConverges = (inspector: string, participants?: ScenarioParticipantSelection): OracleSpec => ({
  _tag: 'state-convergence',
  participants,
  inspector,
})

export const stateContainsIds = (
  inspector: string,
  expectedIds: ReadonlyArray<string>,
  participants?: ScenarioParticipantSelection,
): OracleSpec => ({ _tag: 'state-contains-ids', participants, inspector, expectedIds })

export const parameter = {
  integer: (defaultValue: number): ScenarioParameter<number> => {
    if (Number.isInteger(defaultValue) === false)
      throw new ScenarioSourceError('Integer parameter default must be an integer')
    return { _tag: 'ScenarioParameter', kind: 'integer', default: defaultValue }
  },
  number: (defaultValue: number): ScenarioParameter<number> => {
    if (Number.isFinite(defaultValue) === false)
      throw new ScenarioSourceError('Number parameter default must be finite')
    return { _tag: 'ScenarioParameter', kind: 'number', default: defaultValue }
  },
  string: (defaultValue: string): ScenarioParameter<string> => ({
    _tag: 'ScenarioParameter',
    kind: 'string',
    default: defaultValue,
  }),
  boolean: (defaultValue: boolean): ScenarioParameter<boolean> => ({
    _tag: 'ScenarioParameter',
    kind: 'boolean',
    default: defaultValue,
  }),
}

const start = (definition: ScenarioStart): ScenarioBuilder => {
  if (definition.clients.length === 0) throw new ScenarioSourceError('At least one initial Client is required')
  if (definition.seed !== undefined && (Number.isInteger(definition.seed) === false || definition.seed < 0)) {
    throw new ScenarioSourceError('Scenario seed must be a non-negative integer')
  }
  return new ScenarioBuilder({ ...definition, clients: [...definition.clients] })
}

const parameterized = <const TParameters extends ScenarioParameters>(
  parameters: TParameters,
  make: (parameters: DecodedParameters<TParameters>) => ScenarioPlan,
): ParameterizedScenario<TParameters> => ({ _tag: 'ParameterizedScenario', parameters, make })

export const Scenario = { start, parameterized }

export const normalizeScenario = (source: ScenarioSource, options: NormalizeScenarioOptions): ScenarioAst => {
  assertIdentifier(options.id, 'Scenario')
  const plan =
    source._tag === 'ParameterizedScenario'
      ? source.make(decodeParameters(source.parameters, options.parameters ?? {}))
      : assertNoParameterOverrides(source, options.parameters)
  return normalizePlan(plan, options)
}

export const scenarioIdFromFileName = (fileName: string): string => {
  const baseName = fileName.split(/[\\/]/).at(-1) ?? fileName
  if (baseName.endsWith('.scenario.ts') === false) {
    throw new ScenarioSourceError(`Scenario source must use the .scenario.ts extension: ${fileName}`)
  }
  const id = baseName.slice(0, -'.scenario.ts'.length)
  assertIdentifier(id, 'filename-derived Scenario')
  return id
}

const assertNoParameterOverrides = (
  source: ScenarioPlan,
  parameters: Readonly<Record<string, string | number | boolean>> | undefined,
): ScenarioPlan => {
  const names = Object.keys(parameters ?? {})
  if (names.length > 0) throw new ScenarioSourceError(`Unknown parameter override '${names[0]}'`)
  return source
}

const decodeParameters = <TParameters extends ScenarioParameters>(
  definitions: TParameters,
  overrides: Readonly<Record<string, string | number | boolean>>,
): DecodedParameters<TParameters> => {
  for (const name of Object.keys(overrides)) {
    if (definitions[name] === undefined) throw new ScenarioSourceError(`Unknown parameter override '${name}'`)
  }
  return Object.fromEntries(
    Object.entries(definitions).map(([name, definition]) => {
      const value = overrides[name] ?? definition.default
      if (definition.kind === 'string') {
        if (typeof value !== 'string') throw new ScenarioSourceError(`Parameter '${name}' must be a string`)
        return [name, value]
      }
      if (definition.kind === 'boolean') {
        if (value === true || value === 'true') return [name, true]
        if (value === false || value === 'false') return [name, false]
        throw new ScenarioSourceError(`Parameter '${name}' must be a boolean`)
      }
      const decoded = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
      if (
        Number.isFinite(decoded) === false ||
        (definition.kind === 'integer' && Number.isInteger(decoded) === false)
      ) {
        throw new ScenarioSourceError(
          `Parameter '${name}' must be ${definition.kind === 'integer' ? 'an integer' : 'a number'}`,
        )
      }
      return [name, decoded]
    }),
  ) as DecodedParameters<TParameters>
}

interface ClientState {
  readonly sessions: Map<string, 'running' | 'stopped'>
}

const normalizePlan = (plan: ScenarioPlan, options: NormalizeScenarioOptions): ScenarioAst => {
  const effectiveSeed = options.seed ?? plan.start.seed ?? 0
  if (Number.isInteger(effectiveSeed) === false || effectiveSeed < 0) {
    throw new ScenarioSourceError('Scenario seed must be a non-negative integer')
  }
  const clients = new Map<string, ClientState>()
  const initialClients = plan.start.clients.map((definition) => {
    registerClient(clients, definition)
    return {
      id: definition.id,
      sessions: definition.sessions.map(({ sessionId }) => sessionId),
      initiallyConnected: definition.initiallyConnected,
    }
  })
  const instructions: ScenarioInstruction[] = []
  const oracles: ScenarioOracle[] = []
  const counts = new Map<string, number>()
  let oracleCount = 0
  const nextId = (kind: string) => {
    const count = (counts.get(kind) ?? 0) + 1
    counts.set(kind, count)
    return `${kind}-${pad(count, 4)}`
  }
  const nextOracleId = () => `oracle-${pad(++oracleCount, 4)}`

  const requireClient = (target: ScenarioClient): ClientState => {
    const state = clients.get(target.id)
    if (state === undefined) throw new ScenarioSourceError(`Unknown Client '${target.id}' at this source position`)
    return state
  }
  const requireSession = (target: ScenarioSession, allowStopped = false): ParticipantRef => {
    const state = clients.get(target.clientId)?.sessions.get(target.sessionId)
    if (state === undefined)
      throw new ScenarioSourceError(`Unknown participant '${participantKey(target)}' at this source position`)
    if (state === 'stopped' && allowStopped === false) {
      throw new ScenarioSourceError(`Participant '${participantKey(target)}' is stopped at this source position`)
    }
    return { clientId: target.clientId, sessionId: target.sessionId }
  }
  const requireStoppedSession = (target: ScenarioSession): ParticipantRef => {
    const state = clients.get(target.clientId)?.sessions.get(target.sessionId)
    if (state === undefined)
      throw new ScenarioSourceError(`Unknown participant '${participantKey(target)}' at this source position`)
    if (state !== 'stopped') {
      throw new ScenarioSourceError(`Participant '${participantKey(target)}' is running at this source position`)
    }
    return { clientId: target.clientId, sessionId: target.sessionId }
  }
  const selection = (value: ScenarioParticipantSelection, allowStopped = false): ReadonlyArray<ParticipantRef> => {
    const members = value._tag === 'ScenarioAlias' ? value.members : [value]
    if (members.length === 0) throw new ScenarioSourceError('Participant selection cannot be empty')
    return members.map((member) => requireSession(member, allowStopped))
  }
  const runningParticipants = (): ReadonlyArray<ParticipantRef> =>
    [...clients].flatMap(([clientId, state]) =>
      [...state.sessions].flatMap(([sessionId, status]) => (status === 'running' ? [{ clientId, sessionId }] : [])),
    )
  const compileAction = (spec: ActionSpec, id: string) => {
    if (spec.application.id !== plan.start.application.definition.id) {
      throw new ScenarioSourceError(
        `Action '${spec.action}' belongs to ${spec.application.scenarioName}, not ${plan.start.application.definition.scenarioName}`,
      )
    }
    const action = plan.start.application.definition.actions[spec.action]
    if (action === undefined) throw new ScenarioSourceError(`Unknown action '${spec.action}'`)
    try {
      action.validateInput(spec.input)
    } catch (cause) {
      throw new ScenarioSourceError(
        `Invalid input for action '${spec.action}': ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
    return { _tag: 'action' as const, id, target: requireSession(spec.target), action: spec.action, input: spec.input }
  }
  const compileParallel = (spec: ParallelSpec, id: string): ParallelOperationStep => {
    switch (spec._tag) {
      case 'action':
        return compileAction(spec, id)
      case 'disconnect':
      case 'reconnect':
        requireClient(spec.client)
        return { _tag: spec._tag, id, clientId: spec.client.id }
      case 'stop-session':
        return { _tag: 'stop-session', id, target: requireSession(spec.target) }
      case 'restart-session':
        return { _tag: 'restart-session', id, target: requireStoppedSession(spec.target) }
      case 'restart-client':
        requireClient(spec.client)
        return { _tag: 'restart-client', id, clientId: spec.client.id }
      case 'backend-unavailable':
      case 'backend-available':
        return { _tag: spec._tag, id }
    }
  }
  const applyParallelLifecycleTransitions = (operations: ReadonlyArray<ParallelOperationStep>): void => {
    const sessionTransitions = new Map<
      string,
      { readonly target: ParticipantRef; readonly status: 'running' | 'stopped' }
    >()
    const restartedClients = new Set<string>()

    for (const operation of operations) {
      if (operation._tag === 'restart-client') {
        if (
          restartedClients.has(operation.clientId) === true ||
          [...sessionTransitions.values()].some(({ target }) => target.clientId === operation.clientId)
        ) {
          throw new ScenarioSourceError(`Parallel lifecycle operations conflict for Client '${operation.clientId}'`)
        }
        restartedClients.add(operation.clientId)
      } else if (operation._tag === 'stop-session' || operation._tag === 'restart-session') {
        const key = participantKey(operation.target)
        if (sessionTransitions.has(key) === true || restartedClients.has(operation.target.clientId) === true) {
          throw new ScenarioSourceError(`Parallel lifecycle operations conflict for participant '${key}'`)
        }
        sessionTransitions.set(key, {
          target: operation.target,
          status: operation._tag === 'restart-session' ? 'running' : 'stopped',
        })
      }
    }

    for (const clientId of restartedClients) {
      const state = clients.get(clientId)!
      for (const sessionId of state.sessions.keys()) state.sessions.set(sessionId, 'running')
    }
    for (const { target, status } of sessionTransitions.values()) {
      clients.get(target.clientId)!.sessions.set(target.sessionId, status)
    }
  }
  const addHistoryOracle = (operationIds: ReadonlyArray<string>, requireOverlap: boolean, allowIndefinite: boolean) => {
    oracles.push({
      _tag: 'operation-history',
      id: nextOracleId(),
      operationIds: [...operationIds],
      requireOverlap,
      allowIndefinite,
    })
  }

  for (const spec of plan.instructions) {
    switch (spec._tag) {
      case 'annotation':
        instructions.push({ _tag: 'annotation', id: nextId('note'), text: spec.text })
        break
      case 'wait':
        instructions.push({ _tag: 'wait', id: nextId('wait'), durationMs: spec.durationMs })
        break
      case 'action':
        instructions.push(compileAction(spec, nextId('action')))
        break
      case 'disconnect':
      case 'reconnect':
        requireClient(spec.client)
        instructions.push({ _tag: spec._tag, id: nextId(spec._tag), clientId: spec.client.id })
        break
      case 'backend-unavailable':
      case 'backend-available':
        instructions.push({ _tag: spec._tag, id: nextId(spec._tag) })
        break
      case 'stop-session':
      case 'restart-session': {
        const state = spec._tag === 'restart-session' ? requireStoppedSession(spec.target) : requireSession(spec.target)
        clients
          .get(spec.target.clientId)!
          .sessions.set(spec.target.sessionId, spec._tag === 'restart-session' ? 'running' : 'stopped')
        instructions.push({ _tag: spec._tag, id: nextId(spec._tag), target: state })
        break
      }
      case 'restart-client': {
        const state = requireClient(spec.client)
        for (const sessionId of state.sessions.keys()) state.sessions.set(sessionId, 'running')
        instructions.push({ _tag: 'restart-client', id: nextId('restart-client'), clientId: spec.client.id })
        break
      }
      case 'create-client':
        registerClient(clients, spec.client)
        instructions.push({
          _tag: 'create-client',
          id: nextId('create-client'),
          client: {
            id: spec.client.id,
            sessions: spec.client.sessions.map(({ sessionId }) => sessionId),
            initiallyConnected: spec.client.initiallyConnected,
          },
        })
        break
      case 'add-session': {
        const owner = clients.get(spec.target.clientId)
        if (owner === undefined)
          throw new ScenarioSourceError(`Unknown Client '${spec.target.clientId}' at this source position`)
        if (owner.sessions.has(spec.target.sessionId) === true) {
          throw new ScenarioSourceError(`Duplicate participant '${participantKey(spec.target)}'`)
        }
        owner.sessions.set(spec.target.sessionId, 'running')
        instructions.push({
          _tag: 'add-session',
          id: nextId('add-session'),
          target: { clientId: spec.target.clientId, sessionId: spec.target.sessionId },
        })
        break
      }
      case 'settle':
        spec.reconnect.forEach(requireClient)
        instructions.push({
          _tag: 'settle',
          id: nextId('settle'),
          participants: selection(spec.participants, true),
          healDisconnectedClients: spec.reconnect.map(({ id }) => id),
        })
        break
      case 'parallel': {
        const parallelId = nextId('concurrently')
        const operations = spec.operations.map((operation, index) =>
          compileParallel(operation, `${parallelId}:operation-${pad(index + 1, 4)}`),
        )
        applyParallelLifecycleTransitions(operations)
        instructions.push({ _tag: 'parallel', id: parallelId, operations })
        if (spec.requirement !== undefined) {
          const requirement =
            typeof spec.requirement === 'string'
              ? { operations: spec.requirement, allowIndefinite: false }
              : { ...spec.requirement, allowIndefinite: spec.requirement.allowIndefinite ?? false }
          addHistoryOracle(
            operations.map(({ id }) => id),
            requirement.operations === 'overlap',
            requirement.allowIndefinite,
          )
        }
        break
      }
      case 'action-sequence': {
        const sequenceId = nextId(spec.kind)
        const sequenceSeed = hashString(`${effectiveSeed}\u0000${sequenceId}`)
        let randomUsed = false
        const random: ScenarioRandomSource = {
          iteration: (iteration) => {
            randomUsed = true
            if (Number.isInteger(iteration) === false || iteration <= 0) {
              throw new ScenarioSourceError(`Scenario random iteration must be a positive integer: ${iteration}`)
            }
            return makeScenarioRandom(sequenceSeed, iteration)
          },
        }
        const authoredActions = typeof spec.actions === 'function' ? spec.actions({ random }) : spec.actions
        if (authoredActions.length === 0 || authoredActions.length > 10_000) {
          throw new ScenarioSourceError('Action sequence must contain between 1 and 10000 actions')
        }
        if ((randomUsed as boolean) === true && plan.start.seed === undefined && options.seed === undefined) {
          throw new ScenarioSourceError('Deterministic random generation requires an explicit Scenario seed')
        }
        const actions = authoredActions.map((action, index) =>
          compileAction(action.spec, `${sequenceId}:${pad(index + 1, 4)}`),
        )
        instructions.push({
          _tag: 'action-sequence',
          id: sequenceId,
          description:
            spec.description ??
            (spec.kind === 'repeat'
              ? `Repeat ${actions[0]!.action} ${actions.length} times`
              : `Generate ${actions.length} actions`),
          seed: sequenceSeed,
          delayBetweenActionsMs: spec.delayBetweenActionsMs,
          actions,
        })
        if (spec.requirement !== undefined) {
          const requirement =
            typeof spec.requirement === 'string'
              ? {
                  finish: spec.requirement.replace(/-finish$/, '') as 'all' | 'first' | 'last' | 'first-and-last',
                  allowIndefinite: false,
                }
              : { ...spec.requirement, allowIndefinite: spec.requirement.allowIndefinite ?? false }
          const selected =
            requirement.finish === 'all'
              ? actions
              : requirement.finish === 'first'
                ? [actions[0]!]
                : requirement.finish === 'last'
                  ? [actions.at(-1)!]
                  : actions.length === 1
                    ? [actions[0]!]
                    : [actions[0]!, actions.at(-1)!]
          addHistoryOracle(
            selected.map(({ id }) => id),
            false,
            requirement.allowIndefinite,
          )
        }
        break
      }
    }
  }

  const finalParticipants = runningParticipants()
  const expectationSpecs = plan.expectations ?? [pendingResolved() as OracleSpec, eventlogsConverge() as OracleSpec]
  for (const spec of expectationSpecs) {
    const participants = spec.participants === undefined ? finalParticipants : selection(spec.participants)
    if (participants.length === 0)
      throw new ScenarioSourceError('Final expectations require at least one running session')
    switch (spec._tag) {
      case 'pending-resolution':
      case 'eventlog-convergence':
        oracles.push({ _tag: spec._tag, id: nextOracleId(), participants })
        break
      case 'state-convergence':
        assertInspector(plan.start.application, spec.inspector)
        oracles.push({ _tag: 'state-convergence', id: nextOracleId(), participants, inspector: spec.inspector })
        break
      case 'state-contains-ids':
        assertInspector(plan.start.application, spec.inspector)
        oracles.push({
          _tag: 'state-contains-ids',
          id: nextOracleId(),
          participants,
          inspector: spec.inspector,
          expectedIds: [...(spec.expectedIds ?? [])],
        })
        break
    }
  }

  return defineScenario({
    version: scenarioVersion,
    id: options.id,
    description: plan.start.about ?? '',
    tags: [],
    seed: effectiveSeed,
    applicationId: plan.start.application.definition.id,
    requires: [],
    topology: { storeId: `scenario-${options.id}`, clients: initialClients },
    instructions,
    oracles,
  })
}

const registerClient = (clients: Map<string, ClientState>, definition: ScenarioClient): void => {
  const id = definition.id
  if (clients.has(id) === true) throw new ScenarioSourceError(`Duplicate Client '${id}'`)
  if (definition.sessions.length === 0) throw new ScenarioSourceError(`Client ${id} must declare at least one session`)
  const sessions = new Map<string, 'running' | 'stopped'>()
  for (const participant of definition.sessions) {
    if (sessions.has(participant.sessionId) === true) {
      throw new ScenarioSourceError(`Duplicate participant '${participantKey(participant)}'`)
    }
    sessions.set(participant.sessionId, 'running')
  }
  clients.set(id, { sessions })
}

const assertInspector: (
  application: ScenarioApplicationReference,
  inspector: string | undefined,
) => asserts inspector is string = (application, inspector) => {
  if (inspector === undefined || application.definition.inspectors[inspector] === undefined) {
    throw new ScenarioSourceError(
      `Unknown inspector '${String(inspector)}' for application '${application.definition.scenarioName}'`,
    )
  }
}

const compileDuration = (duration: string | number): number => {
  if (typeof duration === 'number') {
    if (Number.isInteger(duration) === false || duration <= 0) {
      throw new ScenarioSourceError(`Duration must be a positive integer number of milliseconds: ${duration}`)
    }
    return duration
  }
  return parseScenarioDurationMs(duration)
}

const makeScenarioRandom = (seed: number, iteration: number): ScenarioRandom => {
  const next = (key: string): number => hashString(`${seed}\u0000${iteration}\u0000${key}`) / 4_294_967_296
  return {
    next,
    integer: (key, maximumExclusive) => {
      if (Number.isInteger(maximumExclusive) === false || maximumExclusive <= 0) {
        throw new ScenarioSourceError(`Scenario random integer bound must be a positive integer: ${maximumExclusive}`)
      }
      return Math.floor(next(key) * maximumExclusive)
    },
    pick: <T>(key: string, values: ReadonlyArray<T>): T => {
      if (values.length === 0) throw new ScenarioSourceError(`Scenario random choice '${key}' requires a value`)
      return values[Math.floor(next(key) * values.length)]!
    },
  }
}

const hashString = (input: string): number => {
  let hash = 2_166_136_261
  for (const character of input) hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619)
  return hash >>> 0
}

export const pad = (value: string | number, width: number): string => String(value).padStart(width, '0')

const participantKey = ({ clientId, sessionId }: ParticipantRef): string => `${clientId}/${sessionId}`

const assertIdentifier = (value: string, label: string): void => {
  if (identifier.test(value) === false) throw new ScenarioSourceError(`Invalid ${label} identifier '${value}'`)
}

const assertJson = (value: unknown, label: string): Schema.Json => {
  if (isJson(value) === true) return value
  throw new ScenarioSourceError(`${label} must be JSON`)
}

const isJson = (value: unknown): value is Schema.Json => {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return true
  if (Array.isArray(value) === true) return value.every(isJson)
  return typeof value === 'object' && Object.values(value).every(isJson)
}
