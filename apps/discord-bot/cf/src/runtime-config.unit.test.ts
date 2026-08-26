import { expect, it } from '@effect/vitest'

import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { makeFakeDoStorage } from './fake-do-storage.ts'
import { encodeConfigSummary, makeRuntimeConfigStore, runtimeConfigKey } from './runtime-config.ts'
import { RuntimeConfigPayload } from './runtime-config.ts'

const makeStore = () => {
  const storage = makeFakeDoStorage()
  return { storage, store: makeRuntimeConfigStore(storage) }
}

it.effect('read falls back to the accepted staging default on empty storage', () =>
  Effect.gen(function* () {
    const previousReleaseId = process.env['RELEASE_ID']
    delete process.env['RELEASE_ID']
    try {
      const { store } = makeStore()
      const config = yield* store.read

      // The default itself must satisfy the full schema contract, cross-field
      // filter included — otherwise boot would hand downstream handlers an
      // invalid payload that `write` would reject.
      expect(Schema.is(RuntimeConfigPayload)(config)).toBe(true)
      expect(config._tag).toBe('real')
      if (config._tag !== 'real') return
      expect(config.environment).toBe('staging')
      expect(config.applicationId).toBe('1541431832195633232')
      expect(config.guildId).toBe('1154415661842452532')
      expect(config.commandScope).toEqual({
        _tag: 'GuildCommandScope',
        applicationId: '1541431832195633232',
        guildId: '1154415661842452532',
      })
      expect(config.actionChannelIds).toEqual(['1373597443798859776'])
      expect(config.stagingOnlyChannelIds).toEqual(['1373597443798859776'])
      expect(config.aiTitleChannelIds).toEqual(['1373597443798859776'])
      expect(config.legacyCommands).toEqual([])
      expect(config.docsAudience).toEqual({
        publicChannelIds: ['1373597443798859776'],
        roleRestrictedChannelIds: ['1541442247864623114'],
        contributorMaintainerRoleIds: ['1373662624948162570', '1310653672786755584'],
      })
      expect(config.releaseId).toBe('dev')
    } finally {
      if (previousReleaseId !== undefined) process.env['RELEASE_ID'] = previousReleaseId
    }
  }))

it.effect('releaseId prefers the RELEASE_ID env binding over the dev fallback', () =>
  Effect.gen(function* () {
    const previousReleaseId = process.env['RELEASE_ID']
    process.env['RELEASE_ID'] = 'cf-deploy-42'
    try {
      const { store } = makeStore()
      const config = yield* store.read
      expect(config.releaseId).toBe('cf-deploy-42')
    } finally {
      if (previousReleaseId === undefined) delete process.env['RELEASE_ID']
      else process.env['RELEASE_ID'] = previousReleaseId
    }
  }))

it.effect('write persists under the single namespaced key and reads back equal', () =>
  Effect.gen(function* () {
    const { storage, store } = makeStore()

    // A minimal mutation of the default keeps every schema invariant intact.
    const payload: RuntimeConfigPayload = {
      ...structuredClone(yield* store.read),
      releaseId: 'admin-written-release',
    }
    yield* store.write(payload)

    // Exactly one key, holding one JSON document.
    const entries = yield* Effect.promise(() => storage.list())
    expect([...entries.keys()]).toEqual([runtimeConfigKey])

    const roundTripped = yield* store.read
    expect(roundTripped).toEqual(payload)
  }))

it.effect('write rejects payloads failing schema decode, leaving storage untouched', () =>
  Effect.gen(function* () {
    const { storage, store } = makeStore()

    // Fails structural decode.
    const garbageError = yield* Effect.flip(store.write({ nope: true }))
    expect(garbageError).toBeInstanceOf(Error)

    // Well-typed-looking but violating the cross-field filter: guild scope
    // pointing at a different guild than the declared one.
    const mismatchedError = yield* Effect.flip(
      store.write({
        ...structuredClone(yield* store.read),
        commandScope: { _tag: 'GuildCommandScope', applicationId: '1541431832195633232', guildId: '999' },
      }),
    )
    expect(mismatchedError).toBeInstanceOf(Error)

    expect(yield* Effect.promise(() => storage.list())).toHaveLength(0)
  }))

it.effect('encodeConfigSummary projects the JSON-safe admin shape', () =>
  Effect.gen(function* () {
    const { store } = makeStore()
    const summary = encodeConfigSummary(yield* store.read)

    // Round-trips through JSON unchanged: safe for RuntimeStatus/policy-get bodies.
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary)
    expect(summary.mode).toBe('real')
    expect(summary.environment).toBe('staging')
    expect(summary.applicationId).toBe('1541431832195633232')
    expect(summary.actionChannelCount).toBe(1)
    expect(summary.restrictedDocsChannelCount).toBe(1)
    expect(summary.docsRoleCount).toBe(2)
    expect(summary.health).toEqual({ host: '127.0.0.1', port: 8787 })
  }))

it.effect('a present-but-corrupt document fails LOUDLY (never silently defaults)', () =>
  Effect.gen(function* () {
    const { storage, store } = makeStore()
    yield* Effect.promise(() => storage.put(runtimeConfigKey, '{ not valid json'))
    const exit = yield* Effect.exit(store.read)
    expect(exit._tag).toBe('Failure')

    // Structurally-decodable-but-policy-invalid documents fail the same way.
    yield* Effect.promise(() => storage.put(runtimeConfigKey, JSON.stringify({ _tag: 'nonsense' })))
    const exit2 = yield* Effect.exit(store.read)
    expect(exit2._tag).toBe('Failure')
  }))
