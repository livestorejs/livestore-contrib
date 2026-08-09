import { describe, expect, it } from 'vitest'

import { Schema } from '@livestore/utils/effect'

import { scenarioApplications } from '../corpus/applications/registry.ts'
import { sharedScenarioHelpers } from '../corpus/scenario-helpers.ts'
import { compileScenarioYamlSource } from './compiler.ts'
import {
  composeScenarioHelpers,
  defineScenarioHelper,
  defineScenarioHelpers,
  helperActions,
  helperInstructions,
} from './helpers.ts'

const seededActions = defineScenarioHelper({
  input: Schema.Struct({ target: Schema.String, count: Schema.Int }),
  generate: ({ input, context }) =>
    helperActions(
      Array.from({ length: input.count }, (_, offset) => {
        const item = offset + 1
        return {
          target: context.participant(input.target),
          action: 'createTodo',
          input: {
            id: `generated-${String(item).padStart(3, '0')}`,
            text: `Variant ${context.random.iteration(item).integer('text', 1_000)}`,
          },
        }
      }),
    ),
})

const waitThenCreate = defineScenarioHelper({
  input: Schema.Struct({ target: Schema.String, id: Schema.String }),
  generate: ({ input }) =>
    helperInstructions([
      { wait: '5ms' },
      { run: 'createTodo', as: input.target, with: { id: input.id, text: 'Created after a helper wait' } },
    ]),
})

const compilerHelpers = composeScenarioHelpers([
  { source: 'shared Scenario helper catalogue', helpers: sharedScenarioHelpers },
  { source: 'compiler test helpers', helpers: defineScenarioHelpers({ seededActions, waitThenCreate }) },
])

const compile = (
  source: string,
  options: {
    readonly fileName?: string
    readonly parameters?: Readonly<Record<string, string | number | boolean>>
    readonly seed?: number
  } = {},
) =>
  compileScenarioYamlSource({
    fileName: options.fileName ?? 'example.scenario.yaml',
    source,
    applications: scenarioApplications,
    helpers: compilerHelpers,
    parameters: options.parameters,
    seed: options.seed,
  })

