import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { cpus } from 'node:os'
import { dirname, join } from 'node:path'

import { runConformanceSuite } from '../harness/src/conformance.mjs'
import {
  byteLength,
  checkConvergence,
  collectSnapshotBytes,
  collectTransferredBytes,
  measureRepeated,
  measureRetainedMemory,
  writeEvidenceArtifact,
} from '../harness/src/metrics.mjs'
import {
  assessCountability,
  computeTaxRow,
  measured,
  validateBenchmarkResult,
  validateTaxRow,
} from '../harness/src/results.mjs'
import { generateTrace } from '../harness/src/trace.mjs'

export const MEASUREMENT_PROTOCOL = Object.freeze({
  warmups: 1,
  iterations: 3,
  clock: 'performance.now monotonic milliseconds',
  gc: { requested: true },
  statistics: {
    median: 'nearest-rank p50',
    quantiles: 'nearest-rank',
    variance: 'population',
  },
})

const HARNESS_VERSION = 'phase0-v1'
const PROTOCOL_VERSION = 'tax-result-v1-trace-v2'

/** Executes the trace-v2 wire protocol with one shared bootstrap snapshot. */
export const executeTrace = async (arm, trace) => {
  const bootstrapState = await arm.bootstrap('bootstrap', trace.initialDocument)
  const bootstrapSnapshot = await arm.encodeSnapshot(bootstrapState)
  const states = new Map()
  for (const actorId of trace.actorIds) states.set(actorId, await arm.decodeSnapshot(bootstrapSnapshot, actorId))

  const updates = new Map()
  const deliveries = []
  for (const event of trace.events) {
    if (event._tag === 'edit') {
      const { operation } = event
      const applied = await arm.applyLocal(states.get(operation.actorId), operation.edit)
      assert.ok(applied.update instanceof Uint8Array, `${arm.id}: ${operation.id} did not emit Uint8Array update bytes`)
      states.set(operation.actorId, applied.state)
      updates.set(operation.id, applied.update)
      continue
    }

    assert.equal(event._tag, 'sync')
    for (const operationId of event.operationIds) {
      const payload = updates.get(operationId)
      assert.ok(payload instanceof Uint8Array, `${arm.id}: missing update ${operationId}`)
      states.set(event.toActorId, await arm.applyRemote(states.get(event.toActorId), payload))
      deliveries.push({
        operationId,
        fromActorId: event.fromActorId,
        toActorId: event.toActorId,
        payload,
      })
    }
  }

  const expectedDeliveryCount = trace.events.reduce((total, event) => total + (event.operationIds?.length ?? 0), 0)
  assert.equal(deliveries.length, expectedDeliveryCount, `${arm.id}: wire delivery count mismatch`)
  assert.equal(updates.size, trace.operations.length, `${arm.id}: local update count mismatch`)
  return { states, updates, deliveries, bootstrapSnapshot }
}

/** Runs and atomically publishes one paired standalone/embedded benchmark cell. */
export const runCell = async ({
  standaloneArm,
  embeddedArm,
  config,
  outputPath,
  evidenceDirectory = join(dirname(outputPath), 'evidence'),
}) => {
  requireExposedGc()
  const trace = generateTrace(config)
  const [standaloneConformance, embeddedConformance] = await Promise.all([
    runConformanceSuite(standaloneArm),
    runConformanceSuite(embeddedArm),
  ])
  assert.equal(standaloneConformance.passed, true, `${standaloneArm.id}: conformance failed`)
  assert.equal(embeddedConformance.passed, true, `${embeddedArm.id}: conformance failed`)

  const runtime = runtimeIdentity()
  const pairedRunId = cellId(config)
  const common = { trace, config, runtime, pairedRunId, evidenceDirectory }
  const standalone = await measureArm({ arm: standaloneArm, conformance: standaloneConformance, ...common })
  const embedded = await measureArm({ arm: embeddedArm, conformance: embeddedConformance, ...common })

  assertValidBenchmarkResult(standalone)
  assertValidBenchmarkResult(embedded)
  const countability = await assessCountability(embedded, standalone)
  assert.equal(countability._tag, 'countable', `pair is not countable: ${JSON.stringify(countability)}`)
  const tax = await computeTaxRow(embedded, standalone)
  assert.equal(tax.kind, 'tax-row', `TAX was not computed: ${JSON.stringify(tax)}`)
  const taxValidation = validateTaxRow(tax)
  assert.deepEqual(taxValidation, { valid: true, errors: [] })

  const document = {
    schemaVersion: 1,
    kind: 'loro-paired-cell',
    config,
    conformance: {
      standalone: compactConformance(standaloneConformance),
      embedded: compactConformance(embeddedConformance),
    },
    results: { standalone, embedded },
    countability,
    tax,
  }
  await writeJsonAtomic(outputPath, document)
  return document
}

