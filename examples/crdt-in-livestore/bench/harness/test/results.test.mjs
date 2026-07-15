import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { writeEvidenceArtifact } from '../src/metrics.mjs'

import {
  assessCountability,
  computeTaxRow,
  measured,
  notApplicable,
  REQUIRED_CONFORMANCE_SUITE,
  validateBenchmarkResult,
  validateResultDocument,
  validateTaxRow,
} from '../src/results.mjs'

const summaryEvidence = (count, reference = 'runner://summary') => ({
  _tag: 'summary',
  hash: `sha256:summary-${count}`,
  count,
  reference,
})

const externalEvidence = (count, path = 'evidence/timing.ndjson.zst') => ({
  _tag: 'external',
  path,
  hash: `sha256:external-${count}`,
  count,
  encoding: 'ndjson',
  compression: 'gzip',
})

const distribution = (value, count, { evidence = summaryEvidence(count), samples = undefined } = {}) => {
  const values = samples ?? Array.from({ length: count }, () => value)
  const total = values.reduce((sum, sample) => sum + sample, 0)
  const avg = total / values.length
  const sorted = values.toSorted((left, right) => left - right)
  const variance = values.reduce((sum, sample) => sum + (sample - avg) ** 2, 0) / values.length
  return {
    count,
    total,
    min: sorted[0],
    max: sorted.at(-1),
    avg,
    variance,
    stddev: Math.sqrt(variance),
    p50: sorted[Math.ceil(values.length * 0.5) - 1],
    p95: sorted[Math.ceil(values.length * 0.95) - 1],
    p99: sorted[Math.ceil(values.length * 0.99) - 1],
    median: sorted[Math.ceil(values.length * 0.5) - 1],
    evidence,
  }
}

const result = ({
  id,
  arm,
  multiplier = 1,
  editCount = 1000,
  concurrency = 2,
  memorySamples = undefined,
  gcUsed = true,
} = {}) => {
  const iterations = 3
  const deliveryCount = editCount * (concurrency - 1)
  const memoryValues = memorySamples ?? [20 * multiplier, 20 * multiplier, 20 * multiplier]
  const memoryEvidence = {
    _tag: 'inline',
    hash: `sha256:memory-${memoryValues.join('-')}`,
    count: iterations,
    reference: 'runner://retained-memory',
    samples: memoryValues,
  }
  const value = {
    schemaVersion: 1,
    kind: 'benchmark-result',
    id,
    version: 'trace-v1',
    seed: 42,
    runtime: {
      nodeVersion: 'v24.15.0',
      platform: 'linux',
      arch: 'x64',
      cpu: { model: 'benchmark-cpu', count: 8 },
    },
    provenance: {
      pairedRunId: 'pair-001',
      trace: { id: 'trace-001', hash: 'sha256:abc123', deliveryCount },
      crdt: { name: 'trivial', version: '1.0.0' },
      versions: { harness: 'phase0-v1', protocol: 'tax-v1', library: '1.0.0' },
      measurementProtocol: {
        warmups: 1,
        iterations,
        clock: 'performance.now monotonic milliseconds',
        gc: { requested: true },
        statistics: { median: 'nearest-rank p50', quantiles: 'nearest-rank', variance: 'population' },
      },
      wireProtocol: {
        boundary: arm === 'embedded' ? 'serialized LiveStore event' : 'native update',
        encoding: arm === 'embedded' ? 'base64 in JSON' : 'native binary',
        framing: arm === 'embedded' ? 'one JSON event per update' : 'one update frame',
      },
    },
    axes: {
      technology: 'trivial',
      arm,
      documentSizeBytes: 2048,
      editCount,
      concurrency,
      offlineBranchDurations: [10, 50, 200],
    },
    metrics: {
      wire: {
        perOp: measured(distribution(10 * multiplier, deliveryCount)),
        totalTransferredBytes: measured(10 * multiplier * deliveryCount),
      },
      atRest: { snapshotBytes: measured(50 * multiplier), historyBytes: measured(75 * multiplier) },
      timing: {
        encodeMs: measured(distribution(2 * multiplier, iterations)),
        decodeMs: measured(distribution(3 * multiplier, iterations)),
        fullReplayMs: measured(distribution(4 * multiplier, iterations)),
      },
      memory: {
        rssDeltaBytes: measured(distribution(0, iterations, { evidence: memoryEvidence, samples: memoryValues })),
        heapUsedDeltaBytes: measured(distribution(0, iterations, { evidence: memoryEvidence, samples: memoryValues })),
        gcAvailable: true,
        gcUsed,
      },
      convergence: measured({
        converged: true,
        oracleMatched: true,
        stateCount: concurrency,
        canonicalDigests: Array.from({ length: concurrency }, () => 'sha256:canonical'),
        oracleDigest: 'sha256:canonical',
        mismatchedIndices: [],
        oracleMismatchedIndices: [],
      }),
      conformance: measured({
        passed: true,
        suite: {
          id: REQUIRED_CONFORMANCE_SUITE.id,
          version: REQUIRED_CONFORMANCE_SUITE.version,
          hash: REQUIRED_CONFORMANCE_SUITE.hash,
        },
        scenarioCount: REQUIRED_CONFORMANCE_SUITE.scenarioCount,
      }),
    },
  }
  if (arm === 'embedded') {
    value.provenance.versions.liveStore = { version: '0.3.0', commit: '0123456789abcdef' }
    value.embedded = {
      payloadInflation: { nativeBytes: 10_000, base64Bytes: 13_336, jsonBytes: 18_000 },
      orderingEffect: {
        _tag: 'measured',
        value: {
          mode: 'single-writer-total-order',
          serializedOperationCount: editCount,
          evidence: summaryEvidence(editCount, 'runner://ordering-effect'),
        },
      },
      logGrowth: {
        withoutCompaction: true,
        checkpoints: [
          { editCount: Math.max(1, Math.floor(editCount / 10)), historyBytes: 1800 },
          { editCount, historyBytes: 18_000 },
        ],
      },
    }
  }
  return value
}

