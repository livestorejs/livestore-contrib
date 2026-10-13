import assert from 'node:assert/strict'
import test from 'node:test'

import { verifyProvenance, waitForRegistryVerification } from './verify-provenance.mjs'

const pkg = { name: '@livestore/adapter-node', version: '0.5.0' }
const metadata = {
  dist: {
    attestations: {
      url: 'https://registry.npmjs.org/-/npm/v1/attestations/@livestore%2fadapter-node@0.5.0',
      provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
    },
  },
}
const response = (attestations) => async () => ({ ok: true, json: async () => ({ attestations }) })

test('accepts a retrievable npm SLSA provenance bundle', async () => {
  await verifyProvenance(
    pkg,
    metadata,
    response([
      { predicateType: 'https://slsa.dev/provenance/v1', bundle: { dsseEnvelope: { payload: 'signed-payload' } } },
    ]),
  )
})
test('fails closed without provenance metadata or with an unexpected endpoint', async () => {
  await assert.rejects(verifyProvenance(pkg, {}), /missing npm provenance/)
  await assert.rejects(
    verifyProvenance(pkg, {
      dist: {
        attestations: {
          ...metadata.dist.attestations,
          url: 'https://example.com/attestations',
        },
      },
    }),
    /unexpected endpoint/,
  )
})
test('fails when the registry has no retrievable attestation', async () => {
  await assert.rejects(
    verifyProvenance(pkg, metadata, async () => ({ ok: false, status: 404 })),
    /HTTP 404/,
  )
  await assert.rejects(verifyProvenance(pkg, metadata, response([])), /missing from the registry bundle/)
  await assert.rejects(
    verifyProvenance(pkg, metadata, response([{ predicateType: 'https://slsa.dev/provenance/v1', bundle: {} }])),
    /missing from the registry bundle/,
  )
})

test('re-reads metadata and tolerates provenance appearing after three retries', async () => {
  let calls = 0
  const waits = []
  await waitForRegistryVerification(
    async () => {
      calls++
      const currentMetadata = calls === 1 ? {} : metadata
      const fetchAttestation =
        calls === 2
          ? async () => ({ ok: false, status: 404 })
          : response(
              calls === 3
                ? []
                : [
                    {
                      predicateType: 'https://slsa.dev/provenance/v1',
                      bundle: { dsseEnvelope: { payload: 'signed-payload' } },
                    },
                  ],
            )
      await verifyProvenance(pkg, currentMetadata, fetchAttestation)
    },
    {
      wait: async (milliseconds) => {
        waits.push(milliseconds)
      },
    },
  )
  assert.equal(calls, 4)
  assert.deepEqual(waits, [5_000, 10_000, 15_000])
})

test('fails after the bounded attempts when provenance stays missing', async () => {
  let calls = 0
  const waits = []
  await assert.rejects(
    waitForRegistryVerification(
      async () => {
        calls++
        await verifyProvenance(pkg, metadata, response([]))
      },
      {
        attempts: 3,
        wait: async (milliseconds) => {
          waits.push(milliseconds)
        },
      },
    ),
    /did not converge/,
  )
  assert.equal(calls, 3)
  assert.deepEqual(waits, [5_000, 10_000])
})

test('does not retry malformed responses or unexpected endpoints', async () => {
  for (const verify of [
    () => verifyProvenance(pkg, metadata, async () => ({ ok: true, json: async () => ({}) })),
    () => verifyProvenance(pkg, { dist: { attestations: null } }),
    () =>
      verifyProvenance(pkg, {
        dist: {
          attestations: {
            ...metadata.dist.attestations,
            url: 'https://example.com/attestations',
          },
        },
      }),
  ]) {
    let calls = 0
    await assert.rejects(
      waitForRegistryVerification(
        async () => {
          calls++
          await verify()
        },
        { wait: async () => assert.fail('hard errors must not retry') },
      ),
      /malformed|unexpected/,
    )
    assert.equal(calls, 1)
  }
})
