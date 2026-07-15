import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { cpus } from 'node:os'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  CONFORMANCE_SUITE_HASH,
  CONFORMANCE_SUITE_ID,
  CONFORMANCE_SUITE_VERSION,
  runConformanceSuite,
} from '../src/conformance.mjs'
import {
  checkConvergence,
  collectSnapshotBytes,
  collectTransferredBytes,
  measureRepeated,
  measureRetainedMemory,
  serializeEvidenceNdjson,
  verifyEvidenceArtifact,
  writeEvidenceArtifact,
} from '../src/metrics.mjs'
import { documentsEqual } from '../src/oracle.mjs'
import { plainReferenceArm } from '../src/plain-reference-arm.mjs'
import {
  measured,
  REQUIRED_CONFORMANCE_SUITE,
  validateBenchmarkResult,
  validateResultDocument,
} from '../src/results.mjs'
import { generateTrace } from '../src/trace.mjs'

const evidenceArtifactPath = fileURLToPath(
  new URL('../evidence/plain-reference-smoke-deliveries.ndjson', import.meta.url),
)

const smokeConfig = Object.freeze({
  seed: 'phase0-smoke',
  docSizeBytes: 256,
  editCount: 50,
  concurrency: 2,
  offlineBranchDurations: [5],
})

const measurementProtocol = Object.freeze({
  warmups: 1,
  iterations: 3,
  clock: 'performance.now monotonic milliseconds',
  gc: { requested: false },
  statistics: {
    median: 'nearest-rank p50',
    quantiles: 'nearest-rank',
    variance: 'population',
  },
})

const wireProtocol = Object.freeze({
  boundary: 'plain-reference logical edit update delivered by sync event',
  encoding: 'UTF-8 JSON Uint8Array',
  framing: 'one update payload per operationId occurrence',
})

