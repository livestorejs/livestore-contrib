import { readFileSync } from 'node:fs'

import { verifyEvidenceArtifact } from './metrics.mjs'

const RESULT_SCHEMA = JSON.parse(readFileSync(new URL('../results.schema.json', import.meta.url), 'utf8'))
const REQUIRED_TIMINGS = ['encodeMs', 'decodeMs', 'fullReplayMs']
const CORE_METRIC_PATHS = [
  ['wire', 'perOp'],
  ['wire', 'totalTransferredBytes'],
  ['atRest', 'snapshotBytes'],
  ['atRest', 'historyBytes'],
  ...REQUIRED_TIMINGS.map((name) => ['timing', name]),
  ['memory', 'rssDeltaBytes'],
  ['memory', 'heapUsedDeltaBytes'],
]

export const REQUIRED_CONFORMANCE_SUITE = Object.freeze({
  id: 'livestore-rich-text-conformance-v1',
  version: '1.0.0',
  hash: 'sha256:bacb078d5a4517d277d09ef7910a7c018ff9f03c99e629cb2025ce6836ff3ea1',
  scenarioCount: 13,
})

export const measured = (value, evidence = undefined) =>
  evidence === undefined ? { _tag: 'measured', value } : { ...evidence, _tag: 'measured', value }

export const notApplicable = (reason) => {
  if (typeof reason !== 'string' || reason.length === 0) throw new TypeError('reason must be a non-empty string')
  return { _tag: 'not-applicable', reason }
}

/** Validates any document admitted by results.schema.json. */
export const validateResultDocument = (value) => {
  const validation = validateSchema(RESULT_SCHEMA, value)
  if (validation.valid && value?.kind === 'benchmark-result') validateBenchmarkSemantics(value, validation.errors)
  return { valid: validation.errors.length === 0, errors: validation.errors }
}

/** Validates one stored benchmark observation, including failed/non-countable observations. */
export const validateBenchmarkResult = (value) => {
  const validation = validateSchema(RESULT_SCHEMA.$defs.benchmarkResult, value)
  if (validation.valid) validateBenchmarkSemantics(value, validation.errors)
  return { valid: validation.errors.length === 0, errors: validation.errors }
}

/** Validates a successfully computed TAX row. */
export const validateTaxRow = (value) => validateSchema(RESULT_SCHEMA.$defs.taxRow, value)

/**
 * Decides whether two stored observations are eligible for TAX computation.
 * Failure is data, not an exception: failed conformance/convergence rows remain storable.
 */
export const assessCountability = async (embedded, standalone) => {
  const reasons = []
  assessResultValidity(embedded, 'embedded', reasons)
  assessResultValidity(standalone, 'standalone', reasons)

  if (reasons.some(({ code }) => code === 'invalid-result')) return notCountable(embedded, standalone, reasons)

  if (embedded.axes.arm !== 'embedded') {
    addReason(reasons, 'wrong-arm', '$.embedded.axes.arm', 'must equal "embedded"')
  }
  if (standalone.axes.arm !== 'standalone') {
    addReason(reasons, 'wrong-arm', '$.standalone.axes.arm', 'must equal "standalone"')
  }

  assessEvidence(embedded, 'embedded', reasons)
  assessEvidence(standalone, 'standalone', reasons)
  assessProvenance(embedded, 'embedded', reasons)
  assessProvenance(standalone, 'standalone', reasons)
  assessComparability(embedded, standalone, reasons)

  await assessExternalEvidence(embedded, 'embedded', reasons)
  await assessExternalEvidence(standalone, 'standalone', reasons)

  if (reasons.length > 0) return notCountable(embedded, standalone, reasons)
  return { _tag: 'countable', pairedRunId: embedded.provenance.pairedRunId }
}