test('compact rows validate with summary evidence and no per-edit arrays', () => {
  const value = result({ id: 'large', arm: 'embedded', editCount: 100_000 })
  assert.deepEqual(validateBenchmarkResult(value), { valid: true, errors: [] })
  assert.equal(value.metrics.wire.perOp.value.evidence._tag, 'summary')
  assert.equal(value.metrics.timing.decodeMs.value.evidence._tag, 'summary')
  assert.ok(JSON.stringify(value).length < 10_000)
})

test('wire delivery count is explicit for three-way fan-out while ordering counts logical edits', () => {
  const value = result({ id: 'three-way', arm: 'embedded', editCount: 1000, concurrency: 3 })
  assert.equal(value.provenance.trace.deliveryCount, 2000)
  assert.equal(value.metrics.wire.perOp.value.count, 2000)
  assert.equal(value.embedded.orderingEffect.value.serializedOperationCount, 1000)
  assert.equal(validateBenchmarkResult(value).valid, true)
})

test('inline evidence is bounded and unavailable for per-delivery wire distributions', () => {
  const value = result({ id: 'standalone', arm: 'standalone' })
  value.metrics.wire.perOp.value.evidence = {
    _tag: 'inline',
    hash: 'sha256:wire-inline',
    count: 1000,
    reference: 'runner://wire',
    samples: Array.from({ length: 1000 }, () => 10),
  }
  assert.equal(validateBenchmarkResult(value).valid, false)

  const tooMany = result({ id: 'standalone', arm: 'standalone' })
  tooMany.metrics.timing.encodeMs.value.evidence = {
    _tag: 'inline',
    hash: 'sha256:too-many',
    count: 1001,
    reference: 'runner://timing',
    samples: Array.from({ length: 1001 }, () => 2),
  }
  const validation = validateBenchmarkResult(tooMany)
  assert.ok(validation.errors.some(({ path, message }) => path.endsWith('.samples') && message.includes('at most 1000')))
})

test('successful convergence stores only bounded digests, while failed evidence may reference an artifact', () => {
  const value = result({ id: 'standalone', arm: 'standalone' })
  assert.equal(Object.hasOwn(value.metrics.convergence.value, 'canonicalStates'), false)
  value.metrics.convergence.value.converged = false
  value.metrics.convergence.value.oracleMatched = false
  value.metrics.convergence.value.canonicalDigests[1] = 'sha256:different'
  value.metrics.convergence.value.mismatchedIndices = [1]
  value.metrics.convergence.value.oracleMismatchedIndices = [1]
  value.metrics.convergence.value.mismatchArtifact = externalEvidence(2, 'evidence/convergence-failure.json.zst')
  assert.equal(validateBenchmarkResult(value).valid, true)
})

test('runtime and root validation reject nested extras equally', () => {
  const value = result({ id: 'standalone', arm: 'standalone' })
  value.metrics.wire.extra = true
  assert.ok(validateBenchmarkResult(value).errors.some(({ path }) => path === '$.metrics.wire.extra'))
  assert.ok(validateResultDocument(value).errors.some(({ path }) => path === '$.metrics.wire.extra'))
})

