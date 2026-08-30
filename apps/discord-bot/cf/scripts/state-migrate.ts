import { AlchemyContext, AuthProviders, Cli } from 'alchemy'
import { ArtifactStore, createArtifactStore } from 'alchemy/Artifacts'
import * as Cloudflare from 'alchemy/Cloudflare'
import {
  encodeState,
  localState,
  isResourceState,
  State,
} from 'alchemy/State'
import type { PersistedState, StateService, StateStoreError } from 'alchemy/State'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeServices from '@effect/platform-node/NodeServices'
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient'
import { isDeepStrictEqual } from 'node:util'

export const STACK = 'DiscordBot'
export const STAGE = 'staging'

export interface MigrationSummary {
  readonly sourceResourceCount: number
  readonly destinationResourceCount: number
  readonly sourceOutputPresent: boolean
  readonly destinationOutputPresent: boolean
  readonly sourceComplete: boolean
  readonly destinationAbsent: boolean
  readonly destinationEqual: boolean
  readonly dryRun: boolean
  readonly wouldCopyResourceCount: number
  readonly wouldCopyOutput: boolean
  readonly copiedResourceCount: number
  readonly copiedOutput: boolean
  readonly noOp: boolean
  readonly aborted: boolean
  readonly verified: boolean
}

export interface SourceProbeSummary {
  readonly sourceResourceCount: number
  readonly sourceOutputPresent: boolean
  readonly sourceComplete: boolean
}

export interface RemoteAuthoritySummary {
  readonly destinationResourceCount: number
  readonly destinationOutputPresent: boolean
  readonly workerResourcePresent: boolean
  readonly workerIdentityMatches: boolean
  readonly botStateNamespaceMatches: boolean
  readonly remoteComplete: boolean
  readonly verified: boolean
}

interface Snapshot {
  readonly fqns: readonly string[]
  readonly records: ReadonlyMap<string, PersistedState>
  readonly output: unknown
}

export class SnapshotChanged extends Data.TaggedError('SnapshotChanged')<{}> {}
export class DestinationChanged extends Data.TaggedError(
  'DestinationChanged',
)<{}> {}
export class VerificationFailed extends Data.TaggedError(
  'VerificationFailed',
)<{}> {}

export type MigrationError =
  | StateStoreError
  | SnapshotChanged
  | DestinationChanged
  | VerificationFailed

const readSnapshot = (
  state: StateService,
  stack: string,
  stage: string,
): Effect.Effect<Snapshot, StateStoreError | SnapshotChanged> =>
  Effect.gen(function* () {
    const fqns = [...new Set(yield* state.list({ stack, stage }))].toSorted()
    const entries = yield* Effect.forEach(fqns, (fqn) =>
      state.get({ stack, stage, fqn }).pipe(
        Effect.flatMap((value) =>
          value === undefined
            ? Effect.fail(new SnapshotChanged())
            : Effect.succeed([fqn, value] as const),
        ),
      ),
    )
    const output = yield* state.getOutput({ stack, stage })
    return { fqns, records: new Map(entries), output }
  })

const stateValueEqual = (left: unknown, right: unknown): boolean =>
  isDeepStrictEqual(encodeState(left), encodeState(right))

const snapshotsEqual = (left: Snapshot, right: Snapshot): boolean =>
  left.fqns.length === right.fqns.length &&
  left.fqns.every((fqn, index) => {
    const rightFqn = right.fqns[index]
    return (
      fqn === rightFqn &&
      stateValueEqual(left.records.get(fqn), right.records.get(fqn))
    )
  }) &&
  stateValueEqual(left.output, right.output)