test('runs the shared harness end to end on two smoke-only reference replicas', async () => {
  const trace = generateTrace(smokeConfig)
  const conformance = await runConformanceSuite(plainReferenceArm)
  const execution = await executeTrace(trace)
  const finalStates = [...execution.states.values()]
  const convergence = await checkConvergence({
    states: finalStates,
    canonicalize: (state) => plainReferenceArm.canonicalize(state),
    expected: trace.finalOracleDocument,
  })

  const deliveredPayloads = execution.deliveries.map(({ payload }) => payload)
  const transfer = collectTransferredBytes(deliveredPayloads)
  const finalSnapshot = await plainReferenceArm.encodeSnapshot(finalStates[0])
  const snapshotBytes = collectSnapshotBytes(finalSnapshot)
  const encode = await measureRepeated(() => plainReferenceArm.encodeSnapshot(finalStates[0]), {
    warmups: measurementProtocol.warmups,
    iterations: measurementProtocol.iterations,
  })
  const decode = await measureRepeated(
    (index) => plainReferenceArm.decodeSnapshot(finalSnapshot, `smoke-decoder-${index}`),
    { warmups: measurementProtocol.warmups, iterations: measurementProtocol.iterations },
  )
  const fullReplay = await measureRepeated(() => executeTrace(trace), {
    warmups: measurementProtocol.warmups,
    iterations: measurementProtocol.iterations,
  })
  const memory = await measureRetainedMemory({
    allocate: () => executeTrace(trace),
    release: releaseExecution,
    warmups: measurementProtocol.warmups,
    iterations: measurementProtocol.iterations,
    gc: false,
  })
  const cpu = cpus()
  const deliveryRecords = execution.deliveries.map(({ operationId, fromActorId, toActorId, payload }) => ({
    operationId,
    fromActorId,
    toActorId,
    bytes: payload.byteLength,
  }))
  const deliveryEvidenceMaterial = serializeEvidenceNdjson(deliveryRecords)
  const expectedWireEvidence = Object.freeze({
    _tag: 'external',
    path: evidenceArtifactPath,
    hash: sha256(deliveryEvidenceMaterial),
    count: deliveryRecords.length,
    encoding: 'ndjson',
  })
  let wireEvidence
  let evidenceWriterDisposition = 'created'
  try {
    wireEvidence = Object.freeze(await writeEvidenceArtifact({ path: evidenceArtifactPath, records: deliveryRecords }))
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    evidenceWriterDisposition = 'existing'
    const existingVerification = await verifyEvidenceArtifact(expectedWireEvidence)
    assert.equal(existingVerification.valid, true, existingVerification.errors.join('; '))
    wireEvidence = expectedWireEvidence
  }
  const evidenceVerification = await verifyEvidenceArtifact(wireEvidence)
  const evidenceStat = await stat(evidenceArtifactPath)
  const convergenceValue = {
    converged: convergence.converged,
    oracleMatched: convergence.oracleMatched,
    stateCount: convergence.stateCount,
    canonicalDigests: convergence.canonicalStates.map(digestCanonicalDocument),
    oracleDigest: digestCanonicalDocument(trace.finalOracleDocument),
    mismatchedIndices: convergence.mismatchedIndices,
    oracleMismatchedIndices: convergence.oracleMismatchedIndices,
  }
  const traceHash = `sha256:${createHash('sha256').update(JSON.stringify(trace)).digest('hex')}`

  const result = {
    schemaVersion: 1,
    kind: 'benchmark-result',
    id: 'plain-reference-smoke-phase0',
    version: `trace-v${trace.schemaVersion}`,
    seed: trace.seed,
    runtime: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: { model: cpu[0]?.model ?? 'unknown-cpu', count: cpu.length },
    },
    provenance: {
      pairedRunId: 'reference-only-not-paired',
      trace: {
        id: `phase0-smoke-trace-v${trace.schemaVersion}`,
        hash: traceHash,
        deliveryCount: execution.deliveries.length,
      },
      crdt: { name: 'plain-reference-non-crdt', version: 'phase0-smoke-v1' },
      versions: {
        harness: 'phase0-v1',
        protocol: 'tax-result-v1-trace-v2',
        library: 'plain-reference-arm-v1',
      },
      measurementProtocol,
      wireProtocol,
    },
    axes: {
      technology: 'plain-reference-non-crdt',
      arm: 'reference-only',
      documentSizeBytes: smokeConfig.docSizeBytes,
      editCount: smokeConfig.editCount,
      concurrency: smokeConfig.concurrency,
      offlineBranchDurations: [...smokeConfig.offlineBranchDurations],
    },
    metrics: {
      wire: {
        perOp: measured(distributionWithEvidence(transfer.perOp, wireEvidence)),
        totalTransferredBytes: measured(transfer.total),
      },
      atRest: {
        snapshotBytes: measured(snapshotBytes),
        historyBytes: measured(transfer.total),
      },
      timing: {
        encodeMs: measured(distributionWithInlineEvidence(encode.elapsedMs, 'smoke://timing/encode-ms')),
        decodeMs: measured(distributionWithInlineEvidence(decode.elapsedMs, 'smoke://timing/decode-ms')),
        fullReplayMs: measured(distributionWithInlineEvidence(fullReplay.elapsedMs, 'smoke://timing/full-replay-ms')),
      },
      memory: {
        rssDeltaBytes: measured(
          distributionWithInlineEvidence(memory.rssDeltaBytes, 'smoke://memory/rss-delta-bytes'),
        ),
        heapUsedDeltaBytes: measured(
          distributionWithInlineEvidence(memory.heapUsedDeltaBytes, 'smoke://memory/heap-used-delta-bytes'),
        ),
        gcAvailable: memory.gcAvailable,
        gcUsed: memory.gcUsed,
      },
      convergence: measured(convergenceValue),
      conformance: measured({
        passed: conformance.passed,
        suite: conformance.suite,
        scenarioCount: conformance.scenarioCount,
      }),
    },
  }
  const benchmarkValidation = validateBenchmarkResult(result)
  const documentValidation = validateResultDocument(result)
  const countabilityDecision = {
    attempted: false,
    reason: 'reference-only non-CRDT is outside embedded-vs-standalone pairing',
  }
  const expectedDeliveryOrder = trace.events.flatMap((event) => event.operationIds ?? [])
  const actualDeliveryOrder = execution.deliveries.map(({ operationId }) => operationId)
  const deliveryOrderVerified =
    actualDeliveryOrder.length === expectedDeliveryOrder.length &&
    actualDeliveryOrder.every((operationId, index) => operationId === expectedDeliveryOrder[index])
  const serializedResult = JSON.stringify(result)
  const serializedResultBytes = Buffer.byteLength(serializedResult, 'utf8')

  assert.equal(plainReferenceArm.benchmarkable, false)
  assert.equal(result.axes.arm, 'reference-only')
  assert.equal(trace.schemaVersion, 2)
  assert.equal(trace.operations.length, smokeConfig.editCount)
  assert.equal(execution.updates.size, trace.operations.length)
  assert.ok([...execution.updates.values()].every((update) => update instanceof Uint8Array))
  assert.ok(execution.divergenceEvidence.length > 0)
  assert.equal(execution.deliveries.length, trace.events.reduce((count, event) => count + (event.operationIds?.length ?? 0), 0))
  assert.equal(deliveryOrderVerified, true)
  assert.equal(conformance.passed, true)
  assert.equal(CONFORMANCE_SUITE_ID, REQUIRED_CONFORMANCE_SUITE.id)
  assert.equal(CONFORMANCE_SUITE_VERSION, REQUIRED_CONFORMANCE_SUITE.version)
  assert.equal(CONFORMANCE_SUITE_HASH, REQUIRED_CONFORMANCE_SUITE.hash)
  assert.deepEqual(conformance.suite, {
    id: REQUIRED_CONFORMANCE_SUITE.id,
    version: REQUIRED_CONFORMANCE_SUITE.version,
    hash: REQUIRED_CONFORMANCE_SUITE.hash,
  })
  assert.equal(conformance.scenarioCount, REQUIRED_CONFORMANCE_SUITE.scenarioCount)
  assert.equal(convergence.converged, true)
  assert.equal(convergence.oracleMatched, true)
  assert.deepEqual(convergence.oracleMismatchedIndices, [])
  for (const state of finalStates) {
    assert.equal(documentsEqual(await plainReferenceArm.canonicalize(state), trace.finalOracleDocument), true)
  }
  assert.deepEqual(benchmarkValidation, { valid: true, errors: [] })
  assert.deepEqual(documentValidation, { valid: true, errors: [] })
  assert.equal(countabilityDecision.attempted, false)
  assert.equal(Object.hasOwn(result, 'embedded'), false)
  assert.equal(Object.hasOwn(result.provenance.versions, 'liveStore'), false)
  assert.deepEqual(Object.keys(result.metrics.wire.totalTransferredBytes).toSorted(), ['_tag', 'value'])
  assert.deepEqual(Object.keys(result.metrics.atRest.snapshotBytes).toSorted(), ['_tag', 'value'])
  assert.deepEqual(Object.keys(result.metrics.atRest.historyBytes).toSorted(), ['_tag', 'value'])
  for (const metric of [
    result.metrics.wire.perOp,
    ...Object.values(result.metrics.timing),
    result.metrics.memory.rssDeltaBytes,
    result.metrics.memory.heapUsedDeltaBytes,
  ]) {
    assert.equal(Object.hasOwn(metric.value, 'samples'), false)
    assert.equal(metric.value.evidence.count, metric.value.count)
  }
  assert.equal(result.metrics.wire.perOp.value.evidence, wireEvidence)
  assert.deepEqual(wireEvidence, expectedWireEvidence)
  assert.deepEqual(evidenceVerification, {
    valid: true,
    errors: [],
    observed: {
      hash: wireEvidence.hash,
      count: execution.deliveries.length,
      encoding: wireEvidence.encoding,
    },
  })
  assert.equal(evidenceStat.isFile(), true)
  assert.equal(evidenceStat.size, Buffer.byteLength(deliveryEvidenceMaterial, 'utf8'))
  assert.equal(result.provenance.trace.deliveryCount, execution.deliveries.length)
  assert.deepEqual(result.metrics.conformance.value.suite, conformance.suite)
  assert.equal(result.metrics.conformance.value.scenarioCount, conformance.scenarioCount)
  assert.ok(Object.values(result.metrics.timing).every(({ value }) => value.evidence.samples.length === 3))
  assert.equal(result.metrics.memory.rssDeltaBytes.value.evidence.samples.length, 3)
  assert.equal(result.metrics.memory.heapUsedDeltaBytes.value.evidence.samples.length, 3)
  assert.equal(Object.hasOwn(result.metrics.convergence.value, 'canonicalStates'), false)
  assert.equal(Object.hasOwn(result.metrics.convergence.value, 'mismatches'), false)
  assert.ok(serializedResultBytes < 20_000, `smoke result structure exceeded 20KB: ${serializedResultBytes} bytes`)

  console.log(JSON.stringify({
    observation: 'phase0-smoke-metrics',
    result,
    smokeMetadata: {
      firstDivergence: execution.divergenceEvidence[0],
      syncEventCount: trace.events.filter(({ _tag }) => _tag === 'sync').length,
      payloadOccurrenceCount: execution.deliveries.length,
      wireEvidence,
      evidenceVerification,
      evidenceWriterDisposition,
      deliveryOrderVerified,
      benchmarkable: plainReferenceArm.benchmarkable,
      countabilityDecision,
      serializedResultBytes,
    },
  }))
})

