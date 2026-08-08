import {
  Vitest,
  browserMultiSessionRecovery,
  defineScenario,
  deriveScenarioRequirements,
  deriveScenarioTopology,
  expect,
  offlineWriterRecovery,
  makeSeededTodoActions,
  seededTodoActions,
  todoApplication,
} from '../test-support/scenario-test-kit.ts'

Vitest.describe('scenario model', () => {
  Vitest.it('validates and round-trips the versioned serializable AST', () => {
    const encoded = JSON.parse(JSON.stringify(offlineWriterRecovery))
    expect(defineScenario(encoded)).toEqual(offlineWriterRecovery)
  })

  Vitest.it('accepts only the current Scenario format', () => {
    expect(() => defineScenario({ ...offlineWriterRecovery, version: 1 })).toThrow('Invalid scenario AST')
  })

  Vitest.it('expands Scenario-owned repetition into one self-contained serializable action sequence', () => {
    const encoded = JSON.parse(JSON.stringify(seededTodoActions))
    const decoded = defineScenario(encoded)
    const sequence = decoded.instructions.find((instruction) => instruction._tag === 'action-sequence')

    expect(decoded).toEqual(seededTodoActions)
    expect(sequence).toEqual(expect.objectContaining({ id: 'create-seeded-todos' }))
    expect(sequence?._tag === 'action-sequence' ? sequence.actions : []).toHaveLength(40)
    expect(decoded.instructions.some((instruction) => instruction._tag === 'action')).toBe(false)
    expect(deriveScenarioRequirements(decoded)).toContain('named-actions')
  })

  Vitest.it('derives keyed actions deterministically while keeping IDs stable across seeds', () => {
    const first = makeSeededTodoActions(1445).instructions.find(
      (instruction) => instruction._tag === 'action-sequence',
    )!
    const same = makeSeededTodoActions(1445).instructions.find((instruction) => instruction._tag === 'action-sequence')!
    const different = makeSeededTodoActions(1446).instructions.find(
      (instruction) => instruction._tag === 'action-sequence',
    )!
    if (first._tag !== 'action-sequence' || same._tag !== 'action-sequence' || different._tag !== 'action-sequence') {
      throw new Error('Expected generated action sequences')
    }
    expect(first.actions).toEqual(same.actions)
    expect(first.actions.map(({ id }) => id)).toEqual(different.actions.map(({ id }) => id))
    expect(first.actions).not.toEqual(different.actions)
  })

  Vitest.it('rejects empty or unbounded repeated action counts', () => {
    for (const count of [0, 10_001]) {
      expect(() =>
        defineScenario(({ repeatActions }) => ({
          ...seededTodoActions,
          id: `invalid-action-count-${count}`,
          instructions: [
            repeatActions({
              id: 'invalid-actions',
              description: 'Invalid actions',
              count,
              generate: () => ({
                target: { clientId: 'client-a', sessionId: 'session-a' },
                action: 'createTodo',
                input: { id: 'invalid', text: 'Invalid' },
              }),
            }),
          ],
          oracles: [],
        })),
      ).toThrow('Repeated action count must be between 1 and 10000')
    }
  })

  Vitest.it('validates dynamic participant additions in plan order', () => {
    const scenario = defineScenario({
      version: 3,
      id: 'dynamic-topology-model',
      description: 'Adds a Client and a session after startup.',
      tags: ['topology'],
      seed: 1,
      applicationId: todoApplication.id,
      requires: [],
      topology: {
        storeId: 'dynamic-topology-model',
        clients: [{ id: 'client-a', sessions: ['session-a'], initiallyConnected: true }],
      },
      instructions: [
        {
          _tag: 'create-client',
          id: 'create-b',
          client: { id: 'client-b', sessions: ['session-b'], initiallyConnected: true },
        },
        {
          _tag: 'add-session',
          id: 'add-a2',
          target: { clientId: 'client-a', sessionId: 'session-a2' },
        },
        {
          _tag: 'action',
          id: 'write-b',
          target: { clientId: 'client-b', sessionId: 'session-b' },
          action: 'createTodo',
          input: { id: 'late', text: 'Late participant write' },
        },
      ],
      oracles: [],
    })

    expect(deriveScenarioTopology(scenario)).toEqual([
      { id: 'client-a', sessions: ['session-a', 'session-a2'], initiallyConnected: true },
      { id: 'client-b', sessions: ['session-b'], initiallyConnected: true },
    ])
    expect(deriveScenarioRequirements(scenario)).toEqual(
      expect.arrayContaining([
        'multiple-clients',
        'multiple-sessions',
        'dynamic-client-creation',
        'dynamic-session-addition',
      ]),
    )
  })

  Vitest.it('rejects participant use before its creation step', () => {
    expect(() =>
      defineScenario({
        version: 3,
        id: 'dynamic-topology-use-before-create',
        description: 'Invalid ordering.',
        tags: ['topology'],
        seed: 1,
        applicationId: todoApplication.id,
        requires: [],
        topology: { storeId: 'dynamic-topology-invalid', clients: [] },
        instructions: [
          {
            _tag: 'action',
            id: 'write-b-too-early',
            target: { clientId: 'client-b', sessionId: 'session-b' },
            action: 'createTodo',
            input: { id: 'late', text: 'Too early' },
          },
          {
            _tag: 'create-client',
            id: 'create-b',
            client: { id: 'client-b', sessions: ['session-b'], initiallyConnected: true },
          },
        ],
        oracles: [],
      }),
    ).toThrow('Unknown participant reference: client-b/session-b')
  })

  Vitest.it('derives host requirements from topology, operations, observations, and oracles', () => {
    expect(
      deriveScenarioRequirements(
        defineScenario({
          ...browserMultiSessionRecovery,
          requires: [],
        }),
      ),
    ).toEqual([
      'system-observation',
      'sync-observation',
      'multiple-sessions',
      'named-actions',
      'dynamic-session-addition',
      'session-restart',
      'client-restart',
      'state-inspection',
    ])
  })

  Vitest.it('requires a terminal Settlement for snapshot-based oracles', () => {
    expect(() =>
      defineScenario({
        ...offlineWriterRecovery,
        id: 'missing-terminal-settlement',
        instructions: offlineWriterRecovery.instructions.filter((instruction) => instruction._tag !== 'settle'),
      }),
    ).toThrow('Snapshot-based oracles require a terminal Settlement')
  })

  Vitest.it('allows annotations after the terminal executable Settlement', () => {
    const scenario = defineScenario({
      ...offlineWriterRecovery,
      id: 'annotation-after-terminal-settlement',
      instructions: [
        ...offlineWriterRecovery.instructions,
        { _tag: 'annotation', id: 'finished', text: 'The executable instructions are complete.' },
      ],
    })

    expect(scenario.instructions.at(-1)).toEqual(expect.objectContaining({ _tag: 'annotation', id: 'finished' }))
  })

  Vitest.it('rejects a modifying operation after the Settlement used by snapshot-based oracles', () => {
    expect(() =>
      defineScenario({
        ...offlineWriterRecovery,
        id: 'stale-terminal-settlement',
        instructions: [
          ...offlineWriterRecovery.instructions,
          {
            _tag: 'action' as const,
            id: 'write-after-settlement',
            target: { clientId: 'client-a', sessionId: 'session-a' },
            action: 'createTodo',
            input: { id: 'too-late', text: 'This invalidates the Settlement evidence' },
          },
        ],
      }),
    ).toThrow('Snapshot-based oracles require a terminal Settlement')
  })

  Vitest.it('requires the terminal Settlement to cover every snapshot-oracle participant', () => {
    expect(() =>
      defineScenario({
        ...offlineWriterRecovery,
        id: 'incomplete-terminal-settlement',
        instructions: offlineWriterRecovery.instructions.map((instruction) =>
          instruction._tag === 'settle'
            ? { ...instruction, participants: [{ clientId: 'client-a', sessionId: 'session-a' }] }
            : instruction,
        ),
      }),
    ).toThrow('Terminal Settlement is missing snapshot-oracle participants: client-b/session-b')
  })

  Vitest.it('allows operation-history-only scenarios without Settlement', () => {
    const scenario = defineScenario({
      ...offlineWriterRecovery,
      id: 'history-without-settlement',
      instructions: offlineWriterRecovery.instructions.filter((instruction) => instruction._tag !== 'settle'),
      oracles: offlineWriterRecovery.oracles.filter((oracle) => oracle._tag === 'operation-history'),
    })

    expect(scenario.instructions.every((instruction) => instruction._tag !== 'settle')).toBe(true)
  })

  Vitest.it('allows a confirmed Eventlog prefix oracle without Settlement', () => {
    const scenario = defineScenario({
      ...offlineWriterRecovery,
      id: 'prefix-history-without-settlement',
      instructions: offlineWriterRecovery.instructions.filter((instruction) => instruction._tag !== 'settle'),
      oracles: offlineWriterRecovery.oracles.filter((oracle) => oracle._tag === 'confirmed-eventlog-prefix'),
    })

    expect(scenario.instructions.every((instruction) => instruction._tag !== 'settle')).toBe(true)
  })

  Vitest.it('requires a non-empty, unique participant selection for confirmed Eventlog prefix evidence', () => {
    const prefixOracle = offlineWriterRecovery.oracles.find((oracle) => oracle._tag === 'confirmed-eventlog-prefix')!
    expect(() =>
      defineScenario({
        ...offlineWriterRecovery,
        id: 'empty-prefix-selection',
        oracles: [{ ...prefixOracle, participants: [] }],
      }),
    ).toThrow('must select at least one participant')
    expect(() =>
      defineScenario({
        ...offlineWriterRecovery,
        id: 'duplicate-prefix-selection',
        oracles: [{ ...prefixOracle, participants: [prefixOracle.participants[0]!, prefixOracle.participants[0]!] }],
      }),
    ).toThrow('selects participant more than once')
  })
})