describe('YAML Scenario compiler', () => {
  it('derives identity and defaults while preserving readable instruction order', () => {
    const scenario = compile(`
application: todo
clients:
  client-a:
    sessions: [main]
do:
  - note: Create one todo.
  - run: createTodo
    as: client-a/main
    with:
      id: todo-1
      text: Readable
`)

    expect(scenario).toMatchObject({
      id: 'example',
      description: '',
      tags: [],
      seed: 0,
      applicationId: 'scenario-todo-app',
      topology: {
        storeId: 'scenario-example',
        clients: [{ id: 'client-a', sessions: ['main'], initiallyConnected: true }],
      },
    })
    expect(scenario.instructions.map(({ _tag, id }) => [_tag, id])).toEqual([
      ['annotation', 'note-0001'],
      ['action', 'action-0001'],
    ])
    expect(scenario.oracles.map(({ _tag }) => _tag)).toEqual(['pending-resolution', 'eventlog-convergence'])
  })

  it('replaces all defaults when explicit final expectations are present', () => {
    const scenario = compile(`
application: todo
clients:
  client-a:
    sessions: [main]
  client-b:
    sessions: [main]
participants:
  both: [client-a/main, client-b/main]
do: []
expect:
  participants: both
  state:
    todos:
      converge: true
      containsIds: [todo-1, todo-2]
`)

    expect(scenario.oracles.map(({ _tag }) => _tag)).toEqual(['state-convergence', 'state-contains-ids'])
    expect(scenario.oracles.every((oracle) => 'participants' in oracle && oracle.participants.length === 2)).toBe(true)
  })

  it('expands simple parameterized repetition and interpolation', () => {
    const scenario = compile(
      `
application: todo
parameters:
  count:
    type: integer
    default: 2
clients:
  client-a:
    sessions: [main]
do:
  - repeat:
      times: \${count}
      as: item
      action:
        run: createTodo
        as: client-a/main
        with:
          id: todo-\${pad(item, 2)}
          text: Item \${item}
`,
      { parameters: { count: 3 } },
    )
    const sequence = scenario.instructions[0]

    expect(sequence).toEqual(
      expect.objectContaining({
        _tag: 'action-sequence',
        actions: [
          expect.objectContaining({ input: { id: 'todo-01', text: 'Item 1' } }),
          expect.objectContaining({ input: { id: 'todo-02', text: 'Item 2' } }),
          expect.objectContaining({ input: { id: 'todo-03', text: 'Item 3' } }),
        ],
      }),
    )
  })

  it('expands registered TypeScript helpers deterministically and validates their actions', () => {
    const source = `
application: todo
seed: 12
clients:
  client-a:
    sessions: [main]
do:
  - generate: seededActions
    with:
      target: client-a/main
      count: 3
    expect: all-finish
`
    const first = compile(source)
    const same = compile(source)
    const different = compile(source, { seed: 13 })
    const firstSequence = first.instructions[0]
    const differentSequence = different.instructions[0]

    expect(first).toEqual(same)
    expect(firstSequence).toEqual(expect.objectContaining({ _tag: 'action-sequence' }))
    expect(firstSequence).not.toEqual(differentSequence)
    expect(first.oracles).toContainEqual(
      expect.objectContaining({
        _tag: 'operation-history',
        operationIds: expect.arrayContaining(['generate-0001:0001']),
      }),
    )
  })

  it('requires an explicit seed when a helper consumes deterministic randomness', () => {
    expect(() =>
      compile(`
application: todo
clients:
  client-a:
    sessions: [main]
do:
  - generate: seededActions
    with:
      target: client-a/main
      count: 1
`),
    ).toThrow("Helper 'seededActions' uses deterministic randomness and requires an explicit seed")
  })

  it('uses an application-neutral shared helper with application validation after expansion', () => {
    const scenario = compile(`
application: todo
clients:
  client-a:
    sessions: [main]
  client-b:
    sessions: [main]
participants:
  writers: [client-a/main, client-b/main]
do:
  - generate: distributeActions
    with:
      action: createTodo
      participants: writers
      strategy: round-robin
      inputs:
        - { id: todo-a, text: A }
        - { id: todo-b, text: B }
`)
    const sequence = scenario.instructions[0]
    expect(sequence).toEqual(expect.objectContaining({ _tag: 'action-sequence' }))
    if (sequence?._tag !== 'action-sequence') return
    expect(sequence.actions.map(({ target, input }) => [target.clientId, input])).toEqual([
      ['client-a', { id: 'todo-a', text: 'A' }],
      ['client-b', { id: 'todo-b', text: 'B' }],
    ])
  })

  it('expands arbitrary declarative instructions without changing the runner vocabulary', () => {
    const scenario = compile(`
application: todo
clients:
  client-a:
    sessions: [main]
do:
  - generate: waitThenCreate
    with:
      target: client-a/main
      id: helper-created
`)

    expect(scenario.instructions).toEqual([
      { _tag: 'wait', id: 'wait-0001', durationMs: 5 },
      expect.objectContaining({
        _tag: 'action',
        id: 'action-0001',
        input: { id: 'helper-created', text: 'Created after a helper wait' },
      }),
    ])
  })

  it('rejects helper name collisions rather than applying precedence', () => {
    expect(() =>
      composeScenarioHelpers([
        { source: 'shared', helpers: defineScenarioHelpers({ waitThenCreate }) },
        { source: 'companion', helpers: defineScenarioHelpers({ waitThenCreate }) },
      ]),
    ).toThrow("Duplicate Scenario helper 'waitThenCreate' from shared and companion")
  })

  it('normalizes waits and fixed-delay pacing', () => {
    const scenario = compile(`
application: todo
clients:
  client-a:
    sessions: [main]
do:
  - wait: 250ms
  - repeat:
      times: 2
      as: item
      between: 3s
      action:
        run: createTodo
        as: client-a/main
        with:
          id: todo-\${item}
          text: Timed
`)

    expect(scenario.instructions[0]).toEqual({ _tag: 'wait', id: 'wait-0001', durationMs: 250 })
    expect(scenario.instructions[1]).toEqual(expect.objectContaining({ delayBetweenActionsMs: 3_000 }))
  })

  it('reports semantic and application-input paths', () => {
    expect(() =>
      compile(`
application: todo
clients:
  client-a:
    sessions: [main]
do:
  - run: createTodo
    as: client-a/missing
    with:
      id: todo-1
      text: Missing participant
`),
    ).toThrow("example.scenario.yaml:$.do[0].as: Unknown participant 'client-a/missing' at this source position")

    expect(() =>
      compile(`
application: todo
clients:
  client-a:
    sessions: [main]
do:
  - run: createTodo
    as: client-a/main
    with:
      id: 42
      text: Wrong type
`),
    ).toThrow(/example\.scenario\.yaml:\$\.do\[0\]: Invalid input for action 'createTodo'/)
  })

  it('rejects unknown properties, duplicate YAML keys, aliases, unknown overrides, and invalid durations', () => {
    expect(() => compile('application: todo\nprofile: browser\nclients: {}\ndo: []\n')).toThrow(
      "Unknown property 'profile'",
    )
    expect(() => compile('application: todo\napplication: todo\nclients: {}\ndo: []\n')).toThrow(
      /Map keys must be unique/,
    )
    expect(() => compile('application: todo\nclients: &clients {}\ndo: []\ncopy: *clients\n')).toThrow()
    expect(() =>
      compile(
        'application: todo\nparameters:\n  count:\n    type: integer\n    default: 1\nclients:\n  client-a:\n    sessions: [main]\ndo: []\n',
        { parameters: { unknown: 2 } },
      ),
    ).toThrow("Unknown parameter override 'unknown'")
    expect(() =>
      compile('application: todo\nclients:\n  client-a:\n    sessions: [main]\ndo:\n  - wait: 0ms\n'),
    ).toThrow("Expected a positive duration in ms, s, or m; received '0ms'")
  })
})