/** Returns a TAX row for countable evidence, otherwise a tagged explanation with no ratios. */
export const computeTaxRow = async (embedded, standalone) => {
  const assessment = await assessCountability(embedded, standalone)
  if (assessment._tag === 'not-countable') return assessment

  return {
    schemaVersion: 1,
    kind: 'tax-row',
    pairedRunId: assessment.pairedRunId,
    trace: { ...embedded.provenance.trace },
    numeratorId: embedded.id,
    denominatorId: standalone.id,
    axes: { ...embedded.axes, arm: 'embedded-over-standalone' },
    metrics: {
      wire: {
        perOp: Object.fromEntries(
          ['avg', 'p50', 'p95', 'p99'].map((name) => [
            name,
            divideMetrics(embedded.metrics.wire.perOp, standalone.metrics.wire.perOp, name),
          ]),
        ),
        totalTransferredBytes: divideMetrics(
          embedded.metrics.wire.totalTransferredBytes,
          standalone.metrics.wire.totalTransferredBytes,
        ),
      },
      atRest: {
        snapshotBytes: divideMetrics(embedded.metrics.atRest.snapshotBytes, standalone.metrics.atRest.snapshotBytes),
        historyBytes: divideMetrics(embedded.metrics.atRest.historyBytes, standalone.metrics.atRest.historyBytes),
      },
      timing: Object.fromEntries(
        REQUIRED_TIMINGS.map((name) => [
          name,
          divideMetrics(embedded.metrics.timing[name], standalone.metrics.timing[name], 'median'),
        ]),
      ),
      memory: {
        rssDeltaBytes: divideMetrics(
          embedded.metrics.memory.rssDeltaBytes,
          standalone.metrics.memory.rssDeltaBytes,
          'median',
          {
            memory: true,
            numeratorGcUsed: embedded.metrics.memory.gcUsed,
            denominatorGcUsed: standalone.metrics.memory.gcUsed,
          },
        ),
        heapUsedDeltaBytes: divideMetrics(
          embedded.metrics.memory.heapUsedDeltaBytes,
          standalone.metrics.memory.heapUsedDeltaBytes,
          'median',
          {
            memory: true,
            numeratorGcUsed: embedded.metrics.memory.gcUsed,
            denominatorGcUsed: standalone.metrics.memory.gcUsed,
          },
        ),
      },
    },
  }
}

const divideMetrics = (
  numeratorMetric,
  denominatorMetric,
  field,
  { memory = false, numeratorGcUsed = undefined, denominatorGcUsed = undefined } = {},
) => {
  const numerator = field === undefined ? numeratorMetric.value : numeratorMetric.value[field]
  const denominator = field === undefined ? denominatorMetric.value : denominatorMetric.value[field]
  if (memory && numeratorGcUsed !== denominatorGcUsed) {
    return notApplicableRatio('memory-gc-mode-mismatch', numerator, denominator)
  }
  if (memory && (numerator <= 0 || memoryMetricIsUnstable(numeratorMetric))) {
    return notApplicableRatio('embedded-memory-numerator-non-positive-or-unstable', numerator, denominator)
  }
  if (denominator <= 0) {
    return notApplicableRatio('standalone-denominator-non-positive', numerator, denominator)
  }
  if (memory && memoryMetricIsUnstable(denominatorMetric)) {
    return notApplicableRatio('standalone-memory-denominator-non-positive-or-unstable', numerator, denominator)
  }
  return { _tag: 'measured', ratio: numerator / denominator, numerator, denominator }
}

const memoryMetricIsUnstable = (metric) => {
  const { value } = metric
  if (value.min <= 0) return true
  if (value.stddev >= Math.abs(value.median)) return true
  if (value.evidence?._tag === 'inline' && value.evidence.samples.some((sample) => sample <= 0)) return true
  return false
}

const notApplicableRatio = (reason, numerator, denominator) => ({
  _tag: 'not-applicable',
  reason,
  numerator,
  denominator,
})

const assessResultValidity = (value, name, reasons) => {
  const validation = validateBenchmarkResult(value)
  for (const { path, message } of validation.errors) {
    addReason(reasons, 'invalid-result', `$.${name}${path.slice(1)}`, message)
  }
}

