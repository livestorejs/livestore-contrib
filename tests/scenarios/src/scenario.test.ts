import { describe, expect, it } from 'vitest'

import { todo } from './corpus/applications/todo.ts'
import {
  alias,
  client,
  eventlogsConverge,
  expect as finalExpectations,
  generate,
  normalizeScenario,
  note,
  parameter,
  pendingResolved,
  repeat,
  Scenario,
  ScenarioSourceError,
  stateConverges,
  wait,
} from './scenario.ts'

const topology = () => {
  const clientA = client('client-a').withSessions('session-a')
  const sessionA = clientA.session('session-a')
  const clientB = client('client-b').withSessions('session-b')
  const sessionB = clientB.session('session-b')
  return { clientA, sessionA, clientB, sessionB }
}

describe('Scenario as code', () => {
  it('configures addressable sessions directly on a Client', () => {
    const clientA = client('client-a').withSessions('main', 'secondary').disconnected()

    expect(clientA.sessions.map(({ sessionId }) => sessionId)).toEqual(['main', 'secondary'])
    expect(clientA.session('main')).toBe(clientA.sessions[0])
    expect(clientA.session('later')).toEqual({ _tag: 'ScenarioSession', clientId: 'client-a', sessionId: 'later' })
    expect(clientA.initiallyConnected).toBe(false)

    const compiled = normalizeScenario(Scenario.start({ application: todo, clients: [clientA] }), {
      id: 'configured-client',
    })
    expect(compiled.topology.clients).toEqual([
      { id: 'client-a', sessions: ['main', 'secondary'], initiallyConnected: false },
    ])
  })

  it('builds an immutable pipeline and normalizes it to the runner AST', () => {
    const { clientA, sessionA } = topology()
    const start = Scenario.start({
      application: todo,
      about: 'A readable TypeScript Scenario.',
      clients: [clientA],
    })
    const source = start.pipe(
      note('Write locally.'),
      todo.createTodo({ id: 'todo-1', text: 'First' }).as(sessionA),
      wait('25ms'),
    )

    expect(start.instructions).toHaveLength(0)
    const compiled = normalizeScenario(source, { id: 'example' })
    expect(compiled).toMatchObject({
      id: 'example',
      description: 'A readable TypeScript Scenario.',
      applicationId: 'scenario-todo-app',
      seed: 0,
      topology: {
        storeId: 'scenario-example',
        clients: [{ id: 'client-a', sessions: ['session-a'], initiallyConnected: true }],
      },
      instructions: [
        { _tag: 'annotation', id: 'note-0001', text: 'Write locally.' },
        { _tag: 'action', id: 'action-0001', target: { clientId: 'client-a', sessionId: 'session-a' } },
        { _tag: 'wait', id: 'wait-0001', durationMs: 25 },
      ],
      oracles: [
        { _tag: 'pending-resolution', id: 'oracle-0001' },
        { _tag: 'eventlog-convergence', id: 'oracle-0002' },
      ],
    })
  })

  it('uses lexical aliases only where a participant selection is needed', () => {
    const { clientA, sessionA, clientB, sessionB } = topology()
    const both = alias([sessionA, sessionB])
    const compiled = normalizeScenario(
      Scenario.start({
        application: todo,
        clients: [clientA, clientB],
      }).pipe(
        todo.createTodo({ id: 'todo-1', text: 'First' }).as(sessionA),
        finalExpectations(pendingResolved(both), eventlogsConverge(both), stateConverges('todos', both)),
      ),
      { id: 'aliases' },
    )

    expect(compiled.oracles.map(({ _tag }) => _tag)).toEqual([
      'pending-resolution',
      'eventlog-convergence',
      'state-convergence',
    ])
    expect(
      compiled.oracles.every((oracle) => oracle._tag === 'operation-history' || oracle.participants.length === 2),
    ).toBe(true)
  })

  it('decodes declared parameters and rejects unknown overrides', () => {
    const { clientA, sessionA } = topology()
    const source = Scenario.parameterized({ count: parameter.integer(2) }, ({ count }) =>
      Scenario.start({ application: todo, clients: [clientA] }).pipe(
        repeat(
          Array.from({ length: count }, (_, offset) =>
            todo.createTodo({ id: `todo-${offset + 1}`, text: `Todo ${offset + 1}` }).as(sessionA),
          ),
        ),
      ),
    )

    expect(
      normalizeScenario(source, { id: 'parameterized', parameters: { count: '3' } }).instructions[0],
    ).toMatchObject({
      _tag: 'action-sequence',
      actions: [{ id: 'repeat-0001:0001' }, { id: 'repeat-0001:0002' }, { id: 'repeat-0001:0003' }],
    })
    expect(() => normalizeScenario(source, { id: 'parameterized', parameters: { missing: 1 } })).toThrow(
      "Unknown parameter override 'missing'",
    )
  })

  it('expands generated actions deterministically from the effective seed', () => {
    const { clientA, sessionA } = topology()
    const source = Scenario.start({ application: todo, seed: 42, clients: [clientA] }).pipe(
      generate(({ random }) =>
        Array.from({ length: 3 }, (_, offset) =>
          todo
            .createTodo({
              id: `todo-${offset}`,
              text: `Variant ${random.iteration(offset + 1).integer('variant', 100)}`,
            })
            .as(sessionA),
        ),
      ),
    )

    const first = normalizeScenario(source, { id: 'generated' })
    const second = normalizeScenario(source, { id: 'generated' })
    const different = normalizeScenario(source, { id: 'generated', seed: 43 })
    expect(first.instructions).toEqual(second.instructions)
    expect(first.instructions).not.toEqual(different.instructions)
  })

  it('allows reusable helpers to be ordinary typed functions', () => {
    const { clientA, sessionA } = topology()
    const createTodos = (count: number) =>
      repeat(
        Array.from({ length: count }, (_, offset) =>
          todo.createTodo({ id: `helper-${offset}`, text: `Helper ${offset}` }).as(sessionA),
        ),
      )
    const compiled = normalizeScenario(Scenario.start({ application: todo, clients: [clientA] }).pipe(createTodos(4)), {
      id: 'ordinary-helper',
    })

    expect(compiled.instructions[0]).toMatchObject({ _tag: 'action-sequence', actions: expect.any(Array) })
    expect(compiled.instructions[0]!._tag === 'action-sequence' && compiled.instructions[0]!.actions).toHaveLength(4)
  })

  it('rejects invalid topology references during normalization', () => {
    const { clientA, sessionA, clientB, sessionB } = topology()
    const source = Scenario.start({ application: todo, clients: [clientA] }).pipe(
      todo.createTodo({ id: 'todo-1', text: 'First' }).as(sessionB),
    )
    expect(() => normalizeScenario(source, { id: 'invalid-reference' })).toThrow(ScenarioSourceError)
    expect(() => normalizeScenario(source, { id: 'invalid-reference' })).toThrow(
      "Unknown participant 'client-b/session-b' at this source position",
    )
  })
})
