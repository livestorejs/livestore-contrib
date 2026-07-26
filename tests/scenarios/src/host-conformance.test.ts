import fs from 'node:fs/promises'

import { expect } from 'vitest'

import { Vitest } from '@livestore/utils-dev/node-vitest'
import type { WranglerDevServer } from '@livestore/utils-dev/wrangler'
import { Effect, Exit, FetchHttpClient, Layer, Schema, type Scope } from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

import { participantHostFailure, ScenarioOperationError } from './application.ts'
import { makeLocalSyncCfScenarioBackend, makeMockScenarioBackend } from './backends.ts'
import { browserHostCapabilities, makeBrowserHost } from './browser/browser-host.ts'
import { todoApplication } from './fixtures/todo-application.ts'
import { inProcessHostCapabilities, makeInProcessHost, type HostError, type ParticipantHost } from './host.ts'
import {
  defineScenario,
  type ExecutionConfiguration,
  type HostCapabilities,
  type ScenarioAst,
  ScenarioRunArtifact,
} from './model.ts'
import { makeProcessHost, processHostCapabilities } from './process/process-host.ts'
import { runScenario } from './runner.ts'

interface HostConformanceFixture {
  readonly host: ParticipantHost
  readonly resources: () => HostResources
}

interface HostResources {
  readonly processIds: ReadonlyArray<number>
  readonly profileDirectories: ReadonlyArray<string>
}

interface HostConformanceProfile {
  readonly capabilities: HostCapabilities
  readonly execution: ExecutionConfiguration
  readonly makeFixture: Effect.Effect<
    HostConformanceFixture,
    HostError | WranglerDevServer.WranglerDevServerError,
    Scope.Scope
  >
}

const makeLocalBackend = makeLocalSyncCfScenarioBackend.pipe(
  Effect.provide(Layer.mergeAll(PlatformNode.NodeServices.layer, FetchHttpClient.layer)),
)

const profiles: ReadonlyArray<HostConformanceProfile> = [
  {
    capabilities: inProcessHostCapabilities,
    execution: { participantProfile: 'in-process', syncBackend: 'mock', stateProfile: 'sqlite' },
    makeFixture: Effect.gen(function* () {
      const backend = yield* makeMockScenarioBackend
      const host = yield* makeInProcessHost({ application: todoApplication, backend })
      return { host, resources: emptyResources }
    }),
  },
  {
    capabilities: processHostCapabilities,
    execution: { participantProfile: 'process', syncBackend: 'local-sync-cf', stateProfile: 'sqlite' },
    makeFixture: Effect.gen(function* () {
      const backend = yield* makeLocalBackend
      const host = yield* makeProcessHost({ applicationId: todoApplication.id, backend })
      return {
        host,
        resources: () => ({ processIds: host.processIds(), profileDirectories: [] }),
      }
    }),
  },
  {
    capabilities: browserHostCapabilities,
    execution: { participantProfile: 'browser', syncBackend: 'local-sync-cf', stateProfile: 'opfs' },
    makeFixture: Effect.gen(function* () {
      const backend = yield* makeLocalBackend
      const host = yield* makeBrowserHost({ applicationId: todoApplication.id, backend })
      return {
        host,
        resources: () => ({ processIds: [], profileDirectories: host.profileDirectories() }),
      }
    }),
  },
]

const hostConformanceTimeout = (profile: HostCapabilities['profile']): number =>
  profile === 'browser' ? 180_000 : profile === 'process' ? 90_000 : 20_000

/** Verifies: LS.SYS.VER.SCEN-R04, LS.SYS.VER.SCEN-R05, LS.SYS.VER.SCEN-R08 */
Vitest.describe.each(profiles)('$capabilities.profile host contract', (profile) => {
  const timeout = hostConformanceTimeout(profile.capabilities.profile)
  Vitest.live(
    'passes the shared capability-driven conformance suite',
    (test) => exerciseHostConformance(profile).pipe(Vitest.withTestCtx(test, { timeout })),
    timeout,
  )
})

