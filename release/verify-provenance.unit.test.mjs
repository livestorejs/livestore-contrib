import assert from 'node:assert/strict'
import test from 'node:test'

import { verifyProvenance } from './verify-provenance.mjs'

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
    /missing npm provenance/,
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
