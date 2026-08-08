import { LineCounter, parseAllDocuments } from 'yaml'

import type { Schema } from '@livestore/utils/effect'

import type {
  GeneratedScenarioAction,
  ScenarioGeneratorContext,
  ScenarioGeneratorRandom,
} from '../application/definition.ts'
import type { RegisteredApplication } from '../corpus/applications/registry.ts'
import {
  defineScenario,
  type ParallelOperationStep,
  type ParticipantRef,
  scenarioVersion,
  type ScenarioAst,
  type ScenarioInstruction,
  type ScenarioOracle,
} from '../model.ts'

export interface ScenarioCompileOptions {
  readonly fileName: string
  readonly source: string
  readonly applications: ReadonlyArray<RegisteredApplication>
  readonly parameters?: Readonly<Record<string, string | number | boolean>>
  readonly seed?: number
}

export class ScenarioYamlError extends Error {
  readonly _tag = 'ScenarioYamlError'

  constructor(
    readonly fileName: string,
    readonly path: string,
    message: string,
  ) {
    super(`${fileName}:${path}: ${message}`)
    this.name = 'ScenarioYamlError'
  }
}

interface ParameterDefinition {
  readonly type: 'integer' | 'number' | 'string' | 'boolean'
  readonly value: string | number | boolean
}

interface ClientState {
  readonly sessions: Map<string, 'running' | 'stopped'>
  connected: boolean
}

interface RepeatExpectation {
  readonly selection: 'all' | 'first' | 'last' | 'first-and-last'
  readonly allowIndefinite: boolean
}

const identifier = /^[A-Za-z][A-Za-z0-9_-]*$/
const participant = /^([A-Za-z][A-Za-z0-9_-]*)\/([A-Za-z][A-Za-z0-9_-]*)$/
const topLevelKeys = ['application', 'about', 'seed', 'parameters', 'clients', 'participants', 'do', 'expect']

export const compileScenarioYamlSource = (options: ScenarioCompileOptions): ScenarioAst =>
  new ScenarioYamlCompiler(options).compile()

class ScenarioYamlCompiler {
  readonly #options: ScenarioCompileOptions
  readonly #scenarioId: string
  readonly #document: Record<string, unknown>
  readonly #parameters = new Map<string, ParameterDefinition>()
  readonly #values = new Map<string, unknown>()
  readonly #aliases = new Map<string, ReadonlyArray<ParticipantRef>>()
  readonly #clients = new Map<string, ClientState>()
  readonly #initialClients: Array<{ id: string; sessions: string[]; initiallyConnected: boolean }> = []
  readonly #instructions: ScenarioInstruction[] = []
  readonly #oracles: ScenarioOracle[] = []
  readonly #instructionCounts = new Map<string, number>()
  #oracleCount = 0
  #application: RegisteredApplication
  #hasExplicitSeed: boolean
  #seed: number

  constructor(options: ScenarioCompileOptions) {
    this.#options = options
    const fileName = options.fileName.split(/[\\/]/).at(-1) ?? options.fileName
    if (fileName.endsWith('.scenario.yaml') === false) {
      throw new ScenarioYamlError(options.fileName, '$', 'Scenario source must use the .scenario.yaml extension')
    }
    this.#scenarioId = fileName.slice(0, -'.scenario.yaml'.length)
    if (identifier.test(this.#scenarioId) === false) {
      throw new ScenarioYamlError(options.fileName, '$', `Invalid filename-derived Scenario ID '${this.#scenarioId}'`)
    }
    this.#document = parseYamlDocument(options.fileName, options.source)
    this.#assertKeys(this.#document, topLevelKeys, '$')

    this.#compileParameters(this.#document.parameters)
    this.#assertParameterOverrides()
    this.#hasExplicitSeed = this.#options.seed !== undefined || this.#document.seed !== undefined
    this.#seed = this.#compileSeed(this.#document.seed)
    this.#application = this.#compileApplication(this.#document.application)
  }

  compile(): ScenarioAst {
    this.#compileInitialClients(this.#document.clients)
    this.#compileAliases(this.#document.participants, '$.participants')

    const instructions = this.#array(this.#document.do, '$.do')
    for (let index = 0; index < instructions.length; index += 1) {
      this.#compileInstruction(instructions[index], `$.do[${index}]`)
    }

    if (this.#document.expect === undefined) this.#addDefaultOracles()
    else this.#compileExpectations(this.#document.expect)

    const description =
      this.#document.about === undefined ? '' : this.#resolveString(this.#document.about, '$.about', this.#values)

    return defineScenario({
      version: scenarioVersion,
      id: this.#scenarioId,
      description,
      tags: [],
      seed: this.#seed,
      applicationId: this.#application.id,
      requires: [],
      topology: { storeId: `scenario-${this.#scenarioId}`, clients: this.#initialClients },
      instructions: this.#instructions,
      oracles: this.#oracles,
    })
  }

  #compileApplication(value: unknown): RegisteredApplication {
    const name = this.#string(value, '$.application')
    const application = this.#options.applications.find((candidate) => candidate.scenarioName === name)
    if (application !== undefined) return application
    this.#fail(
      '$.application',
      `Unknown application '${name}'. Expected: ${this.#options.applications
        .map(({ scenarioName }) => scenarioName)
        .join(', ')}`,
    )
  }

  #compileSeed(value: unknown): number {
    const seed = this.#options.seed ?? value ?? 0
    if (typeof seed !== 'number' || Number.isInteger(seed) === false || seed < 0) {
      this.#fail('$.seed', 'Seed must be a non-negative integer')
    }
    return seed
  }