const exerciseHostConformance = (profile: HostConformanceProfile) =>
  Effect.gen(function* () {
    let resources: HostResources = emptyResources()
    yield* Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* profile.makeFixture
        expect(fixture.host.capabilities).toEqual(profile.capabilities)

        const artifact = yield* runScenario({
          scenario: makeConformanceScenario(profile.capabilities),
          applicationId: todoApplication.id,
          host: fixture.host,
          workloads: todoApplication.workloads,
          options: {
            runId: `host-conformance:${profile.capabilities.profile}`,
            sourceRevision: 'test',
            execution: profile.execution,
          },
        })
        expectPassingHostContract(artifact)

        const definiteFailure = yield* fixture.host
          .createClient({
            operationId: 'duplicate-conformance-a',
            storeId: `host-conformance-${profile.capabilities.profile}`,
            client: {
              id: 'conformance-a',
              sessions: ['session-a'],
              initiallyConnected: true,
            },
          })
          .pipe(Effect.flip)
        expect(definiteFailure).toBeInstanceOf(ScenarioOperationError)
        if (definiteFailure instanceof ScenarioOperationError) {
          expect(definiteFailure.code).toBe('duplicate-client')
          expect(definiteFailure.operationOutcome).toBe('definite-failure')
        }

        const indefiniteFailure = yield* runScenario({
          scenario: makeFailureScenario({ profile: profile.capabilities.profile, suffix: 'indefinite' }),
          applicationId: todoApplication.id,
          host: {
            ...fixture.host,
            dispatchAction: () =>
              Effect.fail(
                participantHostFailure({
                  code: 'host-response-timeout',
                  message: 'Synthetic lost response at the portable host boundary',
                  operationOutcome: 'indefinite',
                }),
              ),
          },
          options: {
            runId: `host-conformance:${profile.capabilities.profile}:indefinite`,
            sourceRevision: 'test',
            execution: profile.execution,
          },
        })
        expectOperationOutcome(indefiniteFailure, 'indefinite')

        let createClientCalls = 0
        const preflightExit = yield* runScenario({
          scenario: makeUnsupportedScenario(profile.capabilities),
          applicationId: todoApplication.id,
          host: {
            ...fixture.host,
            createClient: (command) =>
              Effect.sync(() => {
                createClientCalls += 1
                return command
              }).pipe(Effect.flatMap(fixture.host.createClient)),
          },
          options: {
            runId: `host-conformance:${profile.capabilities.profile}:preflight`,
            sourceRevision: 'test',
            execution: profile.execution,
          },
        }).pipe(Effect.exit)
        expect(Exit.isFailure(preflightExit)).toBe(true)
        expect(createClientCalls).toBe(0)

        resources = fixture.resources()
        for (const processId of resources.processIds) expect(processIsAlive(processId)).toBe(true)
        for (const directory of resources.profileDirectories) expect(yield* pathExists(directory)).toBe(true)
      }),
    )

    for (const processId of resources.processIds) expect(processIsAlive(processId)).toBe(false)
    for (const directory of resources.profileDirectories) expect(yield* pathExists(directory)).toBe(false)
  })