test('direct probes reject distribution count, evidence, arithmetic, wire-total, and timing-iteration drift', () => {
  const probes = [
    (value) => { value.metrics.wire.perOp.value.evidence.count = 999 },
    (value) => { value.metrics.wire.perOp.value.total += 1 },
    (value) => { value.metrics.wire.totalTransferredBytes.value += 1 },
    (value) => { value.metrics.timing.encodeMs.value.count = 2 },
    (value) => { value.metrics.timing.encodeMs.value.p95 = 0 },
  ]
  for (const mutate of probes) {
    const value = result({ id: 'probe', arm: 'standalone' })
    mutate(value)
    assert.equal(validateBenchmarkResult(value).valid, false)
  }
})

test('old or failed conformance remains storable but exact suite evidence is required for countability', async () => {
  assert.deepEqual(REQUIRED_CONFORMANCE_SUITE, {
    id: 'livestore-rich-text-conformance-v1',
    version: '1.0.0',
    hash: 'sha256:bacb078d5a4517d277d09ef7910a7c018ff9f03c99e629cb2025ce6836ff3ea1',
    scenarioCount: 13,
  })
  const standalone = result({ id: 'standalone', arm: 'standalone' })
  const embedded = result({ id: 'embedded', arm: 'embedded' })
  for (const mutate of [
    (value) => { value.metrics.conformance.value.passed = false },
    (value) => { value.metrics.conformance.value.suite.id = 'legacy-suite' },
    (value) => { value.metrics.conformance.value.suite.version = '0.9.0' },
    (value) => { value.metrics.conformance.value.suite.hash = 'sha256:legacy' },
    (value) => { value.metrics.conformance.value.scenarioCount = 12 },
  ]) {
    const old = structuredClone(standalone)
    mutate(old)
    assert.equal(validateBenchmarkResult(old).valid, true)
    assert.equal((await computeTaxRow(embedded, old))._tag, 'not-countable')
  }
})

test('convergence evidence must have workload-concurrency cardinality', () => {
  const value = result({ id: 'embedded', arm: 'embedded' })
  value.metrics.convergence.value.stateCount = 1
  assert.equal(validateBenchmarkResult(value).valid, false)
})

test('true convergence and oracle match require identical cardinality-correct digests and empty mismatches', () => {
  const probes = [
    (value) => value.metrics.convergence.value.canonicalDigests.pop(),
    (value) => { value.metrics.convergence.value.canonicalDigests[1] = 'sha256:different' },
    (value) => value.metrics.convergence.value.mismatchedIndices.push(1),
    (value) => { value.metrics.convergence.value.oracleDigest = 'sha256:different' },
  ]
  for (const mutate of probes) {
    const value = result({ id: 'probe', arm: 'standalone' })
    mutate(value)
    assert.equal(validateBenchmarkResult(value).valid, false)
  }
})

test('embedded TAX requires all typed LiveStore evidence and version provenance', async () => {
  const standalone = result({ id: 'standalone', arm: 'standalone' })
  for (const mutate of [
    (value) => delete value.embedded,
    (value) => delete value.embedded.payloadInflation,
    (value) => { value.embedded.orderingEffect = notApplicable('not captured') },
    (value) => delete value.embedded.logGrowth,
    (value) => delete value.provenance.versions.liveStore,
  ]) {
    const embedded = result({ id: 'embedded', arm: 'embedded' })
    mutate(embedded)
    const assessment = await assessCountability(embedded, standalone)
    assert.equal(assessment._tag, 'not-countable')
  }
})

test('embedded ordering and uncompacted log evidence cover the complete workload', () => {
  const probes = [
    (value) => { value.embedded.orderingEffect.value.serializedOperationCount -= 1 },
    (value) => { value.embedded.logGrowth.checkpoints.at(-1).editCount -= 1 },
    (value) => { value.embedded.payloadInflation.base64Bytes = value.embedded.payloadInflation.nativeBytes - 1 },
  ]
  for (const mutate of probes) {
    const value = result({ id: 'embedded', arm: 'embedded' })
    mutate(value)
    assert.equal(validateBenchmarkResult(value).valid, false)
  }
})

test('plain and gzip evidence are verified before countability and tampering reports its nested path', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'crdt-results-evidence-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'timing.ndjson')
  const reference = await writeEvidenceArtifact({ path, records: [{ ms: 3 }, { ms: 3 }, { ms: 3 }] })
  const gzipReference = await writeEvidenceArtifact({
    path: join(directory, 'timing.ndjson.gz'),
    records: [{ ms: 6 }, { ms: 6 }, { ms: 6 }],
    compression: 'gzip',
  })
  const standalone = result({ id: 'standalone', arm: 'standalone' })
  const embedded = result({ id: 'embedded', arm: 'embedded' })
  standalone.metrics.timing.decodeMs.value.evidence = reference
  embedded.metrics.timing.decodeMs.value.evidence = gzipReference

  assert.equal(gzipReference.compression, 'gzip')
  assert.equal((await assessCountability(embedded, standalone))._tag, 'countable')
  await writeFile(path, '{"ms":999}\n', 'utf8')
  const assessment = await assessCountability(embedded, standalone)
  assert.equal(assessment._tag, 'not-countable')
  assert.ok(
    assessment.reasons.some(
      ({ code, path: reasonPath }) =>
        code === 'external-evidence-invalid' &&
        reasonPath === '$.standalone.metrics.timing.decodeMs.value.evidence',
    ),
  )
})

