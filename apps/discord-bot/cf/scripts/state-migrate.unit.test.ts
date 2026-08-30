import {
  copyStage,
  remoteAuthorityExitCode,
  safeLogRecord,
  STACK,
  STAGE,
  verifyEqualExitCode,
  verifyRemoteAuthoritative,
  type MigrationSummary,
} from './state-migrate.ts'
import type { PersistedState, StateService } from 'alchemy/State'
import * as Effect from 'effect/Effect'
import { describe, expect, it } from 'vitest'

const makeResource = (fqn: string, secret: string): PersistedState => ({
  kind: 'resource',
  resourceType: 'cloudflare:Worker',
  namespace: undefined,
  fqn,
  logicalId: fqn,
  instanceId: `instance-${fqn}`,
  providerVersion: 1,
  status: 'created',
  downstream: [],
  bindings: [],
  props: { secret },
  attr: { deployed: true },
})

const makeAuthorityResource = (
  workerName: string,
  botStateNamespaceId: string,
  deployedVersion: string,
): PersistedState => ({
  kind: 'resource',
  resourceType: 'Cloudflare.Worker',
  namespace: undefined,
  fqn: 'DiscordBot',
  logicalId: 'DiscordBot',
  instanceId: `instance-${deployedVersion}`,
  providerVersion: 1,
  status: 'created',
  downstream: [],
  bindings: [],
  props: { deployedVersion },
  attr: {
    workerName,
    durableObjectNamespaces: { BotState: botStateNamespaceId },
    deployedVersion,
  },
})

interface FakeState {
  readonly service: StateService
  readonly records: Map<string, PersistedState>
  readonly setValues: Array<{ readonly fqn: string; readonly value: PersistedState }>
  readonly setOutputValues: unknown[]
  readonly deleteCalls: { count: number }
  readonly deleteStackCalls: { count: number }
  readonly output: () => unknown
}

const makeFakeState = (input?: {
  readonly records?: Readonly<Record<string, PersistedState>>
  readonly output?: unknown
}): FakeState => {
  const records = new Map(Object.entries(input?.records ?? {}))
  let output = input?.output
  const setValues: FakeState['setValues'] = []
  const setOutputValues: unknown[] = []
  const deleteCalls = { count: 0 }
  const deleteStackCalls = { count: 0 }

  const service: StateService = {
    id: 'fake',
    getVersion: () => Effect.succeed(4),
    listStacks: () =>
      Effect.succeed(records.size > 0 || output !== undefined ? [STACK] : []),
    listStages: (stack) =>
      Effect.succeed(
        stack === STACK && (records.size > 0 || output !== undefined)
          ? [STAGE]
          : [],
      ),
    get: ({ stack, stage, fqn }) =>
      Effect.succeed(
        stack === STACK && stage === STAGE ? records.get(fqn) : undefined,
      ),
    getReplacedResources: () =>
      Effect.succeed(
        [...records.values()].filter((record) => record.status === 'replaced'),
      ),
    set: ({ stack, stage, fqn, value }) =>
      Effect.sync(() => {
        if (stack === STACK && stage === STAGE) records.set(fqn, value)
        setValues.push({ fqn, value })
        return value
      }),
    delete: ({ fqn }) =>
      Effect.sync(() => {
        deleteCalls.count += 1
        records.delete(fqn)
      }),
    deleteStack: () =>
      Effect.sync(() => {
        deleteStackCalls.count += 1
        records.clear()
        output = undefined
      }),
    list: ({ stack, stage }) =>
      Effect.succeed(
        stack === STACK && stage === STAGE ? [...records.keys()] : [],
      ),
    getOutput: ({ stack, stage }) =>
      Effect.succeed(stack === STACK && stage === STAGE ? output : undefined),
    setOutput: ({ stack, stage, value }) =>
      Effect.sync(() => {
        if (stack === STACK && stage === STAGE) output = value
        setOutputValues.push(value)
        return value
      }),
  }

  return {
    service,
    records,
    setValues,
    setOutputValues,
    deleteCalls,
    deleteStackCalls,
    output: () => output,
  }
}

