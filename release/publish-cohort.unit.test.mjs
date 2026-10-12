import assert from 'node:assert/strict'
import test from 'node:test'

import { publishCohort } from './publish-cohort.mjs'

const packed = [
  { pkg: { name: '@livestore/adapter-expo', version: '0.5.0' }, digests: { integrity: 'sha512-new' } },
  { pkg: { name: '@livestore/adapter-node', version: '0.5.0' }, digests: { integrity: 'sha512-local' } },
]

test('a conflicting existing version aborts the entire cohort before any publish call', async () => {
  const registry = new Map([['@livestore/adapter-node', { integrity: 'sha512-conflicting' }]])
  let publishCalls = 0
  await assert.rejects(
    publishCohort({
      packed,
      isPublished: (pkg) => registry.has(pkg.name),
      preflightExisting: ({ pkg, digests }) => {
        assert.equal(registry.get(pkg.name).integrity, digests.integrity, 'registry and packed digests differ')
      },
      publishPackage: () => {
        publishCalls++
      },
      verifyPackage: () => assert.fail('post-publish verification must not run after a preflight conflict'),
    }),
    /registry and packed digests differ/,
  )
  assert.equal(publishCalls, 0)
})

test('preflights existing artifacts first and marks only fresh publications for propagation tolerance', async () => {
  const events = []
  const result = await publishCohort({
    packed,
    isPublished: (pkg) => pkg.name === '@livestore/adapter-node',
    preflightExisting: ({ pkg }) => {
      events.push(`preflight:${pkg.name}`)
    },
    publishPackage: ({ pkg }) => {
      events.push(`publish:${pkg.name}`)
    },
    verifyPackage: ({ pkg }, { newlyPublished }) => {
      events.push(`verify:${pkg.name}:${newlyPublished}`)
      return { version: pkg.version }
    },
  })
  assert.deepEqual(events, [
    'preflight:@livestore/adapter-node',
    'publish:@livestore/adapter-expo',
    'verify:@livestore/adapter-expo:true',
    'verify:@livestore/adapter-node:false',
  ])
  assert.equal(result.size, 2)
})
