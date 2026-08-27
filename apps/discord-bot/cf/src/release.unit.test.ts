import { expect, it } from 'vitest'

import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'

import {
  deploymentIdentityMismatch,
  readReleaseId,
  readWorkerVersionId,
  releaseIdConfig,
} from './release.ts'

const parse = (local: boolean, values: Record<string, unknown>) =>
  releaseIdConfig(local).parse(ConfigProvider.fromUnknown(values))

it('requires a non-empty RELEASE_ID for remote deployments', () => {
  expect(() => Effect.runSync(parse(false, {}))).toThrow(/RELEASE_ID/)
  expect(() => Effect.runSync(parse(false, { RELEASE_ID: '   ' }))).toThrow(/RELEASE_ID/)
})

it('allows the explicit dev identity only for local deployments', () => {
  expect(Effect.runSync(parse(true, {}))).toBe('dev')
  expect(Effect.runSync(parse(true, { RELEASE_ID: 'local-build' }))).toBe('local-build')
})

it('reads release and Cloudflare version identity from runtime bindings', () => {
  const env = {
    RELEASE_ID: 'sha256:release',
    CF_VERSION_METADATA: { id: 'cf-version-1', tag: '', timestamp: '2026-08-27T00:00:00Z' },
  }
  expect(readReleaseId(env)).toBe('sha256:release')
  expect(readWorkerVersionId(env)).toBe('cf-version-1')
  expect(readWorkerVersionId({})).toBeUndefined()
})

it('fails remote deployment identity closed on Worker or namespace drift', () => {
  const expected = {
    workerName: 'discordbot-staging',
    botStateNamespaceId: '11111111111111111111111111111111',
  }
  expect(deploymentIdentityMismatch(expected, expected)).toBeUndefined()
  expect(deploymentIdentityMismatch(expected, {
    ...expected,
    workerName: 'discordbot-staging-fork',
  })).toMatch(/Worker identity mismatch/)
  expect(deploymentIdentityMismatch(expected, {
    ...expected,
    botStateNamespaceId: '22222222222222222222222222222222',
  })).toMatch(/BotState namespace mismatch/)
})
