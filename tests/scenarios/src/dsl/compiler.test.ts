import { describe, expect, it } from 'vitest'

import { scenarioApplications } from '../corpus/applications/registry.ts'
import { compileScenarioSource, ScenarioDslError } from './compiler.ts'

const compile = (
  source: string,
  options: {
    readonly fileName?: string
    readonly parameters?: Readonly<Record<string, string | number | boolean>>
  } = {},
) =>
  compileScenarioSource({
    fileName: options.fileName ?? 'example.scenario',
    source,
    applications: scenarioApplications,
    parameters: options.parameters,
  })

describe('Scenario DSL compiler', () => {
  it('derives identity and defaults while preserving the readable instruction order', () => {
    const scenario = compile(`
application todo
client client-a with main

note "Create one todo."
client-a/main runs createTodo with
  id: "todo-1"
  text: "Readable"
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

  it('replaces all defaults when any explicit final expectation block is present', () => {
    const scenario = compile(`
application todo
client client-a with main
client client-b with main
participants both = client-a/main, client-b/main

expect both:
  todos converges
  todos contains ids "todo-1", "todo-2"
`)

    expect(scenario.oracles.map(({ _tag }) => _tag)).toEqual(['state-convergence', 'state-contains-ids'])
    expect(scenario.oracles.every((oracle) => 'participants' in oracle && oracle.participants.length === 2)).toBe(true)
  })

  it('expands parameterized, seeded repetition deterministically', () => {
    const source = `
application todo
seed 12
parameter count: integer = 2
client client-a with main

repeat count times as item:
  let variant = randomInt(100, key: "variant")
  client-a/main runs createTodo with
    id: "todo-${'${pad(item, 2)}'}"
    text: "Variant ${'${variant}'}"
`
    const first = compile(source)
    const same = compile(source)
    const overridden = compile(source, { parameters: { count: 3 } })
    const sequence = first.instructions.find((instruction) => instruction._tag === 'action-sequence')

    expect(first).toEqual(same)
    expect(sequence?._tag === 'action-sequence' ? sequence.actions : []).toHaveLength(2)
    expect(overridden.instructions.find((instruction) => instruction._tag === 'action-sequence')).toEqual(
      expect.objectContaining({
        actions: expect.arrayContaining([expect.objectContaining({ id: 'repeat-0001:0003' })]),
      }),
    )
  })

  it('normalizes explicit waits and fixed-delay repeat pacing', () => {
    const scenario = compile(`
application todo
client client-a with main
wait 250ms
repeat 2 times as item with 3s between:
  client-a/main runs createTodo with
    id: "todo-${'${item}'}"
    text: "Timed"
`)

    expect(scenario.instructions[0]).toEqual({ _tag: 'wait', id: 'wait-0001', durationMs: 250 })
    expect(scenario.instructions[1]).toEqual(expect.objectContaining({ delayBetweenActionsMs: 3_000 }))
  })

  it('reports source locations for semantic and application-input errors', () => {
    expect(() =>
      compile(`
application todo
client client-a with main
client-a/missing runs createTodo with
  id: "todo-1"
  text: "Missing participant"
`),
    ).toThrow(
      new ScenarioDslError('example.scenario', 4, 1, "Unknown participant 'client-a/missing' at this source position"),
    )

    expect(() =>
      compile(`
application todo
client client-a with main
client-a/main runs createTodo with
  id: 42
  text: "Wrong type"
`),
    ).toThrow(/example\.scenario:4:1: Invalid input for action 'createTodo'/)
  })

  it('rejects profile declarations, tabs, unknown overrides, and instructions after final expectations', () => {
    expect(() => compile('application todo\nprofile browser\nclient client-a with main\n')).toThrow(
      "Unknown instruction 'profile browser'",
    )
    expect(() => compile('application todo\nclient client-a with main\n\tnote "tab"\n')).toThrow('Tabs are not allowed')
    expect(() =>
      compile('application todo\nparameter count: integer = 1\nclient client-a with main\n', {
        parameters: { unknown: 2 },
      }),
    ).toThrow("Unknown parameter override 'unknown'")
    expect(() =>
      compile('application todo\nclient client-a with main\nexpect client-a/main:\n  pending resolved\nnote "late"\n'),
    ).toThrow('Instructions cannot follow final expectations')
    expect(() => compile('application todo\nclient client-a with main\nwait 0ms\n')).toThrow(
      "Expected a positive duration in ms, s, or m; received '0ms'",
    )
  })
})
