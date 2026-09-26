import { it } from '@effect/vitest'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import { expect } from 'vitest'

import { makeRuntimeConfigAdminOperations } from './admin-ops.ts'
import { makeFakeDoStorage } from './fake-do-storage.ts'
import { makeSupervisorGate } from './loop-gate.ts'
import { makeRuntimeConfigStore } from './runtime-config.ts'
import { makeSerializedRuntime } from './runtime-install.ts'

it.effect('a concurrent cold tick and status install and activate one supervisor runtime', () =>
  Effect.gen(function* () {
    const buildStarted = yield* Deferred.make<void>()
    const releaseBuild = yield* Deferred.make<void>()
    let buildCount = 0
    let activationCount = 0
    let supervisorStartCount = 0

    const runtime = yield* makeSerializedRuntime(
      Effect.gen(function* () {
        buildCount++
        yield* Deferred.succeed(buildStarted, undefined)
        yield* Deferred.await(releaseBuild)
        return { id: `runtime-${buildCount}` }
      }),
      (_candidate) =>
        Effect.sync(() => {
          activationCount++
        }),
    )

    const [statusRuntime, tickRuntime] = yield* Effect.all(
      [
        runtime.get,
        runtime.withCurrent((current) =>
          Effect.sync(() => {
            supervisorStartCount++
            return current
          }),
        ),
        Deferred.await(buildStarted).pipe(Effect.andThen(Deferred.succeed(releaseBuild, undefined))),
      ],
      { concurrency: 'unbounded' },
    )

    expect(statusRuntime).toBe(tickRuntime)
    expect(buildCount).toBe(1)
    expect(activationCount).toBe(1)
    expect(supervisorStartCount).toBe(1)
  }),
)

it.effect('a reload during the alarm await makes the tick start the replacement runtime', () =>
  Effect.gen(function* () {
    let nextId = 0
    const runtime = yield* makeSerializedRuntime(
      Effect.sync(() => ({ id: `runtime-${++nextId}` })),
      (_candidate) => Effect.void,
    )
    const initial = yield* runtime.get
    const tickWaitingOnAlarm = yield* Deferred.make<void>()
    const alarmReadCompleted = yield* Deferred.make<void>()
    const replacement = { id: 'runtime-replacement' }

    const [started] = yield* Effect.all(
      [
        Effect.gen(function* () {
          yield* runtime.get
          yield* Deferred.succeed(tickWaitingOnAlarm, undefined)
          yield* Deferred.await(alarmReadCompleted)
          return yield* runtime.withCurrent(Effect.succeed)
        }),
        Deferred.await(tickWaitingOnAlarm).pipe(
          Effect.andThen(
            runtime.replace(replacement, (current) =>
              Effect.sync(() => {
                expect(current).toBe(initial)
              }),
            ),
          ),
          Effect.andThen(Deferred.succeed(alarmReadCompleted, undefined)),
        ),
      ],
      { concurrency: 'unbounded' },
    )

    expect(started).toBe(replacement)
  }),
)

it.effect('keeps the current runtime live when candidate activation fails', () =>
  Effect.gen(function* () {
    const initial = { id: 'runtime-current' }
    const candidate = { id: 'runtime-candidate' }
    let beforeReplaceCalled = false
    const runtime = yield* makeSerializedRuntime(Effect.succeed(initial), (value) =>
      value === candidate ? Effect.die('activation failed') : Effect.void,
    )
    expect(yield* runtime.get).toBe(initial)

    const exit = yield* Effect.exit(
      runtime.replace(candidate, (_current) =>
        Effect.sync(() => {
          beforeReplaceCalled = true
        }),
      ),
    )

    expect(exit._tag).toBe('Failure')
    expect(beforeReplaceCalled).toBe(false)
    expect(runtime.peek()).toBe(initial)
    expect(yield* runtime.get).toBe(initial)
  }),
)