  #compileParameters(value: unknown): void {
    if (value === undefined) return
    const parameters = this.#record(value, '$.parameters')
    for (const [name, rawDefinition] of Object.entries(parameters)) {
      this.#assertIdentifier(name, `$.parameters.${name}`)
      const path = `$.parameters.${name}`
      const definition = this.#record(rawDefinition, path)
      this.#assertKeys(definition, ['type', 'default'], path)
      const type = this.#string(definition.type, `${path}.type`)
      if (type !== 'integer' && type !== 'number' && type !== 'string' && type !== 'boolean') {
        this.#fail(`${path}.type`, `Unknown parameter type '${type}'`)
      }
      if (definition.default === undefined) this.#fail(`${path}.default`, 'Parameter default is required')
      const parameterType = type as ParameterDefinition['type']
      const parameterValue = this.#decodeParameter(
        parameterType,
        this.#options.parameters?.[name] ?? definition.default,
        `${path}.default`,
      )
      this.#parameters.set(name, { type: parameterType, value: parameterValue })
      this.#values.set(name, parameterValue)
    }
  }

  #decodeParameter(type: ParameterDefinition['type'], value: unknown, path: string): string | number | boolean {
    if (type === 'string') {
      if (typeof value !== 'string') this.#fail(path, `Expected string parameter value, received ${typeof value}`)
      return value
    }
    if (type === 'boolean') {
      if (value === true || value === 'true') return true
      if (value === false || value === 'false') return false
      this.#fail(path, `Expected boolean parameter value, received '${String(value)}'`)
    }
    const decoded = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
    if (Number.isFinite(decoded) === false || (type === 'integer' && Number.isInteger(decoded) === false)) {
      this.#fail(path, `Expected ${type} parameter value, received '${String(value)}'`)
    }
    return decoded
  }

  #assertParameterOverrides(): void {
    for (const name of Object.keys(this.#options.parameters ?? {})) {
      if (this.#parameters.has(name) === false) this.#fail('$.parameters', `Unknown parameter override '${name}'`)
    }
  }

  #compileInitialClients(value: unknown): void {
    const clients = this.#record(value, '$.clients')
    if (Object.keys(clients).length === 0) this.#fail('$.clients', 'At least one initial Client is required')
    for (const [clientId, rawDefinition] of Object.entries(clients)) {
      const path = `$.clients.${clientId}`
      this.#assertIdentifier(clientId, path)
      const definition = this.#record(rawDefinition, path)
      this.#assertKeys(definition, ['sessions', 'connected'], path)
      const sessions = this.#stringArray(definition.sessions, `${path}.sessions`)
      const connected =
        definition.connected === undefined ? true : this.#boolean(definition.connected, `${path}.connected`)
      this.#registerClient(clientId, sessions, connected, true, path)
    }
  }

  #registerClient(
    clientId: string,
    sessions: ReadonlyArray<string>,
    connected: boolean,
    initial: boolean,
    path: string,
  ): void {
    if (this.#clients.has(clientId) === true) this.#fail(path, `Duplicate Client '${clientId}'`)
    if (sessions.length === 0) this.#fail(`${path}.sessions`, `Client ${clientId} must declare at least one session`)
    const uniqueSessions = new Set<string>()
    for (const sessionId of sessions) {
      this.#assertIdentifier(sessionId, `${path}.sessions`)
      if (uniqueSessions.has(sessionId) === true) this.#fail(`${path}.sessions`, `Duplicate session '${sessionId}'`)
      uniqueSessions.add(sessionId)
    }
    this.#clients.set(clientId, {
      sessions: new Map(sessions.map((sessionId) => [sessionId, 'running' as const])),
      connected,
    })
    if (initial === true) {
      this.#initialClients.push({ id: clientId, sessions: [...sessions], initiallyConnected: connected })
    }
  }

  #compileAliases(value: unknown, path: string): void {
    if (value === undefined) return
    const aliases = this.#record(value, path)
    for (const [name, selection] of Object.entries(aliases)) {
      const aliasPath = `${path}.${name}`
      this.#assertIdentifier(name, aliasPath)
      if (this.#aliases.has(name) === true) this.#fail(aliasPath, `Duplicate participant group '${name}'`)
      const participants = this.#resolveParticipantSelection(selection, aliasPath, false)
      if (participants.length === 0) this.#fail(aliasPath, 'Participant group cannot be empty')
      this.#aliases.set(name, participants)
      this.#values.set(name, participants)
    }
  }

  #compileInstruction(value: unknown, path: string): void {
    const instruction = this.#record(value, path)
    if ('run' in instruction) {
      this.#assertKeys(instruction, ['run', 'as', 'with'], path)
      this.#instructions.push(this.#compileAction(instruction, this.#values, this.#nextId('action'), path))
      return
    }
    if ('note' in instruction) {
      this.#assertKeys(instruction, ['note'], path)
      this.#instructions.push({
        _tag: 'annotation',
        id: this.#nextId('note'),
        text: this.#resolveString(instruction.note, `${path}.note`, this.#values),
      })
      return
    }
    if ('disconnect' in instruction || 'reconnect' in instruction) {
      const kind = 'disconnect' in instruction ? 'disconnect' : 'reconnect'
      this.#assertKeys(instruction, [kind], path)
      const clientId = this.#string(instruction[kind], `${path}.${kind}`)
      const client = this.#requireClient(clientId, `${path}.${kind}`)
      client.connected = kind === 'reconnect'
      this.#instructions.push({ _tag: kind, id: this.#nextId(kind), clientId })
      return
    }
    if ('backend' in instruction) {
      this.#assertKeys(instruction, ['backend'], path)
      const availability = this.#string(instruction.backend, `${path}.backend`)
      if (availability !== 'available' && availability !== 'unavailable') {
        this.#fail(`${path}.backend`, "Expected 'available' or 'unavailable'")
      }
      const kind = availability === 'available' ? 'backend-available' : 'backend-unavailable'
      this.#instructions.push({ _tag: kind, id: this.#nextId(kind) })
      return
    }
    if ('stopSession' in instruction || 'restartSession' in instruction) {
      const sourceKey = 'stopSession' in instruction ? 'stopSession' : 'restartSession'
      this.#assertKeys(instruction, [sourceKey], path)
      const restarting = sourceKey === 'restartSession'
      const target = this.#resolveParticipant(
        this.#string(instruction[sourceKey], `${path}.${sourceKey}`),
        `${path}.${sourceKey}`,
        restarting,
      )
      this.#clients.get(target.clientId)!.sessions.set(target.sessionId, restarting === true ? 'running' : 'stopped')
      const kind = restarting === true ? 'restart-session' : 'stop-session'
      this.#instructions.push({ _tag: kind, id: this.#nextId(kind), target })
      return
    }
    if ('restartClient' in instruction) {
      this.#assertKeys(instruction, ['restartClient'], path)
      const clientId = this.#string(instruction.restartClient, `${path}.restartClient`)
      const client = this.#requireClient(clientId, `${path}.restartClient`)
      for (const sessionId of client.sessions.keys()) client.sessions.set(sessionId, 'running')
      this.#instructions.push({ _tag: 'restart-client', id: this.#nextId('restart-client'), clientId })
      return
    }
    if ('createClient' in instruction) {
      this.#compileCreateClient(instruction, path)
      return
    }
    if ('addSession' in instruction) {
      this.#assertKeys(instruction, ['addSession'], path)
      const target = this.#parseParticipantReference(
        this.#string(instruction.addSession, `${path}.addSession`),
        `${path}.addSession`,
      )
      const client = this.#requireClient(target.clientId, `${path}.addSession`)
      if (client.sessions.has(target.sessionId) === true) {
        this.#fail(`${path}.addSession`, `Duplicate participant '${target.clientId}/${target.sessionId}'`)
      }
      client.sessions.set(target.sessionId, 'running')
      this.#instructions.push({ _tag: 'add-session', id: this.#nextId('add-session'), target })
      return
    }
    if ('participants' in instruction) {
      this.#assertKeys(instruction, ['participants'], path)
      this.#compileAliases(instruction.participants, `${path}.participants`)
      return
    }
    if ('settle' in instruction) {
      this.#compileSettlement(instruction, path)
      return
    }
    if ('wait' in instruction) {
      this.#assertKeys(instruction, ['wait'], path)
      this.#instructions.push({
        _tag: 'wait',
        id: this.#nextId('wait'),
        durationMs: this.#duration(instruction.wait, `${path}.wait`),
      })
      return
    }
    if ('concurrently' in instruction) {
      this.#compileConcurrent(instruction, path)
      return
    }
    if ('repeat' in instruction) {
      this.#assertKeys(instruction, ['repeat'], path)
      this.#compileRepeat(instruction.repeat, `${path}.repeat`)
      return
    }
    if ('generate' in instruction) {
      this.#compileGenerator(instruction, path)
      return
    }
    this.#fail(
      path,
      `Unknown instruction. Expected one of: run, note, disconnect, reconnect, backend, stopSession, restartSession, restartClient, createClient, addSession, participants, settle, wait, concurrently, repeat, generate`,
    )
  }

  #compileCreateClient(instruction: Record<string, unknown>, path: string): void {
    this.#assertKeys(instruction, ['createClient'], path)
    const definitionPath = `${path}.createClient`
    const definition = this.#record(instruction.createClient, definitionPath)
    this.#assertKeys(definition, ['id', 'sessions', 'connected'], definitionPath)
    const clientId = this.#string(definition.id, `${definitionPath}.id`)
    this.#assertIdentifier(clientId, `${definitionPath}.id`)
    const sessions = this.#stringArray(definition.sessions, `${definitionPath}.sessions`)
    const connected =
      definition.connected === undefined ? true : this.#boolean(definition.connected, `${definitionPath}.connected`)
    this.#registerClient(clientId, sessions, connected, false, definitionPath)
    this.#instructions.push({
      _tag: 'create-client',
      id: this.#nextId('create-client'),
      client: { id: clientId, sessions: [...sessions], initiallyConnected: connected },
    })
  }

  #compileSettlement(instruction: Record<string, unknown>, path: string): void {
    this.#assertKeys(instruction, ['settle'], path)
    const settlementPath = `${path}.settle`
    let selection: unknown = instruction.settle
    let reconnect: ReadonlyArray<string> = []
    if (isRecord(instruction.settle) === true) {
      const definition = instruction.settle
      this.#assertKeys(definition, ['participants', 'reconnect'], settlementPath)
      selection = definition.participants
      reconnect =
        definition.reconnect === undefined ? [] : this.#stringArray(definition.reconnect, `${settlementPath}.reconnect`)
    }
    const participants = this.#resolveParticipantSelection(selection, `${settlementPath}.participants`, true)
    for (const clientId of reconnect) this.#requireClient(clientId, `${settlementPath}.reconnect`).connected = true
    this.#instructions.push({
      _tag: 'settle',
      id: this.#nextId('settle'),
      participants,
      healDisconnectedClients: [...reconnect],
    })
  }

  #compileConcurrent(instruction: Record<string, unknown>, path: string): void {
    this.#assertKeys(instruction, ['concurrently', 'expect'], path)
    const operationsSource = this.#array(instruction.concurrently, `${path}.concurrently`)
    if (operationsSource.length < 2) this.#fail(`${path}.concurrently`, 'Concurrency requires at least two operations')
    const parallelId = this.#nextId('concurrently')
    const operations = operationsSource.map((operation, index) =>
      this.#compileParallelOperation(
        operation,
        `${parallelId}:operation-${pad(index + 1, 4)}`,
        `${path}.concurrently[${index}]`,
      ),
    )
    this.#instructions.push({ _tag: 'parallel', id: parallelId, operations })

    if (instruction.expect !== undefined) {
      const expectation = this.#parseConcurrentExpectation(instruction.expect, `${path}.expect`)
      this.#oracles.push({
        _tag: 'operation-history',
        id: this.#nextOracleId(),
        operationIds: operations.map(({ id }) => id),
        requireOverlap: expectation.requireOverlap,
        allowIndefinite: expectation.allowIndefinite,
      })
    }
  }

  #compileParallelOperation(value: unknown, id: string, path: string): ParallelOperationStep {
    const operation = this.#record(value, path)
    if ('run' in operation) {
      this.#assertKeys(operation, ['run', 'as', 'with'], path)
      return this.#compileAction(operation, this.#values, id, path)
    }
    if ('disconnect' in operation || 'reconnect' in operation) {
      const kind = 'disconnect' in operation ? 'disconnect' : 'reconnect'
      this.#assertKeys(operation, [kind], path)
      const clientId = this.#string(operation[kind], `${path}.${kind}`)
      this.#requireClient(clientId, `${path}.${kind}`)
      return { _tag: kind, id, clientId }
    }
    if ('backend' in operation) {
      this.#assertKeys(operation, ['backend'], path)
      const availability = this.#string(operation.backend, `${path}.backend`)
      if (availability === 'available') return { _tag: 'backend-available', id }
      if (availability === 'unavailable') return { _tag: 'backend-unavailable', id }
      this.#fail(`${path}.backend`, "Expected 'available' or 'unavailable'")
    }
    if ('stopSession' in operation || 'restartSession' in operation) {
      const sourceKey = 'stopSession' in operation ? 'stopSession' : 'restartSession'
      this.#assertKeys(operation, [sourceKey], path)
      const restarting = sourceKey === 'restartSession'
      return {
        _tag: restarting === true ? 'restart-session' : 'stop-session',
        id,
        target: this.#resolveParticipant(
          this.#string(operation[sourceKey], `${path}.${sourceKey}`),
          `${path}.${sourceKey}`,
          restarting,
        ),
      }
    }
    if ('restartClient' in operation) {
      this.#assertKeys(operation, ['restartClient'], path)
      const clientId = this.#string(operation.restartClient, `${path}.restartClient`)
      this.#requireClient(clientId, `${path}.restartClient`)
      return { _tag: 'restart-client', id, clientId }
    }
    this.#fail(path, 'Unsupported concurrent operation')
  }

  #parseConcurrentExpectation(
    value: unknown,
    path: string,
  ): { readonly requireOverlap: boolean; readonly allowIndefinite: boolean } {
    if (typeof value === 'string') {
      if (value === 'overlap') return { requireOverlap: true, allowIndefinite: false }
      if (value === 'all-finish') return { requireOverlap: false, allowIndefinite: false }
      this.#fail(path, "Expected 'overlap' or 'all-finish'")
    }
    const expectation = this.#record(value, path)
    this.#assertKeys(expectation, ['operations', 'allowIndefinite'], path)
    const parsed = this.#parseConcurrentExpectation(expectation.operations, `${path}.operations`)
    return {
      ...parsed,
      allowIndefinite:
        expectation.allowIndefinite === undefined
          ? false
          : this.#boolean(expectation.allowIndefinite, `${path}.allowIndefinite`),
    }
  }

  #compileRepeat(value: unknown, path: string): void {
    const repeat = this.#record(value, path)
    this.#assertKeys(repeat, ['times', 'as', 'between', 'action', 'expect'], path)
    const count = this.#integer(this.#resolveValue(repeat.times, `${path}.times`, this.#values), `${path}.times`)
    if (count <= 0 || count > 10_000) this.#fail(`${path}.times`, 'Repeat count must be between 1 and 10000')
    const variable = this.#string(repeat.as, `${path}.as`)
    this.#assertIdentifier(variable, `${path}.as`)
    if (this.#values.has(variable) === true)
      this.#fail(`${path}.as`, `Repeat variable '${variable}' is already defined`)

    const repeatId = this.#nextId('repeat')
    const sequenceSeed = hashString(`${this.#seed}\u0000${repeatId}`)
    const action = this.#record(repeat.action, `${path}.action`)
    this.#assertKeys(action, ['run', 'as', 'with'], `${path}.action`)
    const actions = Array.from({ length: count }, (_, offset) => {
      const values = new Map(this.#values)
      values.set(variable, offset + 1)
      return this.#compileAction(action, values, `${repeatId}:${pad(offset + 1, 4)}`, `${path}.action`)
    })
    this.#instructions.push({
      _tag: 'action-sequence',
      id: repeatId,
      description: `Repeat ${this.#string(action.run, `${path}.action.run`)} ${count} times`,
      seed: sequenceSeed,
      delayBetweenActionsMs: repeat.between === undefined ? null : this.#duration(repeat.between, `${path}.between`),
      actions,
    })
    if (repeat.expect !== undefined) {
      this.#addSequenceExpectation(actions, this.#parseRepeatExpectation(repeat.expect, `${path}.expect`))
    }
  }

  #compileGenerator(instruction: Record<string, unknown>, path: string): void {
    this.#assertKeys(instruction, ['generate', 'with', 'between', 'expect'], path)
    const name = this.#string(instruction.generate, `${path}.generate`)
    const generator = this.#application.scenarioGenerators?.[name]
    if (generator === undefined) {
      this.#fail(`${path}.generate`, `Unknown generator '${name}' for application '${this.#application.scenarioName}'`)
    }
    const generatorInput = this.#resolveValue(instruction.with ?? {}, `${path}.with`, this.#values)
    if (isJson(generatorInput) === false) this.#fail(`${path}.with`, 'Generator input must resolve to JSON')
    const sequenceId = this.#nextId('generate')
    const sequenceSeed = hashString(`${this.#seed}\u0000${sequenceId}`)
    const randomUsage = { used: false }
    const context: ScenarioGeneratorContext = {
      random: {
        iteration: (iteration) => {
          randomUsage.used = true
          if (Number.isInteger(iteration) === false || iteration <= 0) {
            this.#fail(`${path}.generate`, `Generator random iteration must be a positive integer: ${iteration}`)
          }
          return makeScenarioRandom(sequenceSeed, iteration)
        },
      },
      participant: (reference) => this.#resolveParticipant(reference, `${path}.generate`, false),
      participants: (selection) => this.#resolveParticipantSelection(selection, `${path}.generate`, true),
    }

    let generated: ReadonlyArray<GeneratedScenarioAction>
    try {
      generated = generator.generate(generatorInput, context)
    } catch (cause) {
      if (cause instanceof ScenarioYamlError) throw cause
      this.#fail(
        `${path}.generate`,
        `Generator '${name}' failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
    if (randomUsage.used === true && this.#hasExplicitSeed === false) {
      this.#fail(`${path}.generate`, `Generator '${name}' uses deterministic randomness and requires an explicit seed`)
    }
    if (Array.isArray(generated) === false || generated.length === 0 || generated.length > 10_000) {
      this.#fail(`${path}.generate`, `Generator '${name}' must return between 1 and 10000 actions`)
    }
    const actions = generated.map((action, offset) =>
      this.#compileGeneratedAction(action, `${sequenceId}:${pad(offset + 1, 4)}`, `${path}.generate[${offset}]`),
    )
    this.#instructions.push({
      _tag: 'action-sequence',
      id: sequenceId,
      description: `Generate ${name} (${actions.length} actions)`,
      seed: sequenceSeed,
      delayBetweenActionsMs:
        instruction.between === undefined ? null : this.#duration(instruction.between, `${path}.between`),
      actions,
    })
    if (instruction.expect !== undefined) {
      this.#addSequenceExpectation(actions, this.#parseRepeatExpectation(instruction.expect, `${path}.expect`))
    }
  }

  #compileGeneratedAction(action: GeneratedScenarioAction, id: string, path: string) {
    if (isRecord(action) === false) this.#fail(path, 'Generated action must be an object')
    const target = action.target
    if (isParticipantRef(target) === false) this.#fail(`${path}.target`, 'Generated action target is invalid')
    this.#resolveParticipant(`${target.clientId}/${target.sessionId}`, `${path}.target`, false)
    if (typeof action.action !== 'string') this.#fail(`${path}.action`, 'Generated action name must be a string')
    if (isJson(action.input) === false) this.#fail(`${path}.input`, 'Generated action input must be JSON')
    this.#validateApplicationAction(action.action, action.input, path)
    return { _tag: 'action' as const, id, target, action: action.action, input: action.input }
  }

  #parseRepeatExpectation(value: unknown, path: string): RepeatExpectation {
    const decodeSelection = (selection: unknown, selectionPath: string): RepeatExpectation['selection'] => {
      const source = this.#string(selection, selectionPath).replace(/-finish$/, '')
      if (source === 'all' || source === 'first' || source === 'last' || source === 'first-and-last') return source
      this.#fail(selectionPath, "Expected 'all-finish', 'first-finish', 'last-finish', or 'first-and-last-finish'")
    }
    if (typeof value === 'string') return { selection: decodeSelection(value, path), allowIndefinite: false }
    const expectation = this.#record(value, path)
    this.#assertKeys(expectation, ['finish', 'allowIndefinite'], path)
    return {
      selection: decodeSelection(expectation.finish, `${path}.finish`),
      allowIndefinite:
        expectation.allowIndefinite === undefined
          ? false
          : this.#boolean(expectation.allowIndefinite, `${path}.allowIndefinite`),
    }
  }

  #addSequenceExpectation(actions: ReadonlyArray<{ readonly id: string }>, expectation: RepeatExpectation): void {
    const selected =
      expectation.selection === 'all'
        ? actions
        : expectation.selection === 'first'
          ? [actions[0]!]
          : expectation.selection === 'last'
            ? [actions.at(-1)!]
            : actions.length === 1
              ? [actions[0]!]
              : [actions[0]!, actions.at(-1)!]
    this.#oracles.push({
      _tag: 'operation-history',
      id: this.#nextOracleId(),
      operationIds: selected.map(({ id }) => id),
      requireOverlap: false,
      allowIndefinite: expectation.allowIndefinite,
    })
  }

  #compileAction(action: Record<string, unknown>, values: ReadonlyMap<string, unknown>, id: string, path: string) {
    const actionName = this.#string(action.run, `${path}.run`)
    const targetSource = this.#resolveString(action.as, `${path}.as`, values)
    const target = this.#resolveParticipant(targetSource, `${path}.as`, false)
    const input = this.#resolveValue(action.with ?? {}, `${path}.with`, values)
    if (isJson(input) === false) this.#fail(`${path}.with`, 'Application action input must resolve to JSON')
    this.#validateApplicationAction(actionName, input, path)
    return { _tag: 'action' as const, id, target, action: actionName, input }
  }

  #validateApplicationAction(actionName: string, input: Schema.Json, path: string): void {
    const action = this.#application.actions[actionName]
    if (action === undefined) {
      this.#fail(`${path}.run`, `Unknown action '${actionName}' for application '${this.#application.scenarioName}'`)
    }
    try {
      action.validateInput(input)
    } catch (cause) {
      this.#fail(
        path,
        `Invalid input for action '${actionName}': ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
  }

  #compileExpectations(value: unknown): void {
    const expectations = Array.isArray(value) === true ? value : [value]
    if (expectations.length === 0) this.#fail('$.expect', 'Explicit expectations cannot be empty')
    for (let index = 0; index < expectations.length; index += 1) {
      const path = Array.isArray(value) === true ? `$.expect[${index}]` : '$.expect'
      const expectation = this.#record(expectations[index], path)
      this.#assertKeys(expectation, ['participants', 'pending', 'eventlogs', 'state'], path)
      const participants = this.#resolveParticipantSelection(expectation.participants, `${path}.participants`, true)
      let count = 0
      if (expectation.pending !== undefined) {
        if (expectation.pending !== 'resolved') this.#fail(`${path}.pending`, "Expected 'resolved'")
        this.#oracles.push({ _tag: 'pending-resolution', id: this.#nextOracleId(), participants })
        count += 1
      }
      if (expectation.eventlogs !== undefined) {
        if (expectation.eventlogs !== 'converge') this.#fail(`${path}.eventlogs`, "Expected 'converge'")
        this.#oracles.push({ _tag: 'eventlog-convergence', id: this.#nextOracleId(), participants })
        count += 1
      }
      if (expectation.state !== undefined) {
        const inspectors = this.#record(expectation.state, `${path}.state`)
        for (const [inspector, rawState] of Object.entries(inspectors)) {
          const statePath = `${path}.state.${inspector}`
          this.#assertInspector(inspector, statePath)
          const state = this.#record(rawState, statePath)
          this.#assertKeys(state, ['converge', 'containsIds'], statePath)
          if (state.converge !== undefined) {
            if (state.converge !== true) this.#fail(`${statePath}.converge`, 'Expected true')
            this.#oracles.push({
              _tag: 'state-convergence',
              id: this.#nextOracleId(),
              participants,
              inspector,
            })
            count += 1
          }
          if (state.containsIds !== undefined) {
            const expectedIds = this.#array(state.containsIds, `${statePath}.containsIds`).map((id, idIndex) =>
              this.#resolveString(id, `${statePath}.containsIds[${idIndex}]`, this.#values),
            )
            this.#oracles.push({
              _tag: 'state-contains-ids',
              id: this.#nextOracleId(),
              participants,
              inspector,
              expectedIds,
            })
            count += 1
          }
          if (state.converge === undefined && state.containsIds === undefined) {
            this.#fail(statePath, 'State expectation must define converge or containsIds')
          }
        }
      }
      if (count === 0) this.#fail(path, 'Explicit expectation must define at least one oracle')
    }
  }

  #assertInspector(name: string, path: string): void {
    if (this.#application.inspectors[name] === undefined) {
      this.#fail(path, `Unknown inspector '${name}' for application '${this.#application.scenarioName}'`)
    }
  }

  #addDefaultOracles(): void {
    const participants = [...this.#clients].flatMap(([clientId, client]) =>
      [...client.sessions].flatMap(([sessionId, state]) => (state === 'running' ? [{ clientId, sessionId }] : [])),
    )
    if (participants.length === 0) this.#fail('$.do', 'Default expectations require at least one running session')
    this.#oracles.push(
      { _tag: 'pending-resolution', id: this.#nextOracleId(), participants },
      { _tag: 'eventlog-convergence', id: this.#nextOracleId(), participants },
    )
  }

  #resolveParticipantSelection(value: unknown, path: string, allowAlias: boolean): ReadonlyArray<ParticipantRef> {
    if (typeof value === 'string') {
      if (allowAlias === true) {
        if (value === 'all') return this.#runningParticipants()
        const alias = this.#aliases.get(value)
        if (alias !== undefined) return alias
      }
      return [this.#resolveParticipant(value, path, false)]
    }
    return this.#array(value, path).map((reference, index) =>
      this.#resolveParticipant(this.#string(reference, `${path}[${index}]`), `${path}[${index}]`, false),
    )
  }

  #runningParticipants(): ReadonlyArray<ParticipantRef> {
    return [...this.#clients].flatMap(([clientId, client]) =>
      [...client.sessions].flatMap(([sessionId, state]) => (state === 'running' ? [{ clientId, sessionId }] : [])),
    )
  }

  #resolveParticipant(reference: string, path: string, allowStopped: boolean): ParticipantRef {
    const target = this.#parseParticipantReference(reference, path)
    const state = this.#clients.get(target.clientId)?.sessions.get(target.sessionId)
    if (state === undefined) this.#fail(path, `Unknown participant '${reference}' at this source position`)
    if (state === 'stopped' && allowStopped === false) {
      this.#fail(path, `Participant '${reference}' is stopped at this source position`)
    }
    return target
  }

  #parseParticipantReference(reference: string, path: string): ParticipantRef {
    const match = participant.exec(reference)
    if (match === null) this.#fail(path, `Expected fully qualified participant, received '${reference}'`)
    return { clientId: match[1]!, sessionId: match[2]! }
  }

  #requireClient(clientId: string, path: string): ClientState {
    const client = this.#clients.get(clientId)
    if (client === undefined) this.#fail(path, `Unknown Client '${clientId}' at this source position`)
    return client
  }

  #resolveValue(value: unknown, path: string, values: ReadonlyMap<string, unknown>): unknown {
    if (typeof value === 'string') return this.#interpolate(value, path, values)
    if (Array.isArray(value) === true) {
      return value.map((item, index) => this.#resolveValue(item, `${path}[${index}]`, values))
    }
    if (isRecord(value) === true) {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, this.#resolveValue(item, `${path}.${key}`, values)]),
      )
    }
    return value
  }

  #resolveString(value: unknown, path: string, values: ReadonlyMap<string, unknown>): string {
    const resolved = this.#resolveValue(value, path, values)
    if (typeof resolved !== 'string') this.#fail(path, 'Expected a string')
    return resolved
  }

  #interpolate(source: string, path: string, values: ReadonlyMap<string, unknown>): unknown {
    const entire = /^\$\{([^{}]+)\}$/.exec(source)
    if (entire !== null) return this.#evaluateExpression(entire[1]!, path, values)
    return source.replace(/\$\{([^{}]+)\}/g, (_match, expression: string) => {
      const value = this.#evaluateExpression(expression, path, values)
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        this.#fail(path, `Interpolation '${expression}' is not scalar`)
      }
      return String(value)
    })
  }

  #evaluateExpression(source: string, path: string, values: ReadonlyMap<string, unknown>): unknown {
    const expression = source.trim()
    if (values.has(expression) === true) return values.get(expression)
    const padMatch = /^pad\(([^,]+),\s*([1-9][0-9]*)\)$/.exec(expression)
    if (padMatch !== null) {
      const value = this.#evaluateExpression(padMatch[1]!, path, values)
      if (typeof value !== 'string' && typeof value !== 'number') {
        this.#fail(path, `pad value '${padMatch[1]}' must resolve to a string or number`)
      }
      return pad(value, Number(padMatch[2]))
    }
    this.#fail(path, `Unknown deterministic expression '${expression}'`)
  }

  #duration(value: unknown, path: string): number {
    const source = this.#string(value, path)
    const match = /^([1-9][0-9]*)(ms|s|m)$/.exec(source)
    if (match === null) this.#fail(path, `Expected a positive duration in ms, s, or m; received '${source}'`)
    const multiplier = match[2] === 'ms' ? 1 : match[2] === 's' ? 1_000 : 60_000
    const durationMs = Number(match[1]) * multiplier
    if (Number.isSafeInteger(durationMs) === false) this.#fail(path, `Duration is too large: '${source}'`)
    return durationMs
  }

  #nextId(kind: string): string {
    const count = (this.#instructionCounts.get(kind) ?? 0) + 1
    this.#instructionCounts.set(kind, count)
    return `${kind}-${pad(count, 4)}`
  }

  #nextOracleId(): string {
    this.#oracleCount += 1
    return `oracle-${pad(this.#oracleCount, 4)}`
  }

  #assertKeys(value: Record<string, unknown>, allowed: ReadonlyArray<string>, path: string): void {
    for (const key of Object.keys(value)) {
      if (allowed.includes(key) === false) this.#fail(`${path}.${key}`, `Unknown property '${key}'`)
    }
  }

  #assertIdentifier(value: string, path: string): void {
    if (identifier.test(value) === false) this.#fail(path, `Invalid identifier '${value}'`)
  }

  #record(value: unknown, path: string): Record<string, unknown> {
    if (isRecord(value) === false) this.#fail(path, 'Expected an object')
    return value
  }

  #array(value: unknown, path: string): ReadonlyArray<unknown> {
    if (Array.isArray(value) === false) this.#fail(path, 'Expected an array')
    return value
  }

  #stringArray(value: unknown, path: string): ReadonlyArray<string> {
    return this.#array(value, path).map((item, index) => this.#string(item, `${path}[${index}]`))
  }

  #string(value: unknown, path: string): string {
    if (typeof value !== 'string') this.#fail(path, 'Expected a string')
    return value
  }

  #boolean(value: unknown, path: string): boolean {
    if (typeof value !== 'boolean') this.#fail(path, 'Expected a boolean')
    return value
  }

  #integer(value: unknown, path: string): number {
    if (typeof value !== 'number' || Number.isInteger(value) === false) this.#fail(path, 'Expected an integer')
    return value
  }

  #fail(path: string, message: string): never {
    throw new ScenarioYamlError(this.#options.fileName, path, message)
  }
}