const distributionWithEvidence = (distribution, evidence) => {
  const { samples: _samples, ...summary } = distribution
  return { ...summary, evidence }
}

const distributionWithInlineEvidence = (distribution, reference) => {
  const { samples, ...summary } = distribution
  assert.ok(samples.length <= 1000, `inline evidence exceeds 1000 samples: ${reference}`)
  return {
    ...summary,
    evidence: { _tag: 'inline', hash: sha256(JSON.stringify(samples)), count: samples.length, reference, samples },
  }
}

const digestCanonicalDocument = (document) => sha256(JSON.stringify(document))

const sha256 = (material) => `sha256:${createHash('sha256').update(material).digest('hex')}`

const executeTrace = async (trace) => {
  const bootstrapActorId = 'bootstrap'
  const bootstrapState = await plainReferenceArm.bootstrap(bootstrapActorId, trace.initialDocument)
  const bootstrapSnapshot = await plainReferenceArm.encodeSnapshot(bootstrapState)
  const states = new Map()
  for (const actorId of trace.actorIds) states.set(actorId, await plainReferenceArm.decodeSnapshot(bootstrapSnapshot, actorId))

  const updates = new Map()
  const deliveries = []
  const divergenceEvidence = []
  for (const [eventIndex, event] of trace.events.entries()) {
    if (event._tag === 'edit') {
      const { operation } = event
      const applied = await plainReferenceArm.applyLocal(states.get(operation.actorId), operation.edit)
      states.set(operation.actorId, applied.state)
      updates.set(operation.id, applied.update)
      const canonicalStates = await Promise.all(trace.actorIds.map((actorId) => plainReferenceArm.canonicalize(states.get(actorId))))
      if (!canonicalStates.every((document) => documentsEqual(document, canonicalStates[0]))) {
        divergenceEvidence.push({ eventIndex, operationId: operation.id, actorId: operation.actorId, observedBeforeSubsequentSync: true })
      }
      continue
    }

    assert.equal(event._tag, 'sync')
    for (const operationId of event.operationIds) {
      const payload = updates.get(operationId)
      assert.ok(payload instanceof Uint8Array, `missing update for ${operationId}`)
      states.set(event.toActorId, await plainReferenceArm.applyRemote(states.get(event.toActorId), payload))
      deliveries.push({ operationId, fromActorId: event.fromActorId, toActorId: event.toActorId, payload })
    }
  }
  return { states, updates, deliveries, divergenceEvidence, bootstrapSnapshot }
}

const releaseExecution = (execution) => {
  execution.states.clear()
  execution.updates.clear()
  execution.deliveries.length = 0
  execution.divergenceEvidence.length = 0
}