const measureArm = async ({ arm, conformance, trace, config, runtime, pairedRunId, evidenceDirectory }) => {
  const execution = await executeTrace(arm, trace)
  const finalStates = [...execution.states.values()]
  const convergence = await checkConvergence({
    states: finalStates,
    canonicalize: (state) => arm.canonicalize(state),
    expected: trace.finalOracleDocument,
  })
  const deliveryPayloads = execution.deliveries.map(({ payload }) => payload)
  const transfer = collectTransferredBytes(deliveryPayloads)
  const finalSnapshot = await arm.encodeSnapshot(finalStates[0])
  const encode = await measureRepeated(() => arm.encodeSnapshot(finalStates[0]), MEASUREMENT_PROTOCOL)
  const decode = await measureRepeated(
    (index) => arm.decodeSnapshot(finalSnapshot, `${arm.id}-decoder-${index}`),
    MEASUREMENT_PROTOCOL,
  )
  const replay = await measureRepeated(async () => {
    const replayExecution = await executeTrace(arm, trace)
    await releaseExecution(arm, replayExecution)
  }, MEASUREMENT_PROTOCOL)
  const memory = await measureRetainedMemory({
    allocate: () => executeTrace(arm, trace),
    release: (retained) => releaseExecution(arm, retained),
    warmups: MEASUREMENT_PROTOCOL.warmups,
    iterations: MEASUREMENT_PROTOCOL.iterations,
    gc: MEASUREMENT_PROTOCOL.gc.requested,
  })

  const evidencePath = join(evidenceDirectory, `${pairedRunId}-${armAxis(arm)}-deliveries.ndjson.gz`)
  const wireEvidence = await writeEvidenceArtifact({
    path: evidencePath,
    compression: 'gzip',
    records: execution.deliveries.map(({ operationId, fromActorId, toActorId, payload }, deliveryIndex) => ({
      bytes: byteLength(payload),
      deliveryIndex,
      fromActorId,
      operationId,
      toActorId,
    })),
  })

  const snapshotBytes = collectSnapshotBytes(finalSnapshot)
  const historyBytes = await getHistoryBytes(arm, execution, trace)
  const metadata = requireMetadata(arm)
  const traceIdentity = {
    id: `${pairedRunId}-trace-v${trace.schemaVersion}`,
    hash: sha256(JSON.stringify(trace)),
    deliveryCount: execution.deliveries.length,
  }
  const result = {
    schemaVersion: 1,
    kind: 'benchmark-result',
    id: `${pairedRunId}-${metadata.axis}`,
    version: `trace-v${trace.schemaVersion}`,
    seed: trace.seed,
    runtime,
    provenance: {
      pairedRunId,
      trace: traceIdentity,
      crdt: { name: metadata.crdtName, version: metadata.crdtVersion },
      versions: {
        harness: HARNESS_VERSION,
        protocol: PROTOCOL_VERSION,
        library: metadata.libraryVersion,
        ...(metadata.liveStore === undefined ? {} : { liveStore: metadata.liveStore }),
      },
      measurementProtocol: MEASUREMENT_PROTOCOL,
      wireProtocol: metadata.wireProtocol,
    },
    axes: {
      technology: metadata.technology,
      arm: metadata.axis,
      documentSizeBytes: config.docSizeBytes,
      editCount: config.editCount,
      concurrency: config.concurrency,
      offlineBranchDurations: [...trace.workload.offlineBranchDurations],
    },
    ...(metadata.axis === 'embedded' ? { embedded: await getEmbeddedEvidence(arm, execution, trace) } : {}),
    metrics: {
      wire: {
        perOp: measured(distributionWithEvidence(transfer.perOp, wireEvidence)),
        totalTransferredBytes: measured(transfer.total),
      },
      atRest: {
        snapshotBytes: measured(snapshotBytes),
        historyBytes: measured(historyBytes),
      },
      timing: {
        encodeMs: measured(distributionWithInlineEvidence(encode.elapsedMs, `${arm.id}://timing/encode-ms`)),
        decodeMs: measured(distributionWithInlineEvidence(decode.elapsedMs, `${arm.id}://timing/decode-ms`)),
        fullReplayMs: measured(distributionWithInlineEvidence(replay.elapsedMs, `${arm.id}://timing/full-replay-ms`)),
      },
      memory: {
        rssDeltaBytes: measured(
          distributionWithInlineEvidence(memory.rssDeltaBytes, `${arm.id}://memory/rss-delta-bytes`),
        ),
        heapUsedDeltaBytes: measured(
          distributionWithInlineEvidence(memory.heapUsedDeltaBytes, `${arm.id}://memory/heap-used-delta-bytes`),
        ),
        gcAvailable: memory.gcAvailable,
        gcUsed: memory.gcUsed,
      },
      convergence: measured(compactConvergence(convergence, trace.finalOracleDocument)),
      conformance: measured({
        passed: conformance.passed,
        suite: conformance.suite,
        scenarioCount: conformance.scenarioCount,
      }),
    },
  }
  await releaseExecution(arm, execution)
  return result
}

