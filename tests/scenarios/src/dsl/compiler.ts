import type { Schema } from '@livestore/utils/effect'

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

export class ScenarioDslError extends Error {
  readonly _tag = 'ScenarioDslError'

  constructor(
    readonly fileName: string,
    readonly line: number,
    readonly column: number,
    message: string,
  ) {
    super(`${fileName}:${line}:${column}: ${message}`)
    this.name = 'ScenarioDslError'
  }
}

interface SourceLine {
  readonly number: number
  readonly indent: number
  readonly text: string
}

interface ParameterDefinition {
  readonly type: 'integer' | 'number' | 'string' | 'boolean'
  readonly value: string | number | boolean
}

interface CompileEnvironment {
  readonly values: ReadonlyMap<string, unknown>
  readonly random?: ScenarioRandom
}

interface ScenarioRandom {
  readonly integer: (maximumExclusive: number, key: string) => number
  readonly choose: <T>(values: ReadonlyArray<T>, key: string) => T
}

interface ActionDraft {
  readonly line: SourceLine
  readonly target: string
  readonly action: string
  readonly fields: ReadonlyArray<{ readonly name: string; readonly value: string; readonly line: SourceLine }>
}

interface RepeatDraft {
  readonly line: SourceLine
  readonly countExpression: string
  readonly variable: string
  readonly delayBetweenActionsMs: number | null
  readonly lets: ReadonlyArray<{ readonly name: string; readonly expression: string; readonly line: SourceLine }>
  readonly action: ActionDraft
  readonly expectation?: {
    readonly selection: 'all' | 'first' | 'last' | 'first-and-last'
    readonly allowIndefinite: boolean
    readonly line: SourceLine
  }
}

const identifierPattern = '[A-Za-z][A-Za-z0-9_-]*'
const participantPattern = `${identifierPattern}/${identifierPattern}`

export const compileScenarioSource = (options: ScenarioCompileOptions): ScenarioAst =>
  new ScenarioCompiler(options).compile()

class ScenarioCompiler {
  readonly #options: ScenarioCompileOptions
  readonly #lines: ReadonlyArray<SourceLine>
  readonly #scenarioId: string
  readonly #parameters = new Map<string, ParameterDefinition>()
  readonly #aliases = new Map<string, ReadonlyArray<ParticipantRef>>()
  readonly #clients = new Map<
    string,
    { readonly sessions: Map<string, 'running' | 'stopped'>; connected: boolean; readonly initial: boolean }
  >()
  readonly #initialClients: Array<{ id: string; sessions: string[]; initiallyConnected: boolean }> = []
  readonly #instructions: ScenarioInstruction[] = []
  readonly #oracles: ScenarioOracle[] = []
  readonly #instructionCounts = new Map<string, number>()
  #oracleCount = 0
  #index = 0
  #application: RegisteredApplication | undefined
  #descriptionSource: { readonly value: string; readonly line: SourceLine } | undefined
  #seed: number | undefined
  #usesRandom = false
  #bodyStarted = false
  #expectationsStarted = false
  #hasExplicitExpectations = false