const assessEvidence = (result, name, reasons) => {
  const prefix = `$.${name}.metrics`
  const conformance = result.metrics.conformance
  if (
    conformance._tag !== 'measured' ||
    conformance.value.passed !== true ||
    conformance.value.scenarioCount !== REQUIRED_CONFORMANCE_SUITE.scenarioCount ||
    conformance.value.suite.id !== REQUIRED_CONFORMANCE_SUITE.id ||
    conformance.value.suite.version !== REQUIRED_CONFORMANCE_SUITE.version ||
    conformance.value.suite.hash !== REQUIRED_CONFORMANCE_SUITE.hash
  ) {
    addReason(
      reasons,
      'conformance-not-passed',
      `${prefix}.conformance`,
      'must pass the exact required conformance suite identity and all 13 scenarios',
    )
  }

  const convergence = result.metrics.convergence
  if (
    convergence._tag !== 'measured' ||
    convergence.value.converged !== true ||
    convergence.value.oracleMatched !== true
  ) {
    addReason(
      reasons,
      'convergence-not-proven',
      `${prefix}.convergence`,
      'must be measured with converged=true and oracleMatched=true',
    )
  }

  for (const path of CORE_METRIC_PATHS) {
    const metric = path.reduce((value, key) => value[key], result.metrics)
    if (metric._tag !== 'measured') {
      addReason(reasons, 'core-metric-not-measured', `${prefix}.${path.join('.')}`, 'must be measured')
    }
  }

  if (result.axes.arm === 'embedded') assessEmbeddedEvidence(result, name, reasons)
}

const assessEmbeddedEvidence = (result, name, reasons) => {
  const prefix = `$.${name}.embedded`
  const embedded = result.embedded
  if (embedded === undefined) {
    addReason(reasons, 'missing-embedded-evidence', prefix, 'embedded TAX requires LiveStore-specific evidence')
    return
  }
  if (embedded.payloadInflation === undefined) {
    addReason(reasons, 'missing-embedded-evidence', `${prefix}.payloadInflation`, 'is required')
  }
  if (embedded.orderingEffect?._tag !== 'measured') {
    addReason(reasons, 'missing-embedded-evidence', `${prefix}.orderingEffect`, 'must contain measured typed evidence')
  }
  if (embedded.logGrowth?.withoutCompaction !== true || embedded.logGrowth.checkpoints.length === 0) {
    addReason(reasons, 'missing-embedded-evidence', `${prefix}.logGrowth`, 'must contain uncompacted checkpoints')
  }
}

const assessProvenance = (result, name, reasons) => {
  const path = `$.${name}.provenance`
  if (result.provenance === undefined) {
    addReason(reasons, 'missing-provenance', path, 'is required before TAX computation')
    return
  }

  const requiredPaths = [
    ['pairedRunId'],
    ['trace', 'id'],
    ['trace', 'hash'],
    ['trace', 'deliveryCount'],
    ['crdt', 'name'],
    ['crdt', 'version'],
    ['versions', 'harness'],
    ['versions', 'protocol'],
    ['versions', 'library'],
    ['measurementProtocol'],
    ['wireProtocol'],
  ]
  for (const parts of requiredPaths) {
    if (parts.reduce((value, key) => value?.[key], result.provenance) === undefined) {
      addReason(reasons, 'missing-provenance', `${path}.${parts.join('.')}`, 'is required before TAX computation')
    }
  }
  if (result.runtime.cpu === undefined) {
    addReason(reasons, 'missing-provenance', `$.${name}.runtime.cpu`, 'is required before TAX computation')
  }
  if (result.axes.arm === 'embedded' && result.provenance.versions.liveStore === undefined) {
    addReason(
      reasons,
      'missing-provenance',
      `${path}.versions.liveStore`,
      'embedded TAX requires LiveStore version and commit',
    )
  }
}