const parseYamlDocument = (fileName: string, source: string): Record<string, unknown> => {
  const lineCounter = new LineCounter()
  const documents = parseAllDocuments(source, {
    lineCounter,
    schema: 'core',
    strict: true,
    uniqueKeys: true,
  })
  if (documents.length !== 1) throw new ScenarioYamlError(fileName, '$', 'Expected exactly one YAML document')
  const document = documents[0]!
  const issue = document.errors[0] ?? document.warnings[0]
  if (issue !== undefined) {
    const position = issue.linePos?.[0]
    const location = position === undefined ? '$' : `${position.line}:${position.col}`
    throw new ScenarioYamlError(fileName, location, issue.message)
  }
  let value: unknown
  try {
    value = document.toJS({ maxAliasCount: 0 })
  } catch (cause) {
    throw new ScenarioYamlError(
      fileName,
      '$',
      `YAML aliases are not supported: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
  if (isRecord(value) === false) throw new ScenarioYamlError(fileName, '$', 'Scenario document must be an object')
  return value
}

const makeScenarioRandom = (seed: number, iteration: number): ScenarioGeneratorRandom => {
  const next = (key: string): number => hashString(`${seed}\u0000${iteration}\u0000${key}`) / 4_294_967_296
  return {
    next,
    integer: (key, maximumExclusive) => {
      if (Number.isInteger(maximumExclusive) === false || maximumExclusive <= 0) {
        throw new Error(`Scenario random integer bound must be a positive integer: ${maximumExclusive}`)
      }
      return Math.floor(next(key) * maximumExclusive)
    },
    pick: <T>(key: string, values: ReadonlyArray<T>): T => {
      if (values.length === 0) throw new Error(`Scenario random choice '${key}' requires at least one value`)
      return values[Math.floor(next(key) * values.length)]!
    },
  }
}

const hashString = (input: string): number => {
  let hash = 2_166_136_261
  for (const character of input) hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619)
  return hash >>> 0
}

const pad = (value: string | number, width: number): string => String(value).padStart(width, '0')

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Array.isArray(value) === false

const isParticipantRef = (value: unknown): value is ParticipantRef =>
  isRecord(value) && typeof value.clientId === 'string' && typeof value.sessionId === 'string'

const isJson = (value: unknown): value is Schema.Json => {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return true
  }
  if (Array.isArray(value) === true) return value.every(isJson)
  return isRecord(value) === true && Object.values(value).every(isJson)
}