const makeConformanceScenario = (capabilities: HostCapabilities): ScenarioAst => {
  const supportsDynamicSessionAddition = capabilities.capabilities.includes('dynamic-session-addition')
  const supportsSessionRestart = capabilities.capabilities.includes('session-restart')
  const supportsClientRestart = capabilities.capabilities.includes('client-restart')
  const supportsBackendAvailability = capabilities.capabilities.includes('backend-availability')
  const sessionA = { clientId: 'conformance-a', sessionId: 'session-a' } as const
  const sessionA2 = { clientId: 'conformance-a', sessionId: 'session-a2' } as const
  const sessionB = { clientId: 'conformance-b', sessionId: 'session-b' } as const

  return defineScenario({
    version: 1,
    id: `host-conformance-${capabilities.profile}`,
    description: 'Shared host contract scenario derived from advertised capabilities.',
    tags: ['host-conformance'],
    seed: 1,
    applicationId: todoApplication.id,
    requires: [],
    topology: {
      storeId: `host-conformance-${capabilities.profile}`,
      clients: [
        {
          id: sessionA.clientId,
          sessions: [sessionA.sessionId],
          initiallyConnected: true,
        },
      ],
    },
    phases: [
      {
        id: 'operations',
        description: 'Exercise shared action and connectivity controls.',
        steps: [
          {
            _tag: 'action',
            id: 'write-a',
            target: sessionA,
            action: 'createTodo',
            input: { id: 'conformance-a', text: 'Written by Client A' },
          },
          {
            _tag: 'create-client',
            id: 'create-b',
            client: { id: sessionB.clientId, sessions: [sessionB.sessionId], initiallyConnected: true },
          },
          {
            _tag: 'workload',
            id: 'seeded-workload',
            workload: 'createTodoBurst',
            input: { idPrefix: 'conformance-workload', textPrefix: 'Generated conformance task' },
            targets: [sessionA, sessionB],
            count: 2,
          },
          ...(supportsDynamicSessionAddition === true
            ? [
                { _tag: 'add-session' as const, id: 'add-a2', target: sessionA2 },
                {
                  _tag: 'action' as const,
                  id: 'write-from-a2',
                  target: sessionA2,
                  action: 'createTodo',
                  input: { id: 'conformance-a2', text: 'Written by a dynamically added session' },
                },
              ]
            : []),
          { _tag: 'disconnect', id: 'disconnect-b', clientId: sessionB.clientId },
          {
            _tag: 'action',
            id: 'write-b-offline',
            target: sessionB,
            action: 'createTodo',
            input: { id: 'conformance-b', text: 'Written by Client B while offline' },
          },
          { _tag: 'reconnect', id: 'reconnect-b', clientId: sessionB.clientId },
          ...(supportsBackendAvailability === true
            ? [
                { _tag: 'backend-unavailable' as const, id: 'backend-unavailable' },
                {
                  _tag: 'action' as const,
                  id: 'write-during-backend-outage',
                  target: sessionA,
                  action: 'createTodo',
                  input: { id: 'conformance-backend-outage', text: 'Retained while the backend is unavailable' },
                },
                { _tag: 'backend-available' as const, id: 'backend-available' },
              ]
            : []),
          ...(supportsSessionRestart === true
            ? [
                { _tag: 'stop-session' as const, id: 'stop-a2', target: sessionA2 },
                {
                  _tag: 'action' as const,
                  id: 'write-while-a2-stopped',
                  target: sessionA,
                  action: 'createTodo',
                  input: { id: 'conformance-lifecycle', text: 'Sibling session remains isolated' },
                },
                { _tag: 'restart-session' as const, id: 'restart-a2', target: sessionA2 },
              ]
            : []),
          ...(supportsClientRestart === true
            ? [{ _tag: 'restart-client' as const, id: 'restart-a', clientId: sessionA.clientId }]
            : []),
          {
            _tag: 'settle',
            id: 'settle-conformance',
            participants:
              supportsDynamicSessionAddition === true ? [sessionA, sessionA2, sessionB] : [sessionA, sessionB],
            healDisconnectedClients: [],
            timeoutMs: 15_000,
          },
        ],
      },
    ],
    oracles: [
      {
        _tag: 'pending-resolution',
        id: 'all-pending-resolved',
        participants: supportsDynamicSessionAddition === true ? [sessionA, sessionA2, sessionB] : [sessionA, sessionB],
      },
      {
        _tag: 'state-convergence',
        id: 'state-converged',
        participants: supportsDynamicSessionAddition === true ? [sessionA, sessionA2, sessionB] : [sessionA, sessionB],
        inspector: 'todos',
      },
    ],
  })
}

const makeFailureScenario = (args: { profile: HostCapabilities['profile']; suffix: string }): ScenarioAst => {
  const clientId = `failure-${args.suffix}`
  const sessionId = `session-${args.suffix}`
  return defineScenario({
    version: 1,
    id: `host-conformance-${args.profile}-${args.suffix}`,
    description: 'Exercises the portable host failure boundary.',
    tags: ['host-conformance', 'failure'],
    seed: 2,
    applicationId: todoApplication.id,
    requires: [],
    topology: {
      storeId: `host-conformance-${args.profile}`,
      clients: [{ id: clientId, sessions: [sessionId], initiallyConnected: true }],
    },
    phases: [
      {
        id: 'failure',
        description: 'Dispatch an operation that the host rejects.',
        steps: [
          {
            _tag: 'action',
            id: `failing-action-${args.suffix}`,
            target: { clientId, sessionId },
            action: 'unknownConformanceAction',
            input: {},
          },
        ],
      },
    ],
    oracles: [],
  })
}