const assessComparability = (embedded, standalone, reasons) => {
  const pairs = [
    ['version', embedded.version, standalone.version],
    ['seed', embedded.seed, standalone.seed],
    ['axes.technology', embedded.axes.technology, standalone.axes.technology],
    ['axes.documentSizeBytes', embedded.axes.documentSizeBytes, standalone.axes.documentSizeBytes],
    ['axes.editCount', embedded.axes.editCount, standalone.axes.editCount],
    ['axes.concurrency', embedded.axes.concurrency, standalone.axes.concurrency],
    ['provenance.pairedRunId', embedded.provenance?.pairedRunId, standalone.provenance?.pairedRunId],
    ['provenance.trace.id', embedded.provenance?.trace?.id, standalone.provenance?.trace?.id],
    ['provenance.trace.hash', embedded.provenance?.trace?.hash, standalone.provenance?.trace?.hash],
    [
      'provenance.trace.deliveryCount',
      embedded.provenance?.trace?.deliveryCount,
      standalone.provenance?.trace?.deliveryCount,
    ],
    ['provenance.crdt.name', embedded.provenance?.crdt?.name, standalone.provenance?.crdt?.name],
    ['provenance.crdt.version', embedded.provenance?.crdt?.version, standalone.provenance?.crdt?.version],
    ['provenance.versions.harness', embedded.provenance?.versions?.harness, standalone.provenance?.versions?.harness],
    ['provenance.versions.protocol', embedded.provenance?.versions?.protocol, standalone.provenance?.versions?.protocol],
    ['provenance.versions.library', embedded.provenance?.versions?.library, standalone.provenance?.versions?.library],
  ]
  for (const [path, left, right] of pairs) {
    if (left !== right) addReason(reasons, 'not-comparable', `$.${path}`, 'embedded and standalone values must match')
  }

  const structuralPairs = [
    ['axes.offlineBranchDurations', embedded.axes.offlineBranchDurations, standalone.axes.offlineBranchDurations],
    ['runtime', embedded.runtime, standalone.runtime],
    [
      'provenance.measurementProtocol',
      embedded.provenance?.measurementProtocol,
      standalone.provenance?.measurementProtocol,
    ],
  ]
  for (const [path, left, right] of structuralPairs) {
    if (!deepEqualJson(left, right)) {
      addReason(reasons, 'not-comparable', `$.${path}`, 'embedded and standalone values must match')
    }
  }
}

const notCountable = (embedded, standalone, reasons) => ({
  schemaVersion: 1,
  kind: 'tax-assessment',
  _tag: 'not-countable',
  numeratorId: isRecord(embedded) && typeof embedded.id === 'string' ? embedded.id : null,
  denominatorId: isRecord(standalone) && typeof standalone.id === 'string' ? standalone.id : null,
  reasons,
})

const addReason = (reasons, code, path, message) => reasons.push({ code, path, message })

const assessExternalEvidence = async (result, name, reasons) => {
  const references = []
  collectExternalEvidence(result, `$.${name}`, references)
  const verifications = await Promise.all(
    references.map(async ({ path, reference }) => {
      try {
        return { path, verification: await verifyEvidenceArtifact(reference) }
      } catch (error) {
        return { path, verification: { valid: false, errors: [error.message] } }
      }
    }),
  )
  for (const { path, verification } of verifications) {
    if (!verification.valid) {
      addReason(
        reasons,
        'external-evidence-invalid',
        path,
        `external evidence failed verification: ${verification.errors.join('; ')}`,
      )
    }
  }
}

const collectExternalEvidence = (value, path, output) => {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectExternalEvidence(item, `${path}[${index}]`, output))
    return
  }
  if (!isRecord(value)) return
  if (value._tag === 'external') {
    output.push({ path, reference: value })
    return
  }
  for (const [key, child] of Object.entries(value)) collectExternalEvidence(child, `${path}.${key}`, output)
}

const validateBenchmarkSemantics = (result, errors) => {
  const measuredDistributions = [
    ['$.metrics.wire.perOp', result.metrics.wire.perOp, result.provenance?.trace.deliveryCount, false],
    ...REQUIRED_TIMINGS.map((name) => [
      `$.metrics.timing.${name}`,
      result.metrics.timing[name],
      result.provenance?.measurementProtocol.iterations,
      false,
    ]),
    ['$.metrics.memory.rssDeltaBytes', result.metrics.memory.rssDeltaBytes, result.provenance?.measurementProtocol.iterations, true],
    [
      '$.metrics.memory.heapUsedDeltaBytes',
      result.metrics.memory.heapUsedDeltaBytes,
      result.provenance?.measurementProtocol.iterations,
      true,
    ],
  ]
  for (const [path, metric, expectedCount, allowNegative] of measuredDistributions) {
    if (metric._tag === 'measured') validateDistribution(metric.value, path, expectedCount, allowNegative, errors)
  }

  if (result.metrics.wire.perOp._tag === 'measured' && result.metrics.wire.totalTransferredBytes._tag === 'measured') {
    if (!approximatelyEqual(result.metrics.wire.perOp.value.total, result.metrics.wire.totalTransferredBytes.value)) {
      errors.push({
        path: '$.metrics.wire.totalTransferredBytes.value',
        message: 'must equal metrics.wire.perOp.value.total',
      })
    }
  }

  validateConvergenceSemantics(result.metrics.convergence, result.axes.concurrency, errors)
  if (result.embedded !== undefined) validateEmbeddedSemantics(result.embedded, result.axes.editCount, errors)
}

