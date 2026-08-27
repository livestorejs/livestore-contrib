import { expect, it } from '@effect/vitest'

import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { makeFakeDoStorage } from './fake-do-storage.ts'
import {
  encodeConfigSummary,
  makeRuntimeConfigStore,
  RuntimeConfigPayload,
  runtimeConfigKey,
} from './runtime-config.ts'

const makeStore = (releaseId?: string) => {
  const storage = makeFakeDoStorage()
  return { storage, store: makeRuntimeConfigStore(storage, releaseId) }
}

it.effect('empty storage exposes the AI-off dedicated-actor default at revision zero', () =>
  Effect.gen(function* () {
    const { store } = makeStore('cf-deploy-42')
    const document = yield* store.read

    expect(document.revision).toBe(0)
    expect(Schema.is(RuntimeConfigPayload)(document.config)).toBe(true)
    expect(document.config.environment).toBe('staging')
    expect(document.config.applicationId).toBe('1541431832195633232')
    expect(document.config.commandScope).toEqual({
      _tag: 'GuildCommandScope',
      applicationId: '1541431832195633232',
      guildId: '1154415661842452532',
    })
    expect(document.config.aiTitleChannelIds).toEqual([])
    expect(document.config.legacyCommands).toEqual([])
    if (document.config._tag !== 'real') return
    expect(document.config.e2e?.actorApplicationId).toBe('1541440368212705380')
    expect(document.config.releaseId).toBe('cf-deploy-42')
    expect(document.config.diagnostics).toEqual({
      sink: 'cloudflare-provider',
      delivery: 'best-effort',
      accessPolicyId: 'cloudflare-access-policy/discord-bot-admin',
      retentionDays: 30,
    })
    expect(document.config.telemetry).toBeUndefined()
  }))

it.effect('write persists one revisioned document and keeps release identity deploy-owned', () =>
  Effect.gen(function* () {
    const { storage, store } = makeStore('current-release')
    const initial = yield* store.read
    const written = yield* store.write({
      expectedRevision: initial.revision,
      config: { ...structuredClone(initial.config), releaseId: 'admin-supplied-release' },
    })

    expect(written.revision).toBe(1)
    expect(written.config.releaseId).toBe('current-release')
    expect([...((yield* Effect.promise(() => storage.list())).keys())]).toEqual([runtimeConfigKey])
    expect(yield* store.read).toEqual(written)
  }))

it.effect('stale expectedRevision is rejected without changing the durable document', () =>
  Effect.gen(function* () {
    const { store } = makeStore()
    const initial = yield* store.read
    const revisionOne = yield* store.write({ expectedRevision: 0, config: initial.config })

    const error = yield* Effect.flip(store.write({ expectedRevision: 0, config: initial.config }))
    expect(error).toMatchObject({
      _tag: 'RuntimeConfigRevisionConflict',
      expectedRevision: 0,
      actualRevision: 1,
    })
    expect(yield* store.read).toEqual(revisionOne)
  }))

it.effect('validation precedes CAS and invalid candidates leave storage untouched', () =>
  Effect.gen(function* () {
    const { storage, store } = makeStore()
    const invalid = {
      ...structuredClone((yield* store.read).config),
      commandScope: {
        _tag: 'GuildCommandScope',
        applicationId: '1541431832195633232',
        guildId: '999',
      },
    }

    expect((yield* Effect.exit(store.write({ expectedRevision: 0, config: invalid })))._tag).toBe('Failure')
    expect(yield* Effect.promise(() => storage.list())).toHaveLength(0)
  }))