  constructor(options: ScenarioCompileOptions) {
    this.#options = options
    this.#lines = normalizeSource(options.fileName, options.source)
    const fileName = options.fileName.split(/[\\/]/).at(-1) ?? options.fileName
    if (fileName.endsWith('.scenario') === false) {
      throw new ScenarioDslError(options.fileName, 1, 1, 'Scenario source must use the .scenario extension')
    }
    this.#scenarioId = fileName.slice(0, -'.scenario'.length)
    if (new RegExp(`^${identifierPattern}$`).test(this.#scenarioId) === false) {
      throw new ScenarioDslError(options.fileName, 1, 1, `Invalid Scenario filename-derived ID '${this.#scenarioId}'`)
    }
  }

  compile(): ScenarioAst {
    while (this.#index < this.#lines.length) this.#compileTopLevel(this.#lines[this.#index]!)
    if (this.#application === undefined) this.#fail(this.#lines[0], 'Missing required application declaration')
    if (this.#initialClients.length === 0)
      this.#fail(this.#lines[0], 'Scenario must declare at least one initial Client')
    if (this.#usesRandom === true && this.#seed === undefined && this.#options.seed === undefined) {
      this.#fail(this.#lines[0], 'Random expressions require an explicit Scenario seed')
    }
    this.#assertParameterOverrides()
    if (this.#hasExplicitExpectations === false) this.#addDefaultOracles()

    const environment = this.#environment()
    const description =
      this.#descriptionSource === undefined
        ? ''
        : this.#interpolate(this.#descriptionSource.value, environment, this.#descriptionSource.line)
    const seed = this.#options.seed ?? this.#seed ?? 0
    if (Number.isInteger(seed) === false || seed < 0)
      this.#fail(this.#lines[0], `Seed must be a non-negative integer: ${seed}`)

    return defineScenario({
      version: scenarioVersion,
      id: this.#scenarioId,
      description,
      tags: [],
      seed,
      applicationId: this.#application.id,
      requires: [],
      topology: { storeId: `scenario-${this.#scenarioId}`, clients: this.#initialClients },
      instructions: this.#instructions,
      oracles: this.#oracles,
    })
  }

  #compileTopLevel(line: SourceLine): void {
    if (line.indent !== 0) this.#fail(line, 'Unexpected indentation')

    if (line.text.startsWith('application ')) {
      this.#assertMetadata(line)
      if (this.#application !== undefined) this.#fail(line, 'Application is already declared')
      const name = line.text.slice('application '.length).trim()
      const application = this.#options.applications.find((candidate) => candidate.scenarioName === name)
      if (application === undefined) {
        this.#fail(
          line,
          `Unknown application '${name}'. Expected: ${this.#options.applications.map(({ scenarioName }) => scenarioName).join(', ')}`,
        )
      }
      this.#application = application
      this.#index += 1
      return
    }
    if (line.text.startsWith('about ')) {
      this.#assertMetadata(line)
      if (this.#descriptionSource !== undefined) this.#fail(line, 'Description is already declared')
      this.#descriptionSource = { value: this.#parseString(line.text.slice('about '.length), line), line }
      this.#index += 1
      return
    }
    if (line.text.startsWith('seed ')) {
      this.#assertMetadata(line)
      if (this.#seed !== undefined) this.#fail(line, 'Seed is already declared')
      const seed = Number(line.text.slice('seed '.length))
      if (Number.isInteger(seed) === false || seed < 0) this.#fail(line, 'Seed must be a non-negative integer')
      this.#seed = seed
      this.#index += 1
      return
    }
    if (line.text.startsWith('parameter ')) {
      this.#assertMetadata(line)
      this.#compileParameter(line)
      this.#index += 1
      return
    }
    if (line.text.startsWith('client ')) {
      if (this.#bodyStarted === true) this.#fail(line, 'Initial Client declarations must precede the instruction body')
      this.#compileInitialClient(line)
      return
    }
    if (line.text.startsWith('participants ')) {
      if (this.#expectationsStarted === true) this.#fail(line, 'Participant aliases cannot follow final expectations')
      this.#compileAlias(line)
      this.#index += 1
      return
    }
    if (line.text.startsWith('expect ') && line.text.endsWith(':')) {
      this.#bodyStarted = true
      this.#expectationsStarted = true
      this.#hasExplicitExpectations = true
      this.#compileExpectationBlock(line)
      return
    }
    if (this.#expectationsStarted === true) this.#fail(line, 'Instructions cannot follow final expectations')
    this.#bodyStarted = true
    this.#compileInstruction(line)
  }

  #assertMetadata(line: SourceLine): void {
    if (this.#bodyStarted === true || this.#initialClients.length > 0) {
      this.#fail(line, 'Scenario metadata must precede Client topology')
    }
  }

  #compileParameter(line: SourceLine): void {
    const match = /^parameter ([A-Za-z][A-Za-z0-9_-]*): (integer|number|string|boolean) = (.+)$/.exec(line.text)
    if (match === null) this.#fail(line, 'Expected parameter <name>: <type> = <default>')
    const [, name, type, defaultSource] = match
    if (this.#parameters.has(name!) === true) this.#fail(line, `Duplicate parameter '${name}'`)
    const override = this.#options.parameters?.[name!]
    const value = this.#decodeParameter(type as ParameterDefinition['type'], override ?? defaultSource!, line)
    this.#parameters.set(name!, { type: type as ParameterDefinition['type'], value })
  }

  #decodeParameter(
    type: ParameterDefinition['type'],
    source: string | number | boolean,
    line: SourceLine,
  ): string | number | boolean {
    if (type === 'string')
      return typeof source === 'string' && source.startsWith('"') ? this.#parseString(source, line) : String(source)
    if (type === 'boolean') {
      if (source === true || source === 'true') return true
      if (source === false || source === 'false') return false
      this.#fail(line, `Expected boolean parameter value, received '${String(source)}'`)
    }
    const value = typeof source === 'number' ? source : Number(source)
    if (Number.isFinite(value) === false || (type === 'integer' && Number.isInteger(value) === false)) {
      this.#fail(line, `Expected ${type} parameter value, received '${String(source)}'`)
    }
    return value
  }

  #assertParameterOverrides(): void {
    for (const name of Object.keys(this.#options.parameters ?? {})) {
      if (this.#parameters.has(name) === false) this.#fail(this.#lines[0], `Unknown parameter override '${name}'`)
    }
  }

  #compileInitialClient(line: SourceLine): void {
    const block = new RegExp(`^client (${identifierPattern}):$`).exec(line.text)
    if (block !== null) {
      const clientId = block[1]!
      this.#assertNewClient(clientId, line)
      const sessions: string[] = []
      this.#index += 1
      while (this.#index < this.#lines.length && this.#lines[this.#index]!.indent > line.indent) {
        const sessionLine = this.#lines[this.#index]!
        if (sessionLine.indent !== line.indent + 2) this.#fail(sessionLine, 'Expected one indented session declaration')
        const match = new RegExp(`^session (${identifierPattern})$`).exec(sessionLine.text)
        if (match === null) this.#fail(sessionLine, 'Expected session <session-id>')
        if (sessions.includes(match[1]!) === true) this.#fail(sessionLine, `Duplicate session '${match[1]}'`)
        sessions.push(match[1]!)
        this.#index += 1
      }
      if (sessions.length === 0) this.#fail(line, `Client ${clientId} must declare at least one session`)
      this.#registerClient(clientId, sessions, true, true)
      return
    }
    const compact = new RegExp(`^client (${identifierPattern}) with (${identifierPattern})( disconnected)?$`).exec(
      line.text,
    )
    if (compact === null) this.#fail(line, 'Expected client <client-id> with <session-id>')
    this.#assertNewClient(compact[1]!, line)
    this.#registerClient(compact[1]!, [compact[2]!], compact[3] === undefined, true)
    this.#index += 1
  }

  #registerClient(clientId: string, sessions: ReadonlyArray<string>, connected: boolean, initial: boolean): void {
    this.#clients.set(clientId, {
      sessions: new Map(sessions.map((session) => [session, 'running' as const])),
      connected,
      initial,
    })
    if (initial === true)
      this.#initialClients.push({ id: clientId, sessions: [...sessions], initiallyConnected: connected })
  }

  #assertNewClient(clientId: string, line: SourceLine): void {
    if (this.#clients.has(clientId) === true) this.#fail(line, `Duplicate Client '${clientId}'`)
  }

  #compileAlias(line: SourceLine): void {
    const match = new RegExp(`^participants (${identifierPattern}) = (.+)$`).exec(line.text)
    if (match === null) this.#fail(line, 'Expected participants <alias> = <participant>, ...')
    const name = match[1]!
    if (this.#aliases.has(name) === true) this.#fail(line, `Duplicate participant alias '${name}'`)
    const participants = this.#resolveParticipantList(match[2]!, line, false)
    if (participants.length === 0) this.#fail(line, 'Participant alias cannot be empty')
    this.#aliases.set(name, participants)
  }

  #compileInstruction(line: SourceLine): void {
    if (line.text.startsWith('note ')) {
      this.#instructions.push({
        _tag: 'annotation',
        id: this.#nextId('note'),
        text: this.#parseString(line.text.slice(5), line),
      })
      this.#index += 1
      return
    }
    if (line.text === 'backend unavailable' || line.text === 'backend available') {
      this.#instructions.push({
        _tag: line.text === 'backend unavailable' ? 'backend-unavailable' : 'backend-available',
        id: this.#nextId(line.text === 'backend unavailable' ? 'backend-unavailable' : 'backend-available'),
      })
      this.#index += 1
      return
    }
    const connectivity = new RegExp(`^(disconnect|reconnect) (${identifierPattern})$`).exec(line.text)
    if (connectivity !== null) {
      const clientId = connectivity[2]!
      const client = this.#requireClient(clientId, line)
      client.connected = connectivity[1] === 'reconnect'
      this.#instructions.push({
        _tag: connectivity[1] === 'disconnect' ? 'disconnect' : 'reconnect',
        id: this.#nextId(connectivity[1]!),
        clientId,
      })
      this.#index += 1
      return
    }
    const lifecycle = new RegExp(`^(stop|restart) session (${participantPattern})$`).exec(line.text)
    if (lifecycle !== null) {
      const target = this.#resolveParticipant(lifecycle[2]!, line, lifecycle[1] === 'restart')
      const client = this.#clients.get(target.clientId)!
      client.sessions.set(target.sessionId, lifecycle[1] === 'stop' ? 'stopped' : 'running')
      this.#instructions.push({
        _tag: lifecycle[1] === 'stop' ? 'stop-session' : 'restart-session',
        id: this.#nextId(`${lifecycle[1]}-session`),
        target,
      })
      this.#index += 1
      return
    }
    const restartClient = new RegExp(`^restart client (${identifierPattern})$`).exec(line.text)
    if (restartClient !== null) {
      const clientId = restartClient[1]!
      const client = this.#requireClient(clientId, line)
      for (const sessionId of client.sessions.keys()) client.sessions.set(sessionId, 'running')
      this.#instructions.push({ _tag: 'restart-client', id: this.#nextId('restart-client'), clientId })
      this.#index += 1
      return
    }
    const createClient = new RegExp(
      `^create client (${identifierPattern}) with (${identifierPattern})( disconnected)?$`,
    ).exec(line.text)
    if (createClient !== null) {
      const clientId = createClient[1]!
      const sessionId = createClient[2]!
      this.#assertNewClient(clientId, line)
      const connected = createClient[3] === undefined
      this.#registerClient(clientId, [sessionId], connected, false)
      this.#instructions.push({
        _tag: 'create-client',
        id: this.#nextId('create-client'),
        client: { id: clientId, sessions: [sessionId], initiallyConnected: connected },
      })
      this.#index += 1
      return
    }
    const addSession = new RegExp(`^add session (${identifierPattern}) to (${identifierPattern})$`).exec(line.text)
    if (addSession !== null) {
      const sessionId = addSession[1]!
      const clientId = addSession[2]!
      const client = this.#requireClient(clientId, line)
      if (client.sessions.has(sessionId) === true) this.#fail(line, `Duplicate participant '${clientId}/${sessionId}'`)
      client.sessions.set(sessionId, 'running')
      this.#instructions.push({
        _tag: 'add-session',
        id: this.#nextId('add-session'),
        target: { clientId, sessionId },
      })
      this.#index += 1
      return
    }
    if (line.text.startsWith('settle ')) {
      this.#compileSettlement(line)
      return
    }
    if (line.text.startsWith('wait ')) {
      this.#instructions.push({
        _tag: 'wait',
        id: this.#nextId('wait'),
        durationMs: this.#parseDuration(line.text.slice('wait '.length), line),
      })
      this.#index += 1
      return
    }
    if (line.text === 'concurrently:') {
      this.#compileConcurrent(line)
      return
    }
    if (line.text.startsWith('repeat ') && line.text.endsWith(':')) {
      this.#compileRepeat(line)
      return
    }
    const action = this.#parseAction(line)
    if (action !== undefined) {
      this.#instructions.push(this.#compileAction(action, this.#environment(), this.#nextId('action')))
      return
    }
    this.#fail(line, `Unknown instruction '${line.text}'`)
  }

  #compileSettlement(line: SourceLine): void {
    const participants = this.#resolveParticipantList(line.text.slice('settle '.length), line, true)
    const healDisconnectedClients: string[] = []
    this.#index += 1
    while (this.#index < this.#lines.length && this.#lines[this.#index]!.indent > line.indent) {
      const nested = this.#lines[this.#index]!
      if (nested.indent !== line.indent + 2) this.#fail(nested, 'Expected one indented Settlement option')
      const match = new RegExp(`^reconnect (${identifierPattern})$`).exec(nested.text)
      if (match === null) this.#fail(nested, 'Settlement supports only reconnect <client-id>')
      const client = this.#requireClient(match[1]!, nested)
      client.connected = true
      healDisconnectedClients.push(match[1]!)
      this.#index += 1
    }
    this.#instructions.push({
      _tag: 'settle',
      id: this.#nextId('settle'),
      participants,
      healDisconnectedClients,
    })
  }

  #compileConcurrent(line: SourceLine): void {
    const parallelId = this.#nextId('concurrently')
    const operations: ParallelOperationStep[] = []
    let expectation: { requireOverlap: boolean; allowIndefinite: boolean; line: SourceLine } | undefined
    this.#index += 1
    while (this.#index < this.#lines.length && this.#lines[this.#index]!.indent > line.indent) {
      const child = this.#lines[this.#index]!
      if (child.indent !== line.indent + 2) this.#fail(child, 'Expected one concurrently-indented operation')
      if (child.text.startsWith('expect ')) {
        if (expectation !== undefined) this.#fail(child, 'Concurrent block has more than one local expectation')
        const match = /^expect (overlap|all finish)( allowing indefinite)?$/.exec(child.text)
        if (match === null) this.#fail(child, 'Expected expect overlap or expect all finish')
        expectation = { requireOverlap: match[1] === 'overlap', allowIndefinite: match[2] !== undefined, line: child }
        this.#index += 1
        continue
      }
      const action = this.#parseAction(child)
      if (action !== undefined) {
        operations.push(
          this.#compileAction(action, this.#environment(), `${parallelId}:operation-${pad(operations.length + 1, 4)}`),
        )
        continue
      }
      operations.push(this.#compileParallelControl(child, `${parallelId}:operation-${pad(operations.length + 1, 4)}`))
      this.#index += 1
    }
    if (operations.length < 2) this.#fail(line, 'Concurrent block must contain at least two operations')
    this.#instructions.push({ _tag: 'parallel', id: parallelId, operations })
    if (expectation !== undefined) {
      this.#oracles.push({
        _tag: 'operation-history',
        id: this.#nextOracleId(),
        operationIds: operations.map(({ id }) => id),
        requireOverlap: expectation.requireOverlap,
        allowIndefinite: expectation.allowIndefinite,
      })
    }
  }

  #compileParallelControl(line: SourceLine, id: string): ParallelOperationStep {
    const connectivity = new RegExp(`^(disconnect|reconnect) (${identifierPattern})$`).exec(line.text)
    if (connectivity !== null) {
      this.#requireClient(connectivity[2]!, line)
      return { _tag: connectivity[1] === 'disconnect' ? 'disconnect' : 'reconnect', id, clientId: connectivity[2]! }
    }
    if (line.text === 'backend unavailable' || line.text === 'backend available') {
      return { _tag: line.text === 'backend unavailable' ? 'backend-unavailable' : 'backend-available', id }
    }
    const session = new RegExp(`^(stop|restart) session (${participantPattern})$`).exec(line.text)
    if (session !== null) {
      return {
        _tag: session[1] === 'stop' ? 'stop-session' : 'restart-session',
        id,
        target: this.#resolveParticipant(session[2]!, line, session[1] === 'restart'),
      }
    }
    const client = new RegExp(`^restart client (${identifierPattern})$`).exec(line.text)
    if (client !== null) {
      this.#requireClient(client[1]!, line)
      return { _tag: 'restart-client', id, clientId: client[1]! }
    }
    this.#fail(line, `Unsupported concurrent operation '${line.text}'`)
  }

  #compileRepeat(line: SourceLine): void {
    const draft = this.#parseRepeat(line)
    const repeatId = this.#nextId('repeat')
    const count = this.#integerExpression(draft.countExpression, this.#environment(), draft.line)
    if (count <= 0 || count > 10_000) this.#fail(line, 'Repeat count must be between 1 and 10000')
    const scenarioSeed = this.#options.seed ?? this.#seed
    const repeatSeed = hashString(`${scenarioSeed ?? 0}\u0000${repeatId}`)
    const actions = Array.from({ length: count }, (_, index) => {
      const random = makeScenarioRandom(repeatSeed, index)
      const values = new Map(this.#environment().values)
      values.set(draft.variable, index + 1)
      let environment: CompileEnvironment = { values, random }
      for (const binding of draft.lets) {
        const value = this.#evaluateExpression(binding.expression, environment, binding.line)
        values.set(binding.name, value)
        environment = { values, random }
      }
      return this.#compileAction(draft.action, environment, `${repeatId}:${pad(index + 1, 4)}`)
    })
    this.#instructions.push({
      _tag: 'action-sequence',
      id: repeatId,
      description: `Repeat ${draft.action.action} ${count} times`,
      seed: repeatSeed,
      delayBetweenActionsMs: draft.delayBetweenActionsMs,
      actions,
    })
    if (draft.expectation !== undefined) {
      const selected =
        draft.expectation.selection === 'all'
          ? actions
          : draft.expectation.selection === 'first'
            ? [actions[0]!]
            : draft.expectation.selection === 'last'
              ? [actions.at(-1)!]
              : actions.length === 1
                ? [actions[0]!]
                : [actions[0]!, actions.at(-1)!]
      this.#oracles.push({
        _tag: 'operation-history',
        id: this.#nextOracleId(),
        operationIds: selected.map(({ id }) => id),
        requireOverlap: false,
        allowIndefinite: draft.expectation.allowIndefinite,
      })
    }
  }

  #parseRepeat(line: SourceLine): RepeatDraft {
    const match = new RegExp(
      `^repeat (.+?) times as (${identifierPattern})(?: with ([1-9][0-9]*(?:ms|s|m)) between)?:$`,
    ).exec(line.text)
    if (match === null) this.#fail(line, 'Expected repeat <count> times as <name> [with <duration> between]:')
    const lets: Array<{ name: string; expression: string; line: SourceLine }> = []
    let action: ActionDraft | undefined
    let expectation: RepeatDraft['expectation']
    this.#index += 1
    while (this.#index < this.#lines.length && this.#lines[this.#index]!.indent > line.indent) {
      const child = this.#lines[this.#index]!
      if (child.indent !== line.indent + 2) this.#fail(child, 'Expected one repeat-indented declaration')
      const letMatch = new RegExp(`^let (${identifierPattern}) = (.+)$`).exec(child.text)
      if (letMatch !== null) {
        if (action !== undefined) this.#fail(child, 'Repeat bindings must precede the action')
        lets.push({ name: letMatch[1]!, expression: letMatch[2]!, line: child })
        this.#index += 1
        continue
      }
      if (child.text.startsWith('expect ')) {
        const expectationMatch = /^expect (all|first|last|first and last) finish( allowing indefinite)?$/.exec(
          child.text,
        )
        if (expectationMatch === null) this.#fail(child, 'Invalid repeated-action expectation')
        if (expectation !== undefined) this.#fail(child, 'Repeat block has more than one local expectation')
        expectation = {
          selection:
            expectationMatch[1] === 'first and last'
              ? 'first-and-last'
              : (expectationMatch[1] as 'all' | 'first' | 'last'),
          allowIndefinite: expectationMatch[2] !== undefined,
          line: child,
        }
        this.#index += 1
        continue
      }
      const parsed = this.#parseAction(child)
      if (parsed === undefined)
        this.#fail(child, 'Repeat block supports bindings, one Application action, and one local expectation')
      if (action !== undefined) this.#fail(child, 'Repeat block must contain exactly one Application action')
      action = parsed
    }
    if (action === undefined) this.#fail(line, 'Repeat block must contain one Application action')
    return {
      line,
      countExpression: match[1]!,
      variable: match[2]!,
      delayBetweenActionsMs: match[3] === undefined ? null : this.#parseDuration(match[3], line),
      lets,
      action,
      expectation,
    }
  }

  #parseAction(line: SourceLine): ActionDraft | undefined {
    const match = new RegExp(`^(${participantPattern}|${identifierPattern}) runs (${identifierPattern})( with)?$`).exec(
      line.text,
    )
    if (match === null) return undefined
    const fields: Array<{ name: string; value: string; line: SourceLine }> = []
    this.#index += 1
    if (match[3] !== undefined) {
      while (this.#index < this.#lines.length && this.#lines[this.#index]!.indent > line.indent) {
        const field = this.#lines[this.#index]!
        if (field.indent !== line.indent + 2) this.#fail(field, 'Expected one action-input indentation level')
        const fieldMatch = /^([A-Za-z][A-Za-z0-9_-]*|"(?:[^"\\]|\\.)+"): (.+)$/.exec(field.text)
        if (fieldMatch === null) this.#fail(field, 'Expected <field>: <value>')
        const name = fieldMatch[1]!.startsWith('"') ? this.#parseString(fieldMatch[1]!, field) : fieldMatch[1]!
        if (fields.some((candidate) => candidate.name === name) === true)
          this.#fail(field, `Duplicate input field '${name}'`)
        fields.push({ name, value: fieldMatch[2]!, line: field })
        this.#index += 1
      }
      if (fields.length === 0) this.#fail(line, 'Action with must contain at least one input field')
    }
    return { line, target: match[1]!, action: match[2]!, fields }
  }

  #compileAction(draft: ActionDraft, environment: CompileEnvironment, id: string) {
    const application = this.#application
    if (application === undefined) this.#fail(draft.line, 'Application must be declared before actions')
    const action = application.actions[draft.action]
    if (action === undefined) {
      this.#fail(draft.line, `Unknown action '${draft.action}' for application '${application.scenarioName}'`)
    }
    const targetValue = environment.values.get(draft.target)
    const target =
      targetValue === undefined
        ? this.#resolveParticipant(draft.target, draft.line, false)
        : isParticipantRef(targetValue)
          ? targetValue
          : this.#fail(draft.line, `Action target '${draft.target}' does not resolve to one participant`)
    const input: Record<string, Schema.Json> = {}
    for (const field of draft.fields) {
      const value = this.#parseValue(field.value, environment, field.line)
      if (isJson(value) === false) this.#fail(field.line, `Input field '${field.name}' does not resolve to JSON`)
      input[field.name] = value
    }
    try {
      action.validateInput(input)
    } catch (cause) {
      this.#fail(
        draft.line,
        `Invalid input for action '${draft.action}': ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
    return { _tag: 'action' as const, id, target, action: draft.action, input }
  }

  #compileExpectationBlock(line: SourceLine): void {
    const selection = line.text.slice('expect '.length, -1).trim()
    const participants = this.#resolveParticipantList(selection, line, true)
    let count = 0
    this.#index += 1
    while (this.#index < this.#lines.length && this.#lines[this.#index]!.indent > line.indent) {
      const child = this.#lines[this.#index]!
      if (child.indent !== line.indent + 2) this.#fail(child, 'Expected one expectation indentation level')
      if (child.text === 'pending resolved') {
        this.#oracles.push({ _tag: 'pending-resolution', id: this.#nextOracleId(), participants })
      } else if (child.text === 'eventlogs converge') {
        this.#oracles.push({ _tag: 'eventlog-convergence', id: this.#nextOracleId(), participants })
      } else {
        const convergence = new RegExp(`^(${identifierPattern}) converges$`).exec(child.text)
        const contains = new RegExp(`^(${identifierPattern}) contains ids (.+)$`).exec(child.text)
        if (convergence !== null) {
          this.#assertInspector(convergence[1]!, child)
          this.#oracles.push({
            _tag: 'state-convergence',
            id: this.#nextOracleId(),
            participants,
            inspector: convergence[1]!,
          })
        } else if (contains !== null) {
          this.#assertInspector(contains[1]!, child)
          const expectedIds = splitCommaSeparated(contains[2]!).map((value) => {
            const parsed = this.#parseValue(value, this.#environment(), child)
            if (typeof parsed !== 'string') this.#fail(child, 'Expected IDs must resolve to strings')
            return parsed
          })
          this.#oracles.push({
            _tag: 'state-contains-ids',
            id: this.#nextOracleId(),
            participants,
            inspector: contains[1]!,
            expectedIds,
          })
        } else {
          this.#fail(child, `Unknown expectation '${child.text}'`)
        }
      }
      count += 1
      this.#index += 1
    }
    if (count === 0) this.#fail(line, 'Explicit expect block cannot be empty')
  }

  #assertInspector(name: string, line: SourceLine): void {
    const application = this.#application
    if (application === undefined || application.inspectors[name] === undefined) {
      this.#fail(line, `Unknown inspector '${name}' for application '${application?.scenarioName ?? 'undeclared'}'`)
    }
  }

  #addDefaultOracles(): void {
    const participants = [...this.#clients].flatMap(([clientId, client]) =>
      [...client.sessions].flatMap(([sessionId, state]) => (state === 'running' ? [{ clientId, sessionId }] : [])),
    )
    if (participants.length === 0)
      this.#fail(this.#lines.at(-1), 'Default expectations require at least one running session')
    this.#oracles.push(
      { _tag: 'pending-resolution', id: this.#nextOracleId(), participants },
      { _tag: 'eventlog-convergence', id: this.#nextOracleId(), participants },
    )
  }

  #resolveParticipantList(source: string, line: SourceLine, allowAlias: boolean): ReadonlyArray<ParticipantRef> {
    const alias = allowAlias === true ? this.#aliases.get(source.trim()) : undefined
    if (alias !== undefined) return alias
    return splitCommaSeparated(source).map((part) => this.#resolveParticipant(part, line, false))
  }

  #resolveParticipant(source: string, line: SourceLine, allowStopped: boolean): ParticipantRef {
    const match = new RegExp(`^(${identifierPattern})/(${identifierPattern})$`).exec(source.trim())
    if (match === null) this.#fail(line, `Expected fully qualified participant, received '${source}'`)
    const client = this.#clients.get(match[1]!)
    const state = client?.sessions.get(match[2]!)
    if (state === undefined) this.#fail(line, `Unknown participant '${source}' at this source position`)
    if (state === 'stopped' && allowStopped === false)
      this.#fail(line, `Participant '${source}' is stopped at this source position`)
    return { clientId: match[1]!, sessionId: match[2]! }
  }

  #requireClient(clientId: string, line: SourceLine) {
    const client = this.#clients.get(clientId)
    if (client === undefined) this.#fail(line, `Unknown Client '${clientId}' at this source position`)
    return client
  }

  #environment(): CompileEnvironment {
    return { values: new Map([...this.#parameters].map(([name, definition]) => [name, definition.value])) }
  }

  #parseValue(source: string, environment: CompileEnvironment, line: SourceLine): unknown {
    try {
      return new ValueParser(
        source,
        (expression) => this.#evaluateExpression(expression, environment, line),
        (value) => this.#interpolate(value, environment, line),
      ).parse()
    } catch (cause) {
      if (cause instanceof ScenarioDslError) throw cause
      this.#fail(line, `Invalid value: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  #evaluateExpression(source: string, environment: CompileEnvironment, line: SourceLine): unknown {
    const expression = source.trim()
    const value = environment.values.get(expression)
    if (value !== undefined) return value
    if (/^-?\d+(?:\.\d+)?$/.test(expression)) return Number(expression)
    if (expression === 'true') return true
    if (expression === 'false') return false
    if (expression.startsWith('"')) return this.#interpolate(this.#parseString(expression, line), environment, line)

    const padMatch = /^pad\((.+),\s*(\d+)\)$/.exec(expression)
    if (padMatch !== null)
      return pad(String(this.#evaluateExpression(padMatch[1]!, environment, line)), Number(padMatch[2]!))
    const repeatMatch = /^repeat\(("(?:[^"\\]|\\.)*"),\s*(.+)\)$/.exec(expression)
    if (repeatMatch !== null) {
      const text = this.#parseString(repeatMatch[1]!, line)
      const count = this.#integerExpression(repeatMatch[2]!, environment, line)
      if (count < 0 || count > 10_000_000) this.#fail(line, 'repeat(text, count) count must be between 0 and 10000000')
      return text.repeat(count)
    }
    const randomMatch = /^randomInt\((.+),\s*key:\s*("(?:[^"\\]|\\.)*")\)$/.exec(expression)
    if (randomMatch !== null) {
      this.#usesRandom = true
      if (environment.random === undefined) this.#fail(line, 'randomInt is only available inside repeat')
      return environment.random.integer(
        this.#integerExpression(randomMatch[1]!, environment, line),
        this.#parseString(randomMatch[2]!, line),
      )
    }
    const chooseMatch = /^choose\((.+),\s*key:\s*("(?:[^"\\]|\\.)*")\)$/.exec(expression)
    if (chooseMatch !== null) {
      this.#usesRandom = true
      if (environment.random === undefined) this.#fail(line, 'choose is only available inside repeat')
      const choices = this.#aliases.get(chooseMatch[1]!.trim())
      if (choices === undefined) this.#fail(line, `Unknown participant alias '${chooseMatch[1]!.trim()}'`)
      return environment.random.choose(choices, this.#parseString(chooseMatch[2]!, line))
    }
    this.#fail(line, `Unknown deterministic expression '${expression}'`)
  }

  #integerExpression(source: string, environment: CompileEnvironment, line: SourceLine): number {
    const value = this.#evaluateExpression(source, environment, line)
    if (typeof value !== 'number' || Number.isInteger(value) === false)
      this.#fail(line, `Expected integer expression '${source}'`)
    return value
  }

  #interpolate(source: string, environment: CompileEnvironment, line: SourceLine): string {
    return source.replace(/\$\{([^}]+)\}/g, (_match, expression: string) => {
      const value = this.#evaluateExpression(expression, environment, line)
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        this.#fail(line, `Interpolation '${expression}' is not scalar`)
      }
      return String(value)
    })
  }

  #parseString(source: string, line: SourceLine): string {
    try {
      const parsed = JSON.parse(source) as unknown
      if (typeof parsed !== 'string') this.#fail(line, 'Expected quoted string')
      return parsed
    } catch (cause) {
      this.#fail(line, `Invalid quoted string: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  #parseDuration(source: string, line: SourceLine): number {
    const match = /^([1-9][0-9]*)(ms|s|m)$/.exec(source.trim())
    if (match === null) this.#fail(line, `Expected a positive duration in ms, s, or m; received '${source}'`)
    const multiplier = match[2] === 'ms' ? 1 : match[2] === 's' ? 1_000 : 60_000
    const durationMs = Number(match[1]) * multiplier
    if (Number.isSafeInteger(durationMs) === false) this.#fail(line, `Duration is too large: '${source}'`)
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

  #fail(line: SourceLine | undefined, message: string): never {
    throw new ScenarioDslError(this.#options.fileName, line?.number ?? 1, (line?.indent ?? 0) + 1, message)
  }
}