const runCopy = (
  source: FakeState,
  destination: FakeState,
  dryRun = false,
) =>
  Effect.runPromise(
    copyStage({
      source: source.service,
      destination: destination.service,
      dryRun,
    }),
  )

const expectNoDeletes = (...states: readonly FakeState[]) => {
  for (const state of states) {
    expect(state.deleteCalls.count).toBe(0)
    expect(state.deleteStackCalls.count).toBe(0)
  }
}

const expectSafeSummary = (
  summary: MigrationSummary,
  forbidden: readonly string[],
) => {
  const record = safeLogRecord(summary)
  expect(
    Object.values(record).every(
      (value) => typeof value === 'boolean' || typeof value === 'number',
    ),
  ).toBe(true)
  const rendered = JSON.stringify(record)
  for (const value of forbidden) expect(rendered).not.toContain(value)
}

describe('copyStage', () => {
  it('plans an absent-destination copy without any mutation in dry-run mode', async () => {
    const source = makeFakeState({
      records: {
        'Worker/main': makeResource('Worker/main', 'dry-run-secret'),
      },
      output: { endpoint: 'private-output' },
    })
    const destination = makeFakeState()

    const summary = await runCopy(source, destination, true)

    expect(summary).toMatchObject({
      dryRun: true,
      destinationAbsent: true,
      destinationEqual: false,
      wouldCopyResourceCount: 1,
      wouldCopyOutput: true,
      copiedResourceCount: 0,
      copiedOutput: false,
      noOp: false,
      aborted: false,
      verified: false,
    })
    expect(destination.records.size).toBe(0)
    expect(destination.output()).toBeUndefined()
    expect(destination.setValues).toHaveLength(0)
    expect(destination.setOutputValues).toHaveLength(0)
    expectNoDeletes(source, destination)
  })

  it('copies unchanged records and output into a wholly absent destination', async () => {
    const secret = 'not-for-logs-token'
    const worker = makeResource('Worker/main', secret)
    const durableObject = makeResource('DurableObject/gateway', secret)
    const sourceOutput = { workerUrl: 'private-output', secret }
    const source = makeFakeState({
      records: {
        'Worker/main': worker,
        'DurableObject/gateway': durableObject,
      },
      output: sourceOutput,
    })
    const destination = makeFakeState()

    const summary = await runCopy(source, destination)

    expect(summary).toMatchObject({
      sourceResourceCount: 2,
      destinationResourceCount: 0,
      destinationAbsent: true,
      destinationEqual: false,
      copiedResourceCount: 2,
      copiedOutput: true,
      noOp: false,
      aborted: false,
      verified: true,
    })
    expect(destination.records.get('Worker/main')).toBe(worker)
    expect(destination.records.get('DurableObject/gateway')).toBe(
      durableObject,
    )
    expect(destination.output()).toBe(sourceOutput)
    expect(destination.setValues.map(({ value }) => value)).toEqual([
      durableObject,
      worker,
    ])
    expect(destination.setOutputValues).toEqual([sourceOutput])
    expectNoDeletes(source, destination)
    expectSafeSummary(summary, [secret, 'Worker/main', 'private-output'])
  })

  it('does no writes when destination is already structurally equal', async () => {
    const sourceRecord = makeResource('Worker/main', 'same-secret')
    const destinationRecord = structuredClone(sourceRecord)
    const source = makeFakeState({
      records: { 'Worker/main': sourceRecord },
      output: { endpoint: 'same' },
    })
    const destination = makeFakeState({
      records: { 'Worker/main': destinationRecord },
      output: { endpoint: 'same' },
    })

    const summary = await runCopy(source, destination)

    expect(summary).toMatchObject({
      destinationEqual: true,
      copiedResourceCount: 0,
      copiedOutput: false,
      noOp: true,
      aborted: false,
      verified: true,
    })
    expect(destination.setValues).toHaveLength(0)
    expect(destination.setOutputValues).toHaveLength(0)
    expectNoDeletes(source, destination)
  })

  it('aborts before writes when any destination record differs and preserves extras', async () => {
    const sourceRecord = makeResource('Worker/main', 'source-secret')
    const destinationRecord = makeResource(
      'Worker/main',
      'destination-secret',
    )
    const extra = makeResource('Worker/unrelated', 'leave-me-alone')
    const source = makeFakeState({
      records: { 'Worker/main': sourceRecord },
      output: { endpoint: 'source' },
    })
    const destination = makeFakeState({
      records: {
        'Worker/main': destinationRecord,
        'Worker/unrelated': extra,
      },
      output: { endpoint: 'source' },
    })

    const summary = await runCopy(source, destination)

    expect(summary).toMatchObject({
      destinationAbsent: false,
      destinationEqual: false,
      copiedResourceCount: 0,
      copiedOutput: false,
      noOp: false,
      aborted: true,
      verified: false,
    })
    expect(destination.records.get('Worker/main')).toBe(destinationRecord)
    expect(destination.records.get('Worker/unrelated')).toBe(extra)
    expect(destination.setValues).toHaveLength(0)
    expect(destination.setOutputValues).toHaveLength(0)
    expectNoDeletes(source, destination)
  })

  it('refuses to overwrite a destination record that appears after preflight', async () => {
    const source = makeFakeState({
      records: {
        'Worker/main': makeResource('Worker/main', 'source-secret'),
      },
      output: { endpoint: 'source' },
    })
    const destination = makeFakeState()
    const concurrentRecord = makeResource(
      'Worker/main',
      'concurrent-writer-secret',
    )
    const originalGet = destination.service.get
    destination.service.get = (request) => {
      destination.records.set(request.fqn, concurrentRecord)
      destination.service.get = originalGet
      return Effect.succeed(concurrentRecord)
    }

    await expect(runCopy(source, destination)).rejects.toBeDefined()

    expect(destination.records.get('Worker/main')).toBe(concurrentRecord)
    expect(destination.setValues).toHaveLength(0)
    expect(destination.setOutputValues).toHaveLength(0)
    expectNoDeletes(source, destination)
  })

  it('aborts without overwriting when only the destination output differs', async () => {
    const record = makeResource('Worker/main', 'same-secret')
    const source = makeFakeState({
      records: { 'Worker/main': record },
      output: { endpoint: 'source' },
    })
    const destinationOutput = { endpoint: 'destination' }
    const destination = makeFakeState({
      records: { 'Worker/main': structuredClone(record) },
      output: destinationOutput,
    })

    const summary = await runCopy(source, destination)

    expect(summary.aborted).toBe(true)
    expect(summary.destinationEqual).toBe(false)
    expect(destination.output()).toBe(destinationOutput)
    expect(destination.setValues).toHaveLength(0)
    expect(destination.setOutputValues).toHaveLength(0)
    expectNoDeletes(source, destination)
  })

  it('verify-equal exits zero only for an already equal destination', async () => {
    const record = makeResource('Worker/main', 'same-secret')
    const source = makeFakeState({
      records: { 'Worker/main': record },
      output: { endpoint: 'same' },
    })
    const destination = makeFakeState({
      records: { 'Worker/main': structuredClone(record) },
      output: { endpoint: 'same' },
    })

    const summary = await runCopy(source, destination, true)

    expect(verifyEqualExitCode(summary)).toBe(0)
    expect(destination.setValues).toHaveLength(0)
    expect(destination.setOutputValues).toHaveLength(0)
  })

  it('verify-equal exits nonzero for absent or different destinations without writes', async () => {
    const record = makeResource('Worker/main', 'source-secret')
    const source = makeFakeState({
      records: { 'Worker/main': record },
      output: { endpoint: 'source' },
    })
    const absent = makeFakeState()
    const different = makeFakeState({
      records: { 'Worker/main': makeResource('Worker/main', 'different-secret') },
      output: { endpoint: 'different' },
    })

    expect(verifyEqualExitCode(await runCopy(source, absent, true))).toBe(1)
    expect(verifyEqualExitCode(await runCopy(source, different, true))).toBe(1)
    expect(absent.setValues).toHaveLength(0)
    expect(different.setValues).toHaveLength(0)
    expectNoDeletes(source, absent, different)
  })

  it('aborts an incomplete source instead of treating absence as success', async () => {
    const source = makeFakeState({
      records: { 'Worker/main': makeResource('Worker/main', 'secret') },
    })
    const destination = makeFakeState()

    const summary = await runCopy(source, destination)

    expect(summary).toMatchObject({
      sourceComplete: false,
      sourceOutputPresent: false,
      aborted: true,
      copiedResourceCount: 0,
      copiedOutput: false,
    })
    expect(verifyEqualExitCode(summary)).toBe(1)
    expect(destination.setValues).toHaveLength(0)
    expect(destination.setOutputValues).toHaveLength(0)
    expectNoDeletes(source, destination)
  })
})

