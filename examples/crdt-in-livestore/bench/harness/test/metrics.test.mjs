import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  byteLength,
  checkConvergence,
  collectOperationBytes,
  collectSnapshotBytes,
  collectTransferredBytes,
  measureRetainedMemory,
  measureRepeated,
  serializeEvidenceNdjson,
  summarize,
  verifyEvidenceArtifact,
  writeEvidenceArtifact,
} from '../src/metrics.mjs'

test('summarize uses nearest-rank quantiles and retains totals', () => {
  assert.deepEqual(summarize([1, 2, 3, 4, 100]), {
    samples: [1, 2, 3, 4, 100],
    count: 5,
    total: 110,
    min: 1,
    max: 100,
    avg: 22,
    variance: 1522,
    stddev: Math.sqrt(1522),
    median: 3,
    p50: 3,
    p95: 100,
    p99: 100,
  })
})

test('wire and snapshot collectors count UTF-8 and binary bytes', () => {
  const payloads = ['a', 'é', new Uint8Array([1, 2, 3])]
  assert.equal(byteLength('é'), 2)
  assert.deepEqual(collectOperationBytes(payloads), {
    samples: [1, 2, 3],
    count: 3,
    total: 6,
    min: 1,
    max: 3,
    avg: 2,
    variance: 2 / 3,
    stddev: Math.sqrt(2 / 3),
    median: 2,
    p50: 2,
    p95: 3,
    p99: 3,
  })
  assert.deepEqual(collectTransferredBytes(payloads), {
    total: 6,
    perOp: collectOperationBytes(payloads),
  })
  assert.equal(collectSnapshotBytes('🙂'), 4)
})

test('measureRepeated excludes warm-ups and returns measured values', async () => {
  const calls = []
  const measurement = await measureRepeated(
    (index, metadata) => {
      calls.push(metadata.measured)
      return `${metadata.measured ? 'm' : 'w'}-${index}`
    },
    { warmups: 2, iterations: 3 },
  )

  assert.deepEqual(calls, [false, false, true, true, true])
  assert.deepEqual(measurement.values, ['m-0', 'm-1', 'm-2'])
  assert.equal(measurement.elapsedMs.count, 3)
  assert.equal(measurement.elapsedMs.samples.length, 3)
  assert.equal(typeof measurement.elapsedMs.variance, 'number')
  assert.equal(typeof measurement.elapsedMs.stddev, 'number')
})

test('measureRetainedMemory holds allocations through capture and records lifecycle evidence', async () => {
  const lifecycle = []
  const measurement = await measureRetainedMemory({
    allocate: async (index, metadata) => {
      lifecycle.push(`allocate:${metadata.measured}:${index}`)
      return { index, bytes: new Uint8Array(32) }
    },
    release: async (retained, index, metadata) => {
      assert.equal(retained.index, index)
      lifecycle.push(`release:${metadata.measured}:${index}`)
    },
    warmups: 1,
    iterations: 2,
    gc: false,
  })

  assert.deepEqual(lifecycle, [
    'allocate:false:0',
    'release:false:0',
    'allocate:true:0',
    'release:true:0',
    'allocate:true:1',
    'release:true:1',
  ])
  assert.equal(typeof measurement.gcAvailable, 'boolean')
  assert.equal(measurement.gcUsed, false)
  assert.equal(measurement.samples.length, 2)
  for (const sample of measurement.samples) {
    for (const key of ['rssBytes', 'heapUsedBytes', 'heapTotalBytes', 'externalBytes', 'arrayBuffersBytes']) {
      assert.equal(sample.delta[key], sample.after[key] - sample.before[key])
    }
    assert.ok(sample.afterRelease)
  }
  assert.equal(measurement.rssDeltaBytes.count, 2)
  assert.equal(measurement.heapUsedDeltaBytes.count, 2)
  assert.equal(measurement.rssDeltaBytes.samples.length, 2)
})

test('checkConvergence awaits canonicalizers and checks peers against the oracle', async () => {
  const canonicalize = async (state) => ({ text: state.text, marks: state.marks })
  const expected = { text: 'hello', marks: [{ from: 0, to: 5, type: 'bold' }] }
  const report = await checkConvergence({
    states: [
      { text: 'hello', marks: [{ from: 0, to: 5, type: 'bold' }], snapshot: 'encoding-a' },
      { text: 'hello', marks: [{ from: 0, to: 5, type: 'bold' }], snapshot: 'encoding-b' },
    ],
    canonicalize,
    expected,
  })
  assert.equal(report.converged, true)
  assert.equal(report.oracleMatched, true)
  assert.deepEqual(report.mismatchedIndices, [])
  assert.deepEqual(report.oracleMismatchedIndices, [])

  const mismatch = await checkConvergence({
    states: [{ text: 'a' }, { text: 'b' }],
    canonicalize: async ({ text }) => ({ text }),
    expected: { text: 'a' },
  })
  assert.equal(mismatch.converged, false)
  assert.equal(mismatch.oracleMatched, false)
  assert.deepEqual(mismatch.mismatchedIndices, [1])
  assert.deepEqual(mismatch.oracleMismatchedIndices, [1])
  assert.deepEqual(mismatch.mismatches.peers, [
    { index: 1, expected: { text: 'a' }, actual: { text: 'b' } },
  ])
})

