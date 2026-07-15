import { Option, Schema } from '@livestore/utils/effect'
import { describe, expect, it } from 'vitest'

import * as ApiSchema from './api-schema.ts'
import { makeElectricUrl } from './make-electric-url.ts'

const HandleStruct = { offset: 'off-1', handle: 'h-1' } as const

const cases = [
  { name: 'none + no payload', storeId: 's1', payload: undefined, handle: Option.none(), live: false },
  { name: 'some + payload', storeId: 's2', payload: { foo: 'bar' }, handle: Option.some(HandleStruct), live: true },
  { name: 'none + payload present', storeId: 's3', payload: { a: 1 }, handle: Option.none(), live: false },
  { name: 'some + no payload', storeId: 's4', payload: undefined, handle: Option.some(HandleStruct), live: true },
  { name: 'none + null payload', storeId: 's5', payload: null, handle: Option.none(), live: false },
] as const

describe('sync-electric ArgsSchema round-trip', () => {
  for (const c of cases) {
    it(`round-trips ${c.name}`, () => {
      const input = ApiSchema.PullPayload.make({
        storeId: c.storeId,
        payload: c.payload,
        handle: c.handle,
        live: c.live,
      })

      const encoded = Schema.encodeSync(ApiSchema.ArgsSchema)(input)
      expect(typeof encoded).toBe('string')

      const decoded = Schema.decodeUnknownSync(ApiSchema.ArgsSchema)(encoded)

      expect(Option.isOption(decoded.handle)).toBe(true)
      expect(decoded.handle._tag).toBe(c.handle._tag)
      if (Option.isSome(c.handle)) {
        expect((decoded.handle as Option.Some<typeof HandleStruct>).value).toEqual(HandleStruct)
      }
      expect(decoded.payload).toEqual(c.payload)
      expect(decoded.storeId).toBe(c.storeId)
      expect(decoded.live).toBe(c.live)

      // Full path through makeElectricUrl: URLSearchParams -> Struct({ args }) -> ArgsSchema
      const searchParams = new URLSearchParams({ args: encoded })
      const result = makeElectricUrl({ electricHost: 'http://electric.test', searchParams })
      expect(result.storeId).toBe(c.storeId)
      expect(result.needsInit).toBe(Option.isNone(c.handle))
      expect(result.payload).toEqual(c.payload)
    })
  }
})
