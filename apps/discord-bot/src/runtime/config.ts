import { readFile } from 'node:fs/promises'

import { Effect, Schema } from 'effect'

// The schema, error type, and summary projection live in the node-free
// `config-schema.ts` so node-free hosts share them; re-exported here so every
// existing importer is unchanged.
export * from './config-schema.ts'
import {
  canonicalizeRuntimeConfig,
  RuntimeConfigFile,
  RuntimeConfigError,
} from './config-schema.ts'

export const loadRuntimeConfig = Effect.fn('runtime.config.load')(function* (path: string) {
  const text = yield* Effect.tryPromise({
    try: () => readFile(path, 'utf8'),
    catch: (cause) => new RuntimeConfigError({ path, message: 'Could not read runtime config', cause }),
  })
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RuntimeConfigFile), { onExcessProperty: 'error' })(
    text,
  ).pipe(
    Effect.mapError((cause) => new RuntimeConfigError({ path, message: 'Runtime config is invalid', cause })),
    Effect.map(({ payload }) => canonicalizeRuntimeConfig(payload)),
  )
})