test('checkConvergence rejects equal-but-wrong peer states', async () => {
  const report = await checkConvergence({
    states: [{ text: 'wrong' }, { text: 'wrong' }],
    canonicalize: async ({ text }) => ({ text }),
    expected: { text: 'right' },
  })

  assert.equal(report.converged, true)
  assert.equal(report.oracleMatched, false)
  assert.deepEqual(report.mismatchedIndices, [])
  assert.deepEqual(report.oracleMismatchedIndices, [0, 1])
  assert.deepEqual(report.mismatches.oracle, [
    { index: 0, expected: { text: 'right' }, actual: { text: 'wrong' } },
    { index: 1, expected: { text: 'right' }, actual: { text: 'wrong' } },
  ])
})

test('collectors reject empty or unsupported samples explicitly', () => {
  assert.throws(() => summarize([]), /at least one sample/)
  assert.throws(() => summarize([-1]), /non-negative/)
  assert.throws(() => summarize([Number.NaN]), /finite numbers/)
  assert.throws(() => collectOperationBytes([{}]), /payload must be/)
})

test('serializeEvidenceNdjson canonicalizes object keys while preserving record order', () => {
  assert.equal(
    serializeEvidenceNdjson([
      { z: 1, a: { y: 2, x: 3 } },
      { index: 2, values: [true, null, 'é'] },
    ]),
    '{"a":{"x":3,"y":2},"z":1}\n{"index":2,"values":[true,null,"é"]}\n',
  )
  assert.throws(() => serializeEvidenceNdjson([{ invalid: Number.NaN }]), /finite JSON numbers/)
})

test('writeEvidenceArtifact writes once and verifyEvidenceArtifact checks bytes and count', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'crdt-evidence-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'nested', 'evidence.ndjson')
  const records = [{ sample: 1 }, { sample: 2 }]

  const reference = await writeEvidenceArtifact({ path, records })
  assert.deepEqual(reference, {
    _tag: 'external',
    path,
    hash: reference.hash,
    count: 2,
    encoding: 'ndjson',
  })
  assert.match(reference.hash, /^sha256:[0-9a-f]{64}$/)
  assert.equal(await readFile(path, 'utf8'), '{"sample":1}\n{"sample":2}\n')
  assert.deepEqual(await verifyEvidenceArtifact(reference), {
    valid: true,
    errors: [],
    observed: { hash: reference.hash, count: 2, encoding: 'ndjson' },
  })
  assert.deepEqual(await writeEvidenceArtifact({ path, records }), reference)
  await assert.rejects(writeEvidenceArtifact({ path, records: [{ different: true }] }), { code: 'EEXIST' })

  await appendFile(path, '{"sample":3}\n', 'utf8')
  const tampered = await verifyEvidenceArtifact(reference)
  assert.equal(tampered.valid, false)
  assert.ok(tampered.errors.some((error) => error.startsWith('hash mismatch:')))
  assert.ok(tampered.errors.some((error) => error.startsWith('count mismatch:')))
})

test('gzip evidence is deterministic, idempotent, and verified after decompression', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'crdt-evidence-gzip-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const records = [{ z: 'compressible', a: [1, 2, 3] }, { text: 'same bytes' }]
  const firstPath = join(directory, 'first.ndjson.gz')
  const secondPath = join(directory, 'second.ndjson.gz')

  const first = await writeEvidenceArtifact({ path: firstPath, records, compression: 'gzip' })
  const second = await writeEvidenceArtifact({ path: secondPath, records, compression: 'gzip' })
  assert.equal(first.hash, second.hash)
  assert.deepEqual(await readFile(firstPath), await readFile(secondPath))
  assert.equal(first.compression, 'gzip')
  assert.deepEqual(await writeEvidenceArtifact({ path: firstPath, records, compression: 'gzip' }), first)

  const verification = await verifyEvidenceArtifact(first)
  assert.equal(verification.valid, true)
  assert.deepEqual(verification.errors, [])
  assert.deepEqual(verification.observed, {
    hash: first.hash,
    count: 2,
    encoding: 'ndjson',
    compression: 'gzip',
  })

  const tamperedBytes = await readFile(firstPath)
  tamperedBytes[Math.floor(tamperedBytes.length / 2)] ^= 0xff
  await writeFile(firstPath, tamperedBytes)
  const tampered = await verifyEvidenceArtifact(first)
  assert.equal(tampered.valid, false)
  assert.ok(tampered.errors.some((error) => error.startsWith('hash mismatch:')))
})

test('evidence artifacts reject unsupported compression', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'crdt-evidence-compression-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'evidence.ndjson')

  await assert.rejects(
    writeEvidenceArtifact({ path, records: [{ sample: 1 }], compression: 'brotli' }),
    /absent or "gzip"/,
  )
  const reference = await writeEvidenceArtifact({ path, records: [{ sample: 1 }] })
  const unsupported = await verifyEvidenceArtifact({ ...reference, compression: 'brotli' })
  assert.equal(unsupported.valid, false)
  assert.ok(unsupported.errors.includes('reference.compression must be absent or "gzip"'))
})