it('serializes concurrent CAS writers so only one can advance a revision', async () => {
  const backing = makeFakeDoStorage()
  let releaseReads: () => void = () => {}
  const readGate = new Promise<void>((resolve) => {
    releaseReads = resolve
  })
  let signalFirstRead: () => void = () => {}
  const firstReadStarted = new Promise<void>((resolve) => {
    signalFirstRead = resolve
  })
  let reads = 0
  const storage = {
    get: async <T>(key: string) => {
      reads += 1
      if (reads === 1) signalFirstRead()
      await readGate
      return backing.get<T>(key)
    },
    put: <T>(key: string, value: T) => backing.put(key, value),
    delete: (key: string) => backing.delete(key),
    list: <T>(options?: { readonly prefix?: string }) => backing.list<T>(options),
  }
  const store = makeRuntimeConfigStore(storage)
  // Seed the candidate without going through the gated read.
  const config = (await Effect.runPromise(makeRuntimeConfigStore(backing).read)).config
  const first = Effect.runPromise(Effect.exit(store.write({ expectedRevision: 0, config })))
  const second = Effect.runPromise(Effect.exit(store.write({ expectedRevision: 0, config })))
  await firstReadStarted
  releaseReads()
  const exits = await Promise.all([first, second])
  expect(exits.filter((exit) => exit._tag === 'Success')).toHaveLength(1)
  expect(exits.filter((exit) => exit._tag === 'Failure')).toHaveLength(1)
  expect((await Effect.runPromise(store.read)).revision).toBe(1)
})


it.effect('stored release identity is rebound to the current Worker release on read', () =>
  Effect.gen(function* () {
    const storage = makeFakeDoStorage()
    const oldStore = makeRuntimeConfigStore(storage, 'old-release')
    yield* oldStore.write({ expectedRevision: 0, config: (yield* oldStore.read).config })

    const current = yield* makeRuntimeConfigStore(storage, 'current-release').read
    expect(current.revision).toBe(1)
    expect(current.config.releaseId).toBe('current-release')
  }))

it.effect('reads a legacy telemetry payload as revision zero and reports canonical diagnostics', () =>
  Effect.gen(function* () {
    const storage = makeFakeDoStorage()
    const canonical = (yield* makeRuntimeConfigStore(storage, 'legacy-release').read).config
    const { diagnostics: _diagnostics, ...withoutDiagnostics } = canonical
    yield* Effect.promise(() =>
      storage.put(runtimeConfigKey, JSON.stringify({
        ...withoutDiagnostics,
        telemetry: {
          sink: 'dev3-tempo',
          delivery: 'best-effort',
          accessBoundary: 'tailnet-trusted-grafana',
          retentionDays: 30,
        },
      })))

    const currentStore = makeRuntimeConfigStore(storage, 'current-release')
    const document = yield* currentStore.read
    expect(document.revision).toBe(0)
    expect(document.config.releaseId).toBe('current-release')
    expect(document.config.diagnostics?.sink).toBe('cloudflare-provider')
    expect(document.config.telemetry).toBeUndefined()
    expect(encodeConfigSummary(document.config).diagnostics).toEqual({
      sink: 'cloudflare-provider',
      delivery: 'best-effort',
      accessPolicyId: 'legacy-tailnet-policy-migration-required',
      retentionDays: 30,
    })

    const upgraded = yield* currentStore.write({ expectedRevision: 0, config: document.config })
    expect(upgraded.revision).toBe(1)
  }))

it.effect('a corrupt revisioned document fails loudly instead of defaulting', () =>
  Effect.gen(function* () {
    const { storage, store } = makeStore()
    yield* Effect.promise(() => storage.put(runtimeConfigKey, '{ not valid json'))
    expect((yield* Effect.exit(store.read))._tag).toBe('Failure')

    yield* Effect.promise(() => storage.put(runtimeConfigKey, JSON.stringify({ revision: 2, config: { _tag: 'bad' } })))
    expect((yield* Effect.exit(store.read))._tag).toBe('Failure')
  }))

it.effect('encodeConfigSummary projects a JSON-safe running/stored view', () =>
  Effect.gen(function* () {
    const summary = encodeConfigSummary((yield* makeStore().store.read).config)
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary)
    expect(summary.environment).toBe('staging')
    expect(summary.applicationId).toBe('1541431832195633232')
    expect(summary.aiTitleChannelCount).toBe(0)
    expect(summary.diagnostics).toEqual({
      sink: 'cloudflare-provider',
      delivery: 'best-effort',
      accessPolicyId: 'cloudflare-access-policy/discord-bot-admin',
      retentionDays: 30,
    })
  }))
