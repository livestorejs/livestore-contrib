import type { SingleTabAdapterOptions } from '@livestore/adapter-web'
import type { Adapter, Devtools } from '@livestore/common'
import { describe, expect, it } from 'vitest'

import {
  devtoolsStateStorageDirectory,
  makeDevtoolsStateAdapter,
} from './devtools-state-adapter.ts'

const fakeAdapter = (() => undefined) as unknown as Adapter

const fakeWorker = (() => undefined) as unknown as SingleTabAdapterOptions['worker']

describe('makeDevtoolsStateAdapter', () => {
  it('keeps real DevTools UI state persisted in isolated versioned OPFS storage', () => {
    const singleTabOptions: Array<SingleTabAdapterOptions> = []

    const adapter = makeDevtoolsStateAdapter({
      mode: {
        _tag: 'node',
        url: 'http://127.0.0.1:4242',
      } as Devtools.DevtoolsMode,
      storeId: 'app-store',
      worker: fakeWorker,
      options: { resetPersistence: true },
      adapterFactories: {
        makeInMemoryAdapter: () => {
          throw new Error('real DevTools state must not use in-memory storage')
        },
        makeSingleTabAdapter: (options) => {
          singleTabOptions.push(options)
          return fakeAdapter
        },
      },
    })

    expect(adapter).toBe(fakeAdapter)
    expect(singleTabOptions).toEqual([
      {
        storage: {
          type: 'opfs',
          directory: devtoolsStateStorageDirectory('app-store'),
        },
        worker: fakeWorker,
        resetPersistence: true,
      },
    ])
  })

  it('uses in-memory storage only for mock mode', () => {
    let inMemoryCalls = 0

    const adapter = makeDevtoolsStateAdapter({
      mode: 'mock',
      storeId: 'app-store',
      worker: fakeWorker,
      options: undefined,
      adapterFactories: {
        makeInMemoryAdapter: () => {
          inMemoryCalls++
          return fakeAdapter
        },
        makeSingleTabAdapter: () => {
          throw new Error('mock mode must not use persisted storage')
        },
      },
    })

    expect(adapter).toBe(fakeAdapter)
    expect(inMemoryCalls).toBe(1)
  })
})
