import type { Effect } from '@livestore/utils/effect'

import type { SyncProviderLayer } from '../types.ts'
import * as ElectricProvider from './electric.ts'
import * as S2Provider from './s2.ts'

/** Shape of each entry in the provider registry. */
interface ProviderEntry {
  readonly name: string
  readonly layer: SyncProviderLayer
  readonly prepare: Effect.Effect<void, any, any>
}

// Single source of truth for sync providers used across CLI and tests
export const providerRegistry: {
  electric: ProviderEntry
  s2: ProviderEntry
} = {
  electric: { name: ElectricProvider.name, layer: ElectricProvider.layer, prepare: ElectricProvider.prepare },
  s2: { name: S2Provider.name, layer: S2Provider.layer, prepare: S2Provider.prepare },
}

export type ProviderKey = keyof typeof providerRegistry

const isProviderKey = (value: string): value is ProviderKey => value in providerRegistry

const requestedProvider = process.env.TEST_SYNC_PROVIDER

export const providerKeys =
  requestedProvider === undefined || requestedProvider === ''
    ? (Object.keys(providerRegistry) as ProviderKey[])
    : isProviderKey(requestedProvider)
      ? [requestedProvider]
      : (() => {
          throw new Error(
            `Unknown TEST_SYNC_PROVIDER=${requestedProvider}. Expected one of: ${Object.keys(providerRegistry).join(
              ', ',
            )}`,
          )
        })()