const validateDistribution = (distribution, path, expectedCount, allowNegative, errors) => {
  if (distribution.evidence.count !== distribution.count) {
    errors.push({ path: `${path}.value.evidence.count`, message: 'must equal distribution count' })
  }
  if (distribution.evidence._tag === 'inline' && distribution.evidence.samples.length !== distribution.count) {
    errors.push({ path: `${path}.value.evidence.samples`, message: 'length must equal distribution count' })
  }
  if (distribution.evidence._tag === 'inline') {
    const samples = distribution.evidence.samples
    if (!allowNegative && samples.some((sample) => sample < 0)) {
      errors.push({ path: `${path}.value.evidence.samples`, message: 'timing samples must be non-negative' })
    }
    const actualTotal = samples.reduce((sum, sample) => sum + sample, 0)
    const actualAvg = actualTotal / samples.length
    const actualVariance = samples.reduce((sum, sample) => sum + (sample - actualAvg) ** 2, 0) / samples.length
    const checks = [
      ['total', actualTotal],
      ['min', Math.min(...samples)],
      ['max', Math.max(...samples)],
      ['avg', actualAvg],
      ['variance', actualVariance],
      ['stddev', Math.sqrt(actualVariance)],
    ]
    for (const [field, actual] of checks) {
      if (!approximatelyEqual(distribution[field], actual)) {
        errors.push({ path: `${path}.value.${field}`, message: `must match inline evidence samples` })
      }
    }
  }
  if (expectedCount !== undefined && distribution.count !== expectedCount) {
    errors.push({ path: `${path}.value.count`, message: `must equal expected measurement count ${expectedCount}` })
  }
  if (!approximatelyEqual(distribution.total, distribution.avg * distribution.count)) {
    errors.push({ path: `${path}.value.total`, message: 'must equal avg * count within numeric tolerance' })
  }
  if (!approximatelyEqual(distribution.variance, distribution.stddev ** 2)) {
    errors.push({ path: `${path}.value.variance`, message: 'must equal stddev squared within numeric tolerance' })
  }
  const ordered = [distribution.min, distribution.p50, distribution.median, distribution.p95, distribution.p99, distribution.max]
  if (ordered.some((value, index) => index > 0 && value < ordered[index - 1])) {
    errors.push({ path: `${path}.value`, message: 'quantiles must be ordered min <= p50 <= median <= p95 <= p99 <= max' })
  }
  if (distribution.avg < distribution.min || distribution.avg > distribution.max) {
    errors.push({ path: `${path}.value.avg`, message: 'must be between min and max' })
  }
}

const validateConvergenceSemantics = (metric, concurrency, errors) => {
  if (metric._tag !== 'measured') return
  const value = metric.value
  if (value.stateCount !== concurrency) {
    errors.push({ path: '$.metrics.convergence.value.stateCount', message: 'must equal axes.concurrency' })
  }
  if (value.canonicalDigests.length !== value.stateCount) {
    errors.push({ path: '$.metrics.convergence.value.canonicalDigests', message: 'length must equal stateCount' })
  }
  if (value.converged) {
    if (value.mismatchedIndices.length !== 0 || new Set(value.canonicalDigests).size > 1) {
      errors.push({
        path: '$.metrics.convergence.value.converged',
        message: 'true requires identical canonical digests and no peer mismatches',
      })
    }
  }
  if (value.oracleMatched) {
    if (
      value.oracleMismatchedIndices.length !== 0 ||
      value.canonicalDigests.some((digest) => digest !== value.oracleDigest)
    ) {
      errors.push({
        path: '$.metrics.convergence.value.oracleMatched',
        message: 'true requires every canonical digest to match oracleDigest and no oracle mismatches',
      })
    }
  }
}