test('missing nested embedded evidence and unsupported compression cannot produce TAX', async () => {
  const standalone = result({ id: 'standalone', arm: 'standalone' })
  const embedded = result({ id: 'embedded', arm: 'embedded' })
  embedded.embedded.orderingEffect.value.evidence = externalEvidence(
    1000,
    '/definitely/missing/crdt-ordering-evidence.ndjson.gz',
  )
  const missing = await computeTaxRow(embedded, standalone)
  assert.equal(missing._tag, 'not-countable')
  assert.ok(missing.reasons.some(({ path }) => path === '$.embedded.embedded.orderingEffect.value.evidence'))

  embedded.embedded.orderingEffect.value.evidence.compression = 'zstd'
  assert.equal(validateBenchmarkResult(embedded).valid, false)
})

test('countable evidence yields a schema-valid TAX row', async () => {
  const standalone = result({ id: 'standalone', arm: 'standalone' })
  const embedded = result({ id: 'embedded', arm: 'embedded', multiplier: 2 })
  const tax = await computeTaxRow(embedded, standalone)
  assert.equal(tax.kind, 'tax-row')
  assert.equal(tax.metrics.wire.perOp.p95.ratio, 2)
  assert.deepEqual(validateTaxRow(tax), { valid: true, errors: [] })
  assert.deepEqual(validateResultDocument(tax), { valid: true, errors: [] })
})

test('memory TAX is N/A for unstable numerator or denominator while other metrics remain measured', async () => {
  const standalone = result({ id: 'standalone', arm: 'standalone' })
  const embedded = result({ id: 'embedded', arm: 'embedded', memorySamples: [0, 20, 40] })
  const tax = await computeTaxRow(embedded, standalone)
  assert.equal(tax.metrics.memory.rssDeltaBytes._tag, 'not-applicable')
  assert.equal(tax.metrics.memory.rssDeltaBytes.reason, 'embedded-memory-numerator-non-positive-or-unstable')
  assert.equal(tax.metrics.timing.encodeMs._tag, 'measured')

  const unstableStandalone = result({ id: 'standalone', arm: 'standalone', memorySamples: [0, 20, 40] })
  const stableEmbedded = result({ id: 'embedded', arm: 'embedded' })
  assert.equal(
    (await computeTaxRow(stableEmbedded, unstableStandalone)).metrics.memory.rssDeltaBytes._tag,
    'not-applicable',
  )
})

test('memory GC mode mismatch produces per-cell N/A without suppressing other TAX metrics', async () => {
  const standalone = result({ id: 'standalone', arm: 'standalone', gcUsed: false })
  const embedded = result({ id: 'embedded', arm: 'embedded', gcUsed: true })
  const tax = await computeTaxRow(embedded, standalone)
  assert.equal(tax.metrics.memory.heapUsedDeltaBytes.reason, 'memory-gc-mode-mismatch')
  assert.equal(tax.metrics.wire.totalTransferredBytes._tag, 'measured')
})

test('different paired provenance remains tagged not-countable', async () => {
  const standalone = result({ id: 'standalone', arm: 'standalone' })
  const embedded = result({ id: 'embedded', arm: 'embedded' })
  embedded.provenance.trace.hash = 'sha256:different'
  assert.equal((await computeTaxRow(embedded, standalone))._tag, 'not-countable')
})

test('paired TAX evidence must use the same explicit delivery count', async () => {
  const standalone = result({ id: 'standalone', arm: 'standalone' })
  const embedded = result({ id: 'embedded', arm: 'embedded', multiplier: 2 })
  embedded.provenance.trace.deliveryCount = 2000
  embedded.metrics.wire.perOp = measured(distribution(20, 2000))
  embedded.metrics.wire.totalTransferredBytes = measured(40_000)
  const assessment = await assessCountability(embedded, standalone)
  assert.equal(assessment._tag, 'not-countable')
  assert.ok(assessment.reasons.some(({ path }) => path === '$.provenance.trace.deliveryCount'))
})

test('schema declares all three strict result variants', async () => {
  const schema = JSON.parse(await readFile(new URL('../results.schema.json', import.meta.url), 'utf8'))
  assert.deepEqual(schema.oneOf, [
    { $ref: '#/$defs/benchmarkResult' },
    { $ref: '#/$defs/taxRow' },
    { $ref: '#/$defs/notCountable' },
  ])
})