describe('verifyRemoteAuthoritative', () => {
  const expectedWorkerName = 'discordbot-staging'
  const expectedBotStateNamespaceId = '11111111111111111111111111111111'

  const runAuthority = (destination: FakeState) =>
    Effect.runPromise(verifyRemoteAuthoritative({
      destination: destination.service,
      expectedWorkerName,
      expectedBotStateNamespaceId,
    }))

  it('accepts post-deploy version and output drift when canonical identities remain stable', async () => {
    const destination = makeFakeState({
      records: {
        DiscordBot: makeAuthorityResource(
          expectedWorkerName,
          expectedBotStateNamespaceId,
          'post-deploy-version',
        ),
      },
      output: { releaseId: 'new-release', workerVersionId: 'new-version' },
    })

    const summary = await runAuthority(destination)

    expect(summary).toMatchObject({
      destinationResourceCount: 1,
      destinationOutputPresent: true,
      workerResourcePresent: true,
      workerIdentityMatches: true,
      botStateNamespaceMatches: true,
      remoteComplete: true,
      verified: true,
    })
    expect(remoteAuthorityExitCode(summary)).toBe(0)
    expect(destination.setValues).toHaveLength(0)
    expect(destination.setOutputValues).toHaveLength(0)
    expectNoDeletes(destination)
  })

  it('rejects absent, partial, or wrong-identity remote state without writes', async () => {
    const absent = makeFakeState()
    const partial = makeFakeState({
      records: {
        DiscordBot: makeAuthorityResource(
          expectedWorkerName,
          expectedBotStateNamespaceId,
          'partial',
        ),
      },
    })
    const wrongWorker = makeFakeState({
      records: {
        DiscordBot: makeAuthorityResource(
          'wrong-worker',
          expectedBotStateNamespaceId,
          'wrong-worker',
        ),
      },
      output: { releaseId: 'release' },
    })
    const wrongNamespace = makeFakeState({
      records: {
        DiscordBot: makeAuthorityResource(
          expectedWorkerName,
          '22222222222222222222222222222222',
          'wrong-namespace',
        ),
      },
      output: { releaseId: 'release' },
    })

    for (const destination of [absent, partial, wrongWorker, wrongNamespace]) {
      const summary = await runAuthority(destination)
      expect(remoteAuthorityExitCode(summary)).toBe(1)
      expect(summary.verified).toBe(false)
      expect(destination.setValues).toHaveLength(0)
      expect(destination.setOutputValues).toHaveLength(0)
    }
    expectNoDeletes(absent, partial, wrongWorker, wrongNamespace)
  })
})