const validateEmbeddedSemantics = (embedded, editCount, errors) => {
  const inflation = embedded.payloadInflation
  if (inflation !== undefined) {
    if (inflation.nativeBytes <= 0 || inflation.base64Bytes < inflation.nativeBytes || inflation.jsonBytes < inflation.base64Bytes) {
      errors.push({
        path: '$.embedded.payloadInflation',
        message: 'must satisfy 0 < nativeBytes <= base64Bytes <= jsonBytes',
      })
    }
  }
  if (
    embedded.orderingEffect?._tag === 'measured' &&
    embedded.orderingEffect.value.serializedOperationCount !== editCount
  ) {
    errors.push({
      path: '$.embedded.orderingEffect.value.serializedOperationCount',
      message: 'must equal axes.editCount',
    })
  }
  const checkpoints = embedded.logGrowth?.checkpoints ?? []
  for (let index = 1; index < checkpoints.length; index += 1) {
    if (
      checkpoints[index].editCount <= checkpoints[index - 1].editCount ||
      checkpoints[index].historyBytes < checkpoints[index - 1].historyBytes
    ) {
      errors.push({
        path: `$.embedded.logGrowth.checkpoints[${index}]`,
        message: 'editCount must increase and uncompacted historyBytes must not decrease',
      })
    }
  }
  if (checkpoints.length > 0 && checkpoints.at(-1).editCount !== editCount) {
    errors.push({ path: '$.embedded.logGrowth.checkpoints', message: 'final checkpoint editCount must equal axes.editCount' })
  }
}

const approximatelyEqual = (left, right) => {
  const scale = Math.max(1, Math.abs(left), Math.abs(right))
  return Math.abs(left - right) <= Number.EPSILON * 16 * scale
}

const validateSchema = (schema, value) => {
  const errors = []
  visitSchema(schema, value, '$', errors)
  return { valid: errors.length === 0, errors }
}

/** Dependency-free interpreter for the schema keywords used by results.schema.json. */
const visitSchema = (schema, value, path, errors) => {
  if (schema === true) return
  if (schema === false) return errors.push({ path, message: 'is not allowed' })
  if (schema.$ref !== undefined) {
    const target = resolveLocalReference(schema.$ref)
    visitSchema(target, value, path, errors)
  }
  if (schema.allOf !== undefined) {
    for (const child of schema.allOf) visitSchema(child, value, path, errors)
  }
  if (schema.oneOf !== undefined) {
    const attempts = schema.oneOf.map((child) => {
      const attemptErrors = []
      visitSchema(child, value, path, attemptErrors)
      return attemptErrors
    })
    const successful = attempts.filter((attempt) => attempt.length === 0)
    if (successful.length !== 1) {
      const best = attempts.toSorted((left, right) => left.length - right.length)[0]
      errors.push(...(best.length === 0 ? [{ path, message: 'must match exactly one schema variant' }] : best))
    }
    return
  }
  if (schema.const !== undefined && !Object.is(value, schema.const)) {
    errors.push({ path, message: `must equal ${JSON.stringify(schema.const)}` })
  }
  if (schema.enum !== undefined && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    errors.push({ path, message: `must be one of ${schema.enum.map(JSON.stringify).join(', ')}` })
  }

  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    errors.push({ path, message: `must be ${Array.isArray(schema.type) ? schema.type.join(' or ') : schema.type}` })
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) errors.push({ path, message: 'must be a finite number' })
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({ path, message: `must be >= ${schema.minimum}` })
    }
  }
  if (typeof value === 'string' && schema.minLength !== undefined && value.length < schema.minLength) {
    errors.push({ path, message: `must have length >= ${schema.minLength}` })
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ path, message: `must contain at least ${schema.minItems} items` })
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push({ path, message: `must contain at most ${schema.maxItems} items` })
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => visitSchema(schema.items, item, `${path}[${index}]`, errors))
    }
  }
  if (isRecord(value)) {
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(value, name)) errors.push({ path: `${path}.${name}`, message: 'is required' })
    }
    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, name)) visitSchema(child, value[name], `${path}.${name}`, errors)
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}))
      for (const name of Object.keys(value)) {
        if (!allowed.has(name)) errors.push({ path: `${path}.${name}`, message: 'is not allowed' })
      }
    }
  }
}

const resolveLocalReference = (reference) => {
  if (!reference.startsWith('#/')) throw new TypeError(`unsupported schema reference: ${reference}`)
  return reference
    .slice(2)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce((value, key) => value[key], RESULT_SCHEMA)
}

const matchesType = (value, type) => {
  if (Array.isArray(type)) return type.some((candidate) => matchesType(value, candidate))
  if (type === 'object') return isRecord(value)
  if (type === 'array') return Array.isArray(value)
  if (type === 'integer') return Number.isInteger(value)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'null') return value === null
  return typeof value === type
}

const deepEqualJson = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