const makeSummary = (input: {
  readonly source: Snapshot
  readonly destination: Snapshot
  readonly sourceComplete: boolean
  readonly destinationAbsent: boolean
  readonly destinationEqual: boolean
  readonly dryRun: boolean
  readonly wouldCopyResourceCount?: number
  readonly wouldCopyOutput?: boolean
  readonly copiedResourceCount?: number
  readonly copiedOutput?: boolean
  readonly noOp?: boolean
  readonly aborted?: boolean
  readonly verified?: boolean
}): MigrationSummary => ({
  sourceResourceCount: input.source.fqns.length,
  destinationResourceCount: input.destination.fqns.length,
  sourceOutputPresent: input.source.output !== undefined,
  destinationOutputPresent: input.destination.output !== undefined,
  sourceComplete: input.sourceComplete,
  destinationAbsent: input.destinationAbsent,
  destinationEqual: input.destinationEqual,
  dryRun: input.dryRun,
  wouldCopyResourceCount: input.wouldCopyResourceCount ?? 0,
  wouldCopyOutput: input.wouldCopyOutput ?? false,
  copiedResourceCount: input.copiedResourceCount ?? 0,
  copiedOutput: input.copiedOutput ?? false,
  noOp: input.noOp ?? false,
  aborted: input.aborted ?? false,
  verified: input.verified ?? false,
})

/**
 * Copies one stack stage without calling delete and without intentionally
 * overwriting any destination value. The destination must be wholly absent or
 * already structurally equal. StateService has no compare-and-set operation,
 * so a live run additionally requires an exclusive-writer window.
 */
export const copyStage = (input: {
  readonly source: StateService
  readonly destination: StateService
  readonly stack?: string
  readonly stage?: string
  readonly dryRun?: boolean
}): Effect.Effect<MigrationSummary, MigrationError> =>
  Effect.gen(function* () {
    const stack = input.stack ?? STACK
    const stage = input.stage ?? STAGE
    const dryRun = input.dryRun ?? false
    const source = yield* readSnapshot(input.source, stack, stage)
    const destination = yield* readSnapshot(input.destination, stack, stage)
    const sourceComplete =
      source.fqns.length > 0 && source.output !== undefined
    const destinationAbsent =
      destination.fqns.length === 0 && destination.output === undefined
    const destinationEqual = snapshotsEqual(source, destination)

    if (sourceComplete === false) {
      return makeSummary({
        source,
        destination,
        sourceComplete,
        destinationAbsent,
        destinationEqual,
        dryRun,
        aborted: true,
      })
    }

    if (destinationEqual === true) {
      return makeSummary({
        source,
        destination,
        sourceComplete,
        destinationAbsent,
        destinationEqual,
        dryRun,
        noOp: true,
        verified: true,
      })
    }

    if (destinationAbsent === false) {
      return makeSummary({
        source,
        destination,
        sourceComplete,
        destinationAbsent,
        destinationEqual,
        dryRun,
        aborted: true,
      })
    }

    if (dryRun === true) {
      return makeSummary({
        source,
        destination,
        sourceComplete,
        destinationAbsent,
        destinationEqual,
        dryRun,
        wouldCopyResourceCount: source.fqns.length,
        wouldCopyOutput: true,
      })
    }

    for (const [fqn, value] of source.records) {
      const destinationValue = yield* input.destination.get({
        stack,
        stage,
        fqn,
      })
      if (destinationValue !== undefined) {
        return yield* new DestinationChanged()
      }
      yield* input.destination.set({
        stack,
        stage,
        fqn,
        value,
      })
    }

    if ((yield* input.destination.getOutput({ stack, stage })) !== undefined) {
      return yield* new DestinationChanged()
    }
    yield* input.destination.setOutput({
      stack,
      stage,
      value: source.output,
    })

    const written = yield* readSnapshot(input.destination, stack, stage)
    if (snapshotsEqual(source, written) === false) {
      return yield* new VerificationFailed()
    }

    return makeSummary({
      source,
      destination,
      sourceComplete,
      destinationAbsent,
      destinationEqual,
      dryRun,
      copiedResourceCount: source.fqns.length,
      copiedOutput: true,
      verified: true,
    })
  })