class ValueParser {
  #index = 0

  constructor(
    readonly source: string,
    readonly evaluate: (expression: string) => unknown,
    readonly interpolate: (value: string) => string,
  ) {}

  parse(): unknown {
    const value = this.#value()
    this.#space()
    if (this.#index !== this.source.length)
      throw new Error(`Unexpected value input '${this.source.slice(this.#index)}'`)
    return value
  }

  #value(): unknown {
    this.#space()
    const character = this.source[this.#index]
    if (character === '"') return this.interpolate(this.#string())
    if (character === '[') return this.#array()
    if (character === '{') return this.#object()
    const expression = this.#expression()
    if (expression === 'null') return null
    return this.evaluate(expression)
  }

  #string(): string {
    const start = this.#index
    this.#index += 1
    let escaped = false
    while (this.#index < this.source.length) {
      const character = this.source[this.#index]!
      this.#index += 1
      if (escaped === true) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') return JSON.parse(this.source.slice(start, this.#index)) as string
    }
    throw new Error('Unterminated string')
  }

  #array(): unknown[] {
    const values: unknown[] = []
    this.#index += 1
    this.#space()
    if (this.source[this.#index] === ']') {
      this.#index += 1
      return values
    }
    while (true) {
      values.push(this.#value())
      this.#space()
      const character = this.source[this.#index++]
      if (character === ']') return values
      if (character !== ',') throw new Error('Expected comma or closing bracket')
    }
  }

  #object(): Record<string, unknown> {
    const value: Record<string, unknown> = {}
    this.#index += 1
    this.#space()
    if (this.source[this.#index] === '}') {
      this.#index += 1
      return value
    }
    while (true) {
      this.#space()
      const key = this.source[this.#index] === '"' ? this.#string() : this.#identifier()
      this.#space()
      if (this.source[this.#index++] !== ':') throw new Error('Expected colon after object key')
      value[key] = this.#value()
      this.#space()
      const character = this.source[this.#index++]
      if (character === '}') return value
      if (character !== ',') throw new Error('Expected comma or closing brace')
    }
  }

  #identifier(): string {
    const start = this.#index
    while (/[A-Za-z0-9_-]/.test(this.source[this.#index] ?? '')) this.#index += 1
    if (start === this.#index) throw new Error('Expected identifier')
    return this.source.slice(start, this.#index)
  }

  #expression(): string {
    const start = this.#index
    let depth = 0
    let quoted = false
    let escaped = false
    while (this.#index < this.source.length) {
      const character = this.source[this.#index]!
      if (quoted === true) {
        this.#index += 1
        if (escaped === true) escaped = false
        else if (character === '\\') escaped = true
        else if (character === '"') quoted = false
        continue
      }
      if (character === '"') quoted = true
      else if (character === '(') depth += 1
      else if (character === ')') depth -= 1
      else if (depth === 0 && (character === ',' || character === ']' || character === '}')) break
      this.#index += 1
    }
    return this.source.slice(start, this.#index).trim()
  }

  #space(): void {
    while (/\s/.test(this.source[this.#index] ?? '')) this.#index += 1
  }
}

const normalizeSource = (fileName: string, source: string): ReadonlyArray<SourceLine> => {
  const rawLines = source.replaceAll('\r\n', '\n').split('\n')
  const lines: SourceLine[] = []
  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index]!
    if (raw.includes('\t'))
      throw new ScenarioDslError(fileName, index + 1, raw.indexOf('\t') + 1, 'Tabs are not allowed')
    const indent = raw.length - raw.trimStart().length
    if (indent % 2 !== 0)
      throw new ScenarioDslError(fileName, index + 1, 1, 'Indentation must use multiples of two spaces')
    let text = stripComment(raw.slice(indent)).trimEnd()
    if (text === '') continue
    if (text === 'note """' || text.startsWith('note """')) {
      const content: string[] = []
      const remainder = text.slice('note """'.length)
      if (remainder.endsWith('"""')) {
        text = `note ${JSON.stringify(remainder.slice(0, -3))}`
      } else {
        if (remainder !== '') content.push(remainder)
        let closed = false
        while (++index < rawLines.length) {
          const narrative = rawLines[index]!
          if (narrative.trim() === '"""') {
            closed = true
            break
          }
          content.push(narrative.slice(Math.min(narrative.length, indent)))
        }
        if (closed === false) throw new ScenarioDslError(fileName, index + 1, 1, 'Unterminated triple-quoted note')
        text = `note ${JSON.stringify(content.join('\n'))}`
      }
    }
    lines.push({ number: index + 1, indent, text })
  }
  if (lines.length === 0) throw new ScenarioDslError(fileName, 1, 1, 'Scenario source is empty')
  return lines
}

const stripComment = (source: string): string => {
  let quoted = false
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!
    if (quoted === true) {
      if (escaped === true) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quoted = false
    } else if (character === '"') quoted = true
    else if (character === '#') return source.slice(0, index)
  }
  return source
}

const splitCommaSeparated = (source: string): ReadonlyArray<string> => {
  const parts: string[] = []
  let start = 0
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!
    if (quoted === true) {
      if (escaped === true) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quoted = false
    } else if (character === '"') quoted = true
    else if (character === '(' || character === '[' || character === '{') depth += 1
    else if (character === ')' || character === ']' || character === '}') depth -= 1
    else if (character === ',' && depth === 0) {
      parts.push(source.slice(start, index).trim())
      start = index + 1
    }
  }
  parts.push(source.slice(start).trim())
  return parts.filter((part) => part !== '')
}

const isParticipantRef = (value: unknown): value is ParticipantRef =>
  typeof value === 'object' &&
  value !== null &&
  'clientId' in value &&
  typeof value.clientId === 'string' &&
  'sessionId' in value &&
  typeof value.sessionId === 'string'

const isJson = (value: unknown): value is Schema.Json => {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return true
  if (Array.isArray(value)) return value.every(isJson)
  return typeof value === 'object' && Object.values(value).every(isJson)
}

const makeScenarioRandom = (seed: number, iteration: number): ScenarioRandom => {
  const next = (key: string): number => hashString(`${seed}\u0000${iteration}\u0000${key}`) / 4_294_967_296
  return {
    integer: (maximumExclusive, key) => {
      if (maximumExclusive <= 0) throw new Error(`Random integer bound must be positive: ${maximumExclusive}`)
      return Math.floor(next(key) * maximumExclusive)
    },
    choose: <T>(values: ReadonlyArray<T>, key: string): T => {
      if (values.length === 0) throw new Error(`Random choice '${key}' requires at least one value`)
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
