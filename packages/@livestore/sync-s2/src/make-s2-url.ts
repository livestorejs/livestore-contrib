import { shouldNeverHappen } from '@livestore/utils'
import { Result, Schema } from '@livestore/utils/effect'

import * as ApiSchema from './api-schema.ts'

export const makeS2StreamName = (storeId: string) => storeId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 100)

/**
 * Decode `args` from URLSearchParams using Effect Schema, mirroring Electric's approach.
 */
export const decodePullArgsFromSearchParams = (searchParams: URLSearchParams): ApiSchema.PullArgs => {
  const UrlParamsSchema = Schema.Struct({ args: ApiSchema.ArgsSchema })
  const argsResult = Schema.decodeUnknownResult(UrlParamsSchema)(Object.fromEntries(searchParams.entries()))

  if (Result.isFailure(argsResult) === true) {
    return shouldNeverHappen(
      'Invalid search params provided to decodePullArgsFromSearchParams',
      searchParams,
      Object.fromEntries(searchParams.entries()),
    )
  }

  return argsResult.success.args
}