export const safeLogRecord = (
  summary: MigrationSummary,
): Readonly<Record<keyof MigrationSummary, number | boolean>> => summary

export const verifyEqualExitCode = (summary: MigrationSummary): 0 | 1 =>
  summary.sourceComplete === true && summary.destinationEqual === true && summary.noOp === true && summary.verified === true ? 0 : 1

const readProperty = (value: unknown, key: string): unknown => {
  if (typeof value !== 'object' || value === null || key in value === false) return undefined
  return Reflect.get(value, key)
}

/** Read-only steady-state gate; local migration-source equality is irrelevant. */
export const verifyRemoteAuthoritative = (input: {
  readonly destination: StateService
  readonly expectedWorkerName: string
  readonly expectedBotStateNamespaceId: string
  readonly stack?: string
  readonly stage?: string
}): Effect.Effect<RemoteAuthoritySummary, StateStoreError | SnapshotChanged> =>
  Effect.gen(function* () {
    const stack = input.stack ?? STACK
    const stage = input.stage ?? STAGE
    const destination = yield* readSnapshot(input.destination, stack, stage)
    const worker = [...destination.records.values()].find(
      (record) =>
        isResourceState(record) &&
        record.resourceType === 'Cloudflare.Worker' &&
        record.logicalId === 'DiscordBot',
    )
    const workerAttributes = readProperty(worker, 'attr')
    const workerName = readProperty(workerAttributes, 'workerName')
    const namespaces = readProperty(workerAttributes, 'durableObjectNamespaces')
    const botStateNamespaceId = readProperty(namespaces, 'BotState')
    const destinationOutputPresent = destination.output !== undefined
    const workerResourcePresent = worker !== undefined
    const workerIdentityMatches = workerName === input.expectedWorkerName
    const botStateNamespaceMatches =
      botStateNamespaceId === input.expectedBotStateNamespaceId
    const remoteComplete =
      destination.fqns.length > 0 &&
      destinationOutputPresent &&
      workerResourcePresent
    return {
      destinationResourceCount: destination.fqns.length,
      destinationOutputPresent,
      workerResourcePresent,
      workerIdentityMatches,
      botStateNamespaceMatches,
      remoteComplete,
      verified:
        remoteComplete &&
        workerIdentityMatches &&
        botStateNamespaceMatches,
    }
  })

export const remoteAuthorityExitCode = (summary: RemoteAuthoritySummary): 0 | 1 =>
  summary.verified === true ? 0 : 1

const liveSupport = Layer.mergeAll(
  Layer.succeed(AlchemyContext, {
    dotAlchemy: `${process.cwd()}/.alchemy`,
    dev: false,
    adopt: false,
    updateStateStore: false,
  }),
  Layer.succeed(ArtifactStore, createArtifactStore()),
  Layer.succeed(AuthProviders, {}),
  Layer.succeed(Cli, {
    approvePlan: () => Effect.succeed(false),
    displayPlan: () => Effect.void,
    startApplySession: () =>
      Effect.succeed({
        emit: () => Effect.void,
        done: () => Effect.void,
      }),
  }),
)

const liveDependencies = Layer.mergeAll(
  NodeServices.layer,
  FetchHttpClient.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv()),
  liveSupport,
)

const liveMigration = (dryRun: boolean) =>
  Effect.scoped(
    Effect.gen(function* () {
      const localContext = yield* Layer.build(
        localState().pipe(Layer.provide(liveDependencies)),
      )
      const remoteContext = yield* Layer.build(
        Cloudflare.state().pipe(Layer.provide(liveDependencies)),
      )
      const source = yield* Context.get(localContext, State)
      const destination = yield* Context.get(remoteContext, State)
      return yield* copyStage({ source, destination, dryRun })
    }),
  )