const getHistoryBytes = async (arm, execution, trace) => {
  if (typeof arm.historyBytes === 'function') {
    const value = await arm.historyBytes({ execution, trace })
    assert.ok(Number.isInteger(value) && value >= 0, `${arm.id}: historyBytes hook returned invalid value`)
    return value
  }
  return [...execution.updates.values()].reduce((total, update) => total + byteLength(update), 0)
}

const getEmbeddedEvidence = async (arm, execution, trace) => {
  assert.equal(typeof arm.embeddedEvidence, 'function', `${arm.id}: embeddedEvidence hook is required`)
  return arm.embeddedEvidence({ execution, trace })
}

const releaseExecution = async (arm, execution) => {
  if (typeof arm.releaseExecution === 'function') await arm.releaseExecution(execution)
  execution.states.clear()
  execution.updates.clear()
  execution.deliveries.length = 0
}

const compactConvergence = (convergence, oracle) => ({
  converged: convergence.converged,
  oracleMatched: convergence.oracleMatched,
  stateCount: convergence.stateCount,
  canonicalDigests: convergence.canonicalStates.map((document) => sha256(JSON.stringify(document))),
  oracleDigest: sha256(JSON.stringify(oracle)),
  mismatchedIndices: convergence.mismatchedIndices,
  oracleMismatchedIndices: convergence.oracleMismatchedIndices,
})

const compactConformance = ({ armId, passed, suite, scenarioCount, editCount, snapshotBytes }) => ({
  armId,
  passed,
  suite,
  scenarioCount,
  editCount,
  snapshotBytes,
})

const distributionWithEvidence = (distribution, evidence) => {
  const { samples: _samples, ...summary } = distribution
  return { ...summary, evidence }
}

const distributionWithInlineEvidence = (distribution, reference) => {
  const { samples, ...summary } = distribution
  return {
    ...summary,
    evidence: { _tag: 'inline', hash: sha256(JSON.stringify(samples)), count: samples.length, reference, samples },
  }
}

const requireMetadata = (arm) => {
  const metadata = arm.benchmarkMetadata
  assert.ok(metadata, `${arm.id}: benchmarkMetadata is required`)
  for (const key of ['axis', 'technology', 'crdtName', 'crdtVersion', 'libraryVersion', 'wireProtocol']) {
    assert.ok(metadata[key], `${arm.id}: benchmarkMetadata.${key} is required`)
  }
  assert.ok(['standalone', 'embedded'].includes(metadata.axis), `${arm.id}: invalid benchmark axis`)
  return metadata
}

const armAxis = (arm) => requireMetadata(arm).axis

const runtimeIdentity = () => {
  const cpu = cpus()
  return {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: { model: cpu[0]?.model ?? 'unknown-cpu', count: cpu.length },
  }
}

const cellId = ({ seed, docSizeBytes, editCount, concurrency }) =>
  `loro-${String(seed).replaceAll(/[^a-zA-Z0-9_.-]/g, '_')}-${docSizeBytes}-${editCount}-${concurrency}`

const requireExposedGc = () => {
  assert.equal(typeof globalThis.gc, 'function', 'run with node --expose-gc')
}

const assertValidBenchmarkResult = (result) => {
  const validation = validateBenchmarkResult(result)
  assert.deepEqual(validation, { valid: true, errors: [] }, `${result.id}: ${JSON.stringify(validation.errors)}`)
}

const writeJsonAtomic = async (path, value) => {
  const bytes = `${JSON.stringify(value)}\n`
  await mkdir(dirname(path), { recursive: true })
  const existing = await readFile(path, 'utf8').catch((error) => (error.code === 'ENOENT' ? undefined : Promise.reject(error)))
  if (existing !== undefined) {
    if (existing === bytes) return
    const error = new Error(`refusing to replace different cell output: ${path}`)
    error.code = 'EEXIST'
    throw error
  }
  const stagingPath = `${path}.${process.pid}.writing`
  await writeFile(stagingPath, bytes, { flag: 'wx' })
  try {
    await link(stagingPath, path)
  } finally {
    await unlink(stagingPath).catch(() => {})
  }
}

const sha256 = (material) => `sha256:${createHash('sha256').update(material).digest('hex')}`