const makeUnsupportedScenario = (capabilities: HostCapabilities): ScenarioAst => {
  const unsupported = capabilities.capabilities.includes('client-restart') === true ? 'event-lineage' : 'client-restart'
  return defineScenario({
    version: 1,
    id: `host-conformance-${capabilities.profile}-unsupported`,
    description: 'Must fail preflight before participant creation.',
    tags: ['host-conformance', 'preflight'],
    seed: 3,
    applicationId: todoApplication.id,
    requires: [unsupported],
    topology: {
      storeId: `host-conformance-${capabilities.profile}`,
      clients: [{ id: 'unsupported-client', sessions: ['unsupported-session'], initiallyConnected: true }],
    },
    phases: [],
    oracles: [],
  })
}

const expectPassingHostContract = (artifact: ScenarioRunArtifact): void => {
  expect(artifact.status).toBe('passed')
  expect(() => Schema.decodeUnknownSync(ScenarioRunArtifact)(artifact)).not.toThrow()

  const instructions = artifact.trace.filter(
    (record): record is typeof record & { readonly correlationId: string } =>
      record.origin === 'instruction' && record.correlationId !== null,
  )
  for (const instruction of instructions) {
    const outcome = artifact.trace.find(
      (record) =>
        record.correlationId === instruction.correlationId &&
        (record.origin === 'acknowledgement' || record.payload._tag === 'operation.outcome'),
    )
    expect(outcome, `missing outcome for ${instruction.correlationId}`).toBeDefined()
    expect(outcome?.causedBy).toContain(instruction.index)
  }

  const tags = artifact.trace.map((record) => record.payload._tag)
  expect(tags).toEqual(
    expect.arrayContaining([
      'client.created',
      'action.completed',
      'workload.requested',
      'workload.completed',
      'connectivity.disconnected',
      'connectivity.reconnected',
      'backend.observed',
      'session.sync.observed',
      'sync.snapshot',
      'state.snapshot',
      'settlement.completed',
    ]),
  )
  if (artifact.descriptor.capabilities.capabilities.includes('session-restart') === true) {
    expect(tags).toEqual(expect.arrayContaining(['lifecycle.session-stopped', 'lifecycle.session-restarted']))
    const stopped = artifact.trace.find((record) => record.payload._tag === 'lifecycle.session-stopped')!
    const isolatedWrite = artifact.trace.find(
      (record) => record.correlationId === 'write-while-a2-stopped' && record.payload._tag === 'action.completed',
    )!
    const restarted = artifact.trace.find((record) => record.payload._tag === 'lifecycle.session-restarted')!
    expect(stopped.index).toBeLessThan(isolatedWrite.index)
    expect(isolatedWrite.index).toBeLessThan(restarted.index)
  }
  if (artifact.descriptor.capabilities.capabilities.includes('dynamic-session-addition') === true) {
    expect(tags).toContain('lifecycle.session-added')
  }
  if (artifact.descriptor.capabilities.capabilities.includes('client-restart') === true) {
    expect(tags).toContain('lifecycle.client-restarted')
  }
  if (artifact.descriptor.capabilities.capabilities.includes('backend-availability') === true) {
    expect(tags).toContain('backend.availability.changed')
    expect(artifact.trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: { _tag: 'fault.injected', faultId: 'backend-unavailable', fault: 'backend-unavailable' },
        }),
        expect.objectContaining({
          payload: { _tag: 'fault.removed', faultId: 'backend-unavailable', fault: 'backend-unavailable' },
        }),
      ]),
    )
  }
}

const expectOperationOutcome = (artifact: ScenarioRunArtifact, expected: 'definite-failure' | 'indefinite'): void => {
  expect(artifact.status).toBe('failed')
  expect(artifact.trace.find((record) => record.payload._tag === 'operation.outcome')?.payload).toEqual(
    expect.objectContaining({ status: expected }),
  )
}

const emptyResources = (): HostResources => ({ processIds: [], profileDirectories: [] })

const processIsAlive = (processId: number): boolean => {
  try {
    process.kill(processId, 0)
    return true
  } catch {
    return false
  }
}

const pathExists = (filePath: string): Effect.Effect<boolean> =>
  Effect.promise(async () => {
    try {
      await fs.access(filePath)
      return true
    } catch {
      return false
    }
  })