const liveRemoteAuthority = (
  expectedWorkerName: string,
  expectedBotStateNamespaceId: string,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const remoteContext = yield* Layer.build(
        Cloudflare.state().pipe(Layer.provide(liveDependencies)),
      )
      const destination = yield* Context.get(remoteContext, State)
      return yield* verifyRemoteAuthoritative({
        destination,
        expectedWorkerName,
        expectedBotStateNamespaceId,
      })
    }),
  )

const liveSourceProbe = Effect.scoped(
  Effect.gen(function* () {
    const localContext = yield* Layer.build(
      localState().pipe(Layer.provide(liveDependencies)),
    )
    const source = yield* Context.get(localContext, State)
    const snapshot = yield* readSnapshot(source, STACK, STAGE)
    const summary: SourceProbeSummary = {
      sourceResourceCount: snapshot.fqns.length,
      sourceOutputPresent: snapshot.output !== undefined,
      sourceComplete: snapshot.fqns.length > 0 && snapshot.output !== undefined,
    }
    return summary
  }),
)

const main = Effect.gen(function* () {
  const argument = process.argv.slice(2)
  const dryRun = argument.length === 1 && argument[0] === '--dry-run'
  const execute = argument.length === 1 && argument[0] === '--execute'
  const verifyEqual = argument.length === 1 && argument[0] === '--verify-equal'
  const verifyRemoteAuthority =
    argument.length === 1 && argument[0] === '--verify-remote-authoritative'
  const sourceProbe = argument.length === 1 && argument[0] === '--source-probe'
  if (dryRun === false && execute === false && verifyEqual === false && verifyRemoteAuthority === false && sourceProbe === false) {
    console.log(JSON.stringify({ argumentAccepted: false }))
    process.exitCode = 2
    return
  }
  if (execute === true && process.env['CF_STATE_MIGRATION_WRITERS_FENCED'] !== '1') {
    console.log(JSON.stringify({ completed: false, writersFenced: false }))
    process.exitCode = 2
    return
  }

  if (sourceProbe === true) {
    const sourceExit = yield* Effect.exit(liveSourceProbe)
    if (Exit.isFailure(sourceExit) === true) {
      console.log(JSON.stringify({ sourceComplete: false }))
      process.exitCode = 1
      return
    }
    console.log(JSON.stringify(sourceExit.value))
    if (sourceExit.value.sourceComplete === false) process.exitCode = 1
    return
  }

  if (verifyRemoteAuthority === true) {
    const expectedWorkerName = process.env['CF_WORKER_NAME']?.trim()
    const expectedBotStateNamespaceId =
      process.env['CF_BOT_STATE_NAMESPACE_ID']?.trim()
    if (
      expectedWorkerName === undefined ||
      expectedWorkerName === '' ||
      expectedBotStateNamespaceId === undefined ||
      expectedBotStateNamespaceId === ''
    ) {
      console.log(JSON.stringify({ configurationComplete: false, verified: false }))
      process.exitCode = 2
      return
    }
    const authorityExit = yield* Effect.exit(
      liveRemoteAuthority(expectedWorkerName, expectedBotStateNamespaceId),
    )
    if (Exit.isFailure(authorityExit) === true) {
      console.log(JSON.stringify({ completed: false, verified: false }))
      process.exitCode = 1
      return
    }
    console.log(JSON.stringify(authorityExit.value))
    process.exitCode = remoteAuthorityExitCode(authorityExit.value)
    return
  }

  const exit = yield* Effect.exit(liveMigration(dryRun || verifyEqual))
  if (Exit.isFailure(exit) === true) {
    console.log(JSON.stringify({ completed: false }))
    process.exitCode = 1
    return
  }

  console.log(JSON.stringify(safeLogRecord(exit.value)))
  if (exit.value.aborted === true || (verifyEqual === true && verifyEqualExitCode(exit.value) !== 0)) {
    process.exitCode = 1
  }
})

const invokedPath = process.argv[1]
if (
  invokedPath !== undefined &&
  import.meta.url === new URL(invokedPath, 'file:').href
) {
  NodeRuntime.runMain(main)
}
