import { expect, it } from '@effect/vitest'

import * as Effect from 'effect/Effect'

import { makeCrypto } from './crypto.ts'

const crypto = makeCrypto()

it.effect('randomUUID returns v4-shaped strings', () =>
  Effect.map(crypto.randomUUID, (value) => {
    expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  }))

it.effect('randomBytes returns the requested length', () =>
  Effect.flatMap(crypto.randomBytes(32), (bytes) =>
    Effect.sync(() => {
      expect(bytes).toHaveLength(32)
    })))

it.effect('sha256Hex matches known digests across string and byte inputs', () =>
  Effect.gen(function* () {
    expect(yield* crypto.sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    const bytes = new TextEncoder().encode('abc')
    expect(yield* crypto.sha256Hex(bytes)).toBe(yield* crypto.sha256Hex('abc'))
  }))