it.effect('holds replacement behind an in-flight withCurrent operation', () =>
  Effect.gen(function* () {
    const initial = { id: 'runtime-current' }
    const candidate = { id: 'runtime-candidate' }
    const operationEntered = yield* Deferred.make<void>()
    const releaseOperation = yield* Deferred.make<void>()
    const replaceAttempted = yield* Deferred.make<void>()
    let beforeReplaceCalled = false
    const runtime = yield* makeSerializedRuntime(Effect.succeed(initial), (_candidate) => Effect.void)
    yield* runtime.get

    const [appliedRuntime] = yield* Effect.all(
      [
        runtime.withCurrent((current) =>
          Deferred.succeed(operationEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseOperation)),
            Effect.as(current),
          ),
        ),
        Deferred.succeed(replaceAttempted, undefined).pipe(
          Effect.andThen(
            runtime.replace(candidate, (_current) =>
              Effect.sync(() => {
                beforeReplaceCalled = true
              }),
            ),
          ),
        ),
        Effect.gen(function* () {
          yield* Deferred.await(operationEntered)
          yield* Deferred.await(replaceAttempted)
          yield* Effect.yieldNow
          expect(runtime.peek()).toBe(initial)
          expect(beforeReplaceCalled).toBe(false)
          yield* Deferred.succeed(releaseOperation, undefined)
        }),
      ],
      { concurrency: 'unbounded' },
    )

    expect(appliedRuntime).toBe(initial)
    expect(beforeReplaceCalled).toBe(true)
    expect(runtime.peek()).toBe(candidate)
  }),
)

it.effect('reload recovers when the admin request ends before its detached gateway begins', () =>
  Effect.gen(function* () {
    const backing = makeFakeDoStorage()
    let alarm: number | undefined
    const storage = {
      ...backing,
      getAlarm: async () => alarm,
      setAlarm: async (when: number | Date) => {
        alarm = Number(when)
      },
      deleteAlarm: async () => {
        alarm = undefined
      },
    }
    const store = makeRuntimeConfigStore(storage, 'test-release')
    const gate = yield* makeSupervisorGate
    const runtime = yield* makeSerializedRuntime(
      Effect.map(Effect.orDie(store.read), (document) => ({
        document,
        state: 'disconnected' as 'disconnected' | 'ready',
      })),
      () => Effect.void,
    )
    const old = yield* runtime.get
    old.state = 'ready'
    yield* gate.tryBegin

    // Model a bridge that drops queued detached children when the request
    // returns: gateway startup must be owned by the subsequent alarm instead.
    let pendingRequestChild: (() => void) | undefined
    const tick = (origin: 'request' | 'alarm') =>
      runtime.withCurrent((current) =>
        Effect.gen(function* () {
          if ((yield* gate.tryBegin) === false) return
          if (origin === 'request') {
            pendingRequestChild = () => {
              current.state = 'ready'
            }
          } else {
            current.state = 'ready'
          }
          yield* Effect.promise(() => storage.setAlarm(Date.now() + 5_000))
        }),
      )
    const operations = makeRuntimeConfigAdminOperations({
      store,
      getRunning: () => runtime.peek()?.document,
      buildCandidate: (document) => Effect.succeed({ document, state: 'disconnected' as 'disconnected' | 'ready' }),
      activateCandidate: (candidate) =>
        runtime
          .replace(candidate, () =>
            Effect.sync(() => {
              old.state = 'disconnected'
            }).pipe(Effect.andThen(gate.end)),
          )
          .pipe(Effect.andThen(Effect.promise(() => storage.setAlarm(Date.now())))),
    })

    const outcome = yield* operations.configPut({
      expectedRevision: 0,
      reload: true,
      config: structuredClone(old.document.config),
    })
    expect(outcome).toMatchObject({ ok: true, body: { _tag: 'Success', applied: true } })
    expect(pendingRequestChild).toBeUndefined()
    expect(old.state).toBe('disconnected')
    expect(alarm).toBeDefined()
    expect(alarm).toBeLessThanOrEqual(Date.now())
    yield* tick('alarm')
    expect((yield* runtime.get).state).toBe('ready')
    backing.close()
  }),
)
