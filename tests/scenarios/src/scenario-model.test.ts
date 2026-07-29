Vitest.describe('scenario model', () => {
  Vitest.it('validates and round-trips the versioned serializable AST', () => {
    const encoded = JSON.parse(JSON.stringify(offlineWriterRecovery))
    expect(defineScenario(encoded)).toEqual(offlineWriterRecovery)
  })

  Vitest.it('retains a seeded workload as one compact serializable step', () => {
    const encoded = JSON.parse(JSON.stringify(seededTodoWorkload))
    const decoded = defineScenario(encoded)
    const workloadSteps = decoded.phases.flatMap((phase) => phase.steps).filter((step) => step._tag === 'workload')

    expect(decoded).toEqual(seededTodoWorkload)
    expect(workloadSteps).toEqual([
      expect.objectContaining({ id: 'create-seeded-todos', workload: 'createTodoBurst', count: 12 }),
    ])
    expect(decoded.phases.flatMap((phase) => phase.steps).some((step) => step._tag === 'action')).toBe(false)
    expect(deriveScenarioRequirements(decoded)).toContain('named-actions')
  })

  Vitest.it('rejects empty or unbounded workload counts', () => {
    const workloadStep = seededTodoWorkload.phases[0]!.steps[0]!
    for (const count of [0, 10_001]) {
      expect(() =>
        defineScenario({
          ...seededTodoWorkload,
          id: `invalid-workload-count-${count}`,
          phases: [
            {
              ...seededTodoWorkload.phases[0]!,
              steps: [{ ...workloadStep, count }, seededTodoWorkload.phases[0]!.steps[1]!],
            },
          ],
        }),
      ).toThrow('Workload count must be between 1 and 10000')
    }
  })

  Vitest.it('validates dynamic participant additions in plan order', () => {
    const scenario = defineScenario({
      version: 1,
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
      phases: [
        {
          id: 'join',
          description: 'Create the late participants.',
          steps: [
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
        version: 1,
        id: 'dynamic-topology-use-before-create',
        description: 'Invalid ordering.',
        tags: ['topology'],
        seed: 1,
        applicationId: todoApplication.id,
        requires: [],
        topology: { storeId: 'dynamic-topology-invalid', clients: [] },
        phases: [
          {
            id: 'join',
            description: 'Uses the Client too early.',
            steps: [
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
        phases: offlineWriterRecovery.phases.map((phase) => ({
          ...phase,
          steps: phase.steps.filter((step) => step._tag !== 'settle'),
        })),
      }),
    ).toThrow('Snapshot-based oracles require a terminal Settlement')
  })

  Vitest.it('rejects a modifying operation after the Settlement used by snapshot-based oracles', () => {
    const lastPhaseIndex = offlineWriterRecovery.phases.length - 1

    expect(() =>
      defineScenario({
        ...offlineWriterRecovery,
        id: 'stale-terminal-settlement',
        phases: offlineWriterRecovery.phases.map((phase, index) =>
          index === lastPhaseIndex
            ? {
                ...phase,
                steps: [
                  ...phase.steps,
                  {
                    _tag: 'action' as const,
                    id: 'write-after-settlement',
                    target: { clientId: 'client-a', sessionId: 'session-a' },
                    action: 'createTodo',
                    input: { id: 'too-late', text: 'This invalidates the Settlement evidence' },
                  },
                ],
              }
            : phase,
        ),
      }),
    ).toThrow('Snapshot-based oracles require a terminal Settlement')
  })

  Vitest.it('requires the terminal Settlement to cover every snapshot-oracle participant', () => {
    const lastPhaseIndex = offlineWriterRecovery.phases.length - 1

    expect(() =>
      defineScenario({
        ...offlineWriterRecovery,
        id: 'incomplete-terminal-settlement',
        phases: offlineWriterRecovery.phases.map((phase, index) =>
          index === lastPhaseIndex
            ? {
                ...phase,
                steps: phase.steps.map((step) =>
                  step._tag === 'settle'
                    ? { ...step, participants: [{ clientId: 'client-a', sessionId: 'session-a' }] }
                    : step,
                ),
              }
            : phase,
        ),
      }),
    ).toThrow('Terminal Settlement is missing snapshot-oracle participants: client-b/session-b')
  })

  Vitest.it('allows operation-history-only scenarios without Settlement', () => {
    const scenario = defineScenario({
      ...offlineWriterRecovery,
      id: 'history-without-settlement',
      phases: offlineWriterRecovery.phases.map((phase) => ({
        ...phase,
        steps: phase.steps.filter((step) => step._tag !== 'settle'),
      })),
      oracles: offlineWriterRecovery.oracles.filter((oracle) => oracle._tag === 'operation-history'),
    })

    expect(scenario.phases.flatMap((phase) => phase.steps).every((step) => step._tag !== 'settle')).toBe(true)
  })

  Vitest.it('allows a confirmed Eventlog prefix oracle without Settlement', () => {
    const scenario = defineScenario({
      ...offlineWriterRecovery,
      id: 'prefix-history-without-settlement',
      phases: offlineWriterRecovery.phases.map((phase) => ({
        ...phase,
        steps: phase.steps.filter((step) => step._tag !== 'settle'),
      })),
      oracles: offlineWriterRecovery.oracles.filter((oracle) => oracle._tag === 'confirmed-eventlog-prefix'),
    })

    expect(scenario.phases.flatMap((phase) => phase.steps).every((step) => step._tag !== 'settle')).toBe(true)
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

  Vitest.it('expands the shared workday into exactly 100 mixed application actions', () => {
    const steps = sharedTodoWorkday.phases.flatMap((phase) => phase.steps)
    const actionSteps = steps.filter((step) => step._tag === 'action')

    expect(actionSteps).toHaveLength(100)
    expect(new Set(actionSteps.map((step) => step.action))).toEqual(
      new Set(['createTodo', 'editTodo', 'setTodoCompleted', 'deleteTodo']),
    )
    expect(
      Object.fromEntries(
        [...Map.groupBy(actionSteps, (step) => step.action).entries()].map(([key, value]) => [key, value.length]),
      ),
    ).toEqual({
      createTodo: 30,
      editTodo: 28,
      setTodoCompleted: 32,
      deleteTodo: 10,
    })
    const completionInput = Schema.Struct({ id: Schema.String, completed: Schema.Boolean })
    expect(
      actionSteps
        .filter((step) => step.action === 'setTodoCompleted')
        .map((step) => Schema.decodeUnknownSync(completionInput)(step.input).completed)
        .filter((completed) => completed === false),
    ).toHaveLength(8)
    expect(sharedTodoWorkday.topology.clients).toHaveLength(3)

    const disconnectIndex = steps.findIndex((step) => step._tag === 'disconnect' && step.clientId === 'alice-phone')
    const reconnectIndex = steps.findIndex((step) => step._tag === 'reconnect' && step.clientId === 'alice-phone')
    const actionsBeforeDisconnect = steps.slice(0, disconnectIndex).filter((step) => step._tag === 'action')
    const actionsWhileDisconnected = steps
      .slice(disconnectIndex + 1, reconnectIndex)
      .filter((step) => step._tag === 'action')
    const actionsAfterReconnect = steps.slice(reconnectIndex + 1).filter((step) => step._tag === 'action')
    const offlinePhoneActions = actionsWhileDisconnected.filter((step) => step.target.clientId === 'alice-phone')

    expect([actionsBeforeDisconnect.length, actionsWhileDisconnected.length, actionsAfterReconnect.length]).toEqual([
      33, 34, 33,
    ])
    expect(offlinePhoneActions).toHaveLength(6)
    expect(new Set(offlinePhoneActions.map((step) => step.action))).toEqual(
      new Set(['createTodo', 'editTodo', 'setTodoCompleted', 'deleteTodo']),
    )
    expect(
      steps
        .slice(disconnectIndex + 1, reconnectIndex)
        .filter((step) => step._tag === 'settle')
        .every((step) => step.participants.every((participant) => participant.clientId !== 'alice-phone')),
    ).toBe(true)
  })

  Vitest.it('decodes the tracked version-3/version-4 reference artifacts without migration', () => {
    for (const name of [
      'reference-offline-writer-recovery-browser-failure.json.gz',
      'reference-shared-todo-workday-browser-failure.json.gz',
    ]) {
      const json = gunzipSync(readFileSync(new URL(`../artifacts/${name}`, import.meta.url))).toString('utf8')
      const artifact = Schema.decodeUnknownSync(Schema.fromJsonString(ScenarioRunArtifact))(json)
      expect(artifact.artifactVersion).toBe(4)
      expect(artifact.descriptor.traceVersion).toBe(3)
    }
  })
})
import {
  ScenarioRunArtifact,
  Schema,
  Vitest,
  browserMultiSessionRecovery,
  defineScenario,
  deriveScenarioRequirements,
  deriveScenarioTopology,
  expect,
  gunzipSync,
  offlineWriterRecovery,
  readFileSync,
  seededTodoWorkload,
  sharedTodoWorkday,
  todoApplication,
} from './test-support/scenario-test-kit.ts'

