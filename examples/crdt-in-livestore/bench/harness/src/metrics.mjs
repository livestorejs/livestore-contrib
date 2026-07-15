import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { performance } from 'node:perf_hooks'
import { gunzipSync, gzipSync } from 'node:zlib'

const PERCENTILES = [
  ['p50', 0.5],
  ['p95', 0.95],
  ['p99', 0.99],
]

/** Summarizes numeric samples using nearest-rank quantiles and population variance. */
export const summarize = (samples) => summarizeValues(samples, false)

const summarizeValues = (samples, allowNegative) => {
  const values = Array.from(samples)
  if (values.length === 0) throw new RangeError('summarize requires at least one sample')
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError('summarize samples must be finite numbers')
    }
    if (!allowNegative && value < 0) throw new RangeError('summarize samples must be non-negative')
  }

  const sorted = values.toSorted((a, b) => a - b)
  const total = values.reduce((sum, value) => sum + value, 0)
  const avg = total / values.length
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length
  const result = {
    samples: values,
    count: values.length,
    total,
    min: sorted[0],
    max: sorted.at(-1),
    avg,
    variance,
    stddev: Math.sqrt(variance),
    median: nearestRank(sorted, 0.5),
  }

  for (const [name, percentile] of PERCENTILES) result[name] = nearestRank(sorted, percentile)
  return result
}

/** Returns UTF-8 bytes for strings and physical bytes for binary views. */
export const byteLength = (payload) => {
  if (typeof payload === 'string') return Buffer.byteLength(payload, 'utf8')
  if (payload instanceof ArrayBuffer || payload instanceof SharedArrayBuffer) return payload.byteLength
  if (ArrayBuffer.isView(payload)) return payload.byteLength
  throw new TypeError('payload must be a string, ArrayBuffer, SharedArrayBuffer, or ArrayBuffer view')
}

/** Collects per-operation wire bytes without serializing or transforming payloads. */
export const collectOperationBytes = (payloads) => summarize(Array.from(payloads, byteLength))

/** Collects both total transferred bytes and the full per-operation distribution. */
export const collectTransferredBytes = (payloads) => {
  const perOp = collectOperationBytes(payloads)
  return { total: perOp.total, perOp }
}

/** Measures the supplied compacted snapshot representation. */
export const collectSnapshotBytes = (snapshot) => byteLength(snapshot)

/** Serializes ordered JSON records as canonical-key-order NDJSON with a trailing newline per record. */
export const serializeEvidenceNdjson = (records) =>
  Array.from(records, stableJsonStringify)
    .map((line) => `${line}\n`)
    .join('')

/** Writes a complete evidence artifact idempotently without replacing different bytes. */
export const writeEvidenceArtifact = async ({ path, records, compression }) => {
  if (typeof path !== 'string' || path.length === 0) throw new TypeError('path must be a non-empty string')
  if (compression !== undefined && compression !== 'gzip') {
    throw new TypeError('compression must be absent or "gzip"')
  }
  const orderedRecords = Array.from(records)
  const content = serializeEvidenceNdjson(orderedRecords)
  const storedBytes =
    compression === 'gzip' ? gzipSync(Buffer.from(content, 'utf8'), { mtime: 0 }) : Buffer.from(content, 'utf8')
  const reference = {
    _tag: 'external',
    path,
    hash: sha256(storedBytes),
    count: orderedRecords.length,
    encoding: 'ndjson',
    ...(compression === undefined ? {} : { compression }),
  }
  const stagingPath = `${path}.writing`
  let ownsStagingPath = false

  await mkdir(dirname(path), { recursive: true })
  const existingBytes = await readIfPresent(path)
  if (existingBytes !== undefined) {
    if (existingBytes.equals(storedBytes)) return reference
    throw artifactConflict(path)
  }

  try {
    await writeFile(stagingPath, storedBytes, { flag: 'wx' })
    ownsStagingPath = true
    /** A hard link exposes only the completed inode and fails rather than replacing an existing artifact. */
    await link(stagingPath, path)
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const racedBytes = await readIfPresent(path)
      if (racedBytes?.equals(storedBytes)) return reference
    }
    throw error
  } finally {
    if (ownsStagingPath) await unlink(stagingPath).catch(() => {})
  }

  return reference
}

/** Reads and verifies an external evidence artifact without mutating it. */
export const verifyEvidenceArtifact = async (reference) => {
  const errors = []
  if (reference === null || typeof reference !== 'object') {
    return { valid: false, errors: ['reference must be an object'] }
  }
  if (reference._tag !== 'external') errors.push('reference._tag must be "external"')
  if (reference.encoding !== 'ndjson') errors.push('reference.encoding must be "ndjson"')
  const compressionSupported = reference.compression === undefined || reference.compression === 'gzip'
  if (!compressionSupported) errors.push('reference.compression must be absent or "gzip"')
  if (typeof reference.path !== 'string' || reference.path.length === 0) {
    errors.push('reference.path must be a non-empty string')
  }
  if (typeof reference.hash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(reference.hash)) {
    errors.push('reference.hash must be a sha256:<hex> digest')
  }
  if (!Number.isInteger(reference.count) || reference.count < 0) {
    errors.push('reference.count must be a non-negative integer')
  }
  if (typeof reference.path !== 'string' || reference.path.length === 0) return { valid: false, errors }

  let storedBytes
  try {
    storedBytes = await readFile(reference.path)
  } catch (error) {
    errors.push(`artifact read failed: ${error.code ?? error.message}`)
    return { valid: false, errors }
  }

  const observedHash = sha256(storedBytes)
  if (observedHash !== reference.hash) {
    errors.push(`hash mismatch: expected ${reference.hash}, observed ${observedHash}`)
  }

  const observedBase = {
    hash: observedHash,
    count: null,
    encoding: 'ndjson',
    ...(reference.compression === undefined ? {} : { compression: reference.compression }),
  }
  if (!compressionSupported) return { valid: false, errors, observed: observedBase }

  let contentBytes
  try {
    contentBytes = reference.compression === 'gzip' ? gunzipSync(storedBytes) : storedBytes
  } catch (error) {
    errors.push(`gzip decompression failed: ${error.code ?? error.message}`)
    return { valid: false, errors, observed: observedBase }
  }

  const content = contentBytes.toString('utf8')
  const lines = content.length === 0 ? [] : content.split('\n')
  if (lines.at(-1) === '') lines.pop()
  else errors.push('NDJSON artifact must end each record with a newline')
  for (let index = 0; index < lines.length; index += 1) {
    try {
      JSON.parse(lines[index])
    } catch {
      errors.push(`invalid JSON at line ${index + 1}`)
    }
  }
  if (lines.length !== reference.count) {
    errors.push(`count mismatch: expected ${reference.count}, observed ${lines.length}`)
  }

  return {
    valid: errors.length === 0,
    errors,
    observed: { ...observedBase, count: lines.length },
  }
}

/** Runs warm-ups, then returns values and elapsed-time samples for measured iterations. */
export const measureRepeated = async (fn, { warmups = 1, iterations = 5 } = {}) => {
  assertFunction(fn, 'fn')
  assertCount(warmups, 'warmups', true)
  assertCount(iterations, 'iterations', false)

  for (let index = 0; index < warmups; index += 1) await fn(index, { measured: false })

  const values = []
  const elapsedSamples = []
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now()
    values.push(await fn(index, { measured: true }))
    elapsedSamples.push(performance.now() - startedAt)
  }

  return { values, elapsedMs: summarize(elapsedSamples) }
}

/**
 * Captures raw process memory before/after each run and distributions of deltas.
 * GC use is reported explicitly; absence of `--expose-gc` never invalidates a run.
 */
export const measureRetainedMemory = async ({
  allocate,
  release = async () => {},
  gc = true,
  warmups = 1,
  iterations = 5,
}) => {
  assertFunction(allocate, 'allocate')
  assertFunction(release, 'release')
  assertCount(warmups, 'warmups', true)
  assertCount(iterations, 'iterations', false)
  if (typeof gc !== 'boolean') throw new TypeError('gc must be a boolean')

  for (let index = 0; index < warmups; index += 1) {
    const retained = await allocate(index, { measured: false })
    await release(retained, index, { measured: false })
  }

  const gcAvailable = typeof globalThis.gc === 'function'
  const samples = []
  for (let index = 0; index < iterations; index += 1) {
    if (gc && gcAvailable) globalThis.gc()
    const before = captureMemory()
    const retained = await allocate(index, { measured: true })
    if (gc && gcAvailable) globalThis.gc()
    const after = captureMemory()
    const delta = subtractMemory(after, before)
    await release(retained, index, { measured: true })
    if (gc && gcAvailable) globalThis.gc()
    const afterRelease = captureMemory()
    samples.push({ before, after, delta, afterRelease })
  }

  return {
    gcAvailable,
    gcUsed: gc && gcAvailable,
    samples,
    rssDeltaBytes: summarizeValues(samples.map(({ delta }) => delta.rssBytes), true),
    heapUsedDeltaBytes: summarizeValues(samples.map(({ delta }) => delta.heapUsedBytes), true),
  }
}

/** Compares semantic canonical forms, never encoded snapshots or update bytes. */
export const checkConvergence = async (input) => {
  if (input === null || typeof input !== 'object' || !Object.hasOwn(input, 'expected')) {
    throw new TypeError('expected canonical oracle state is required')
  }
  const { states, canonicalize, expected } = input
  assertFunction(canonicalize, 'canonicalize')
  const canonicalStates = await Promise.all(Array.from(states, (state, index) => canonicalize(state, index)))
  if (canonicalStates.length === 0) {
    return {
      converged: true,
      oracleMatched: false,
      stateCount: 0,
      reference: null,
      expected,
      mismatchedIndices: [],
      oracleMismatchedIndices: [],
      mismatches: { peers: [], oracle: [] },
      canonicalStates,
    }
  }

  const reference = canonicalStates[0]
  const mismatchedIndices = []
  const oracleMismatchedIndices = []
  for (let index = 1; index < canonicalStates.length; index += 1) {
    if (!isDeepStrictEqual(reference, canonicalStates[index])) mismatchedIndices.push(index)
  }
  for (let index = 0; index < canonicalStates.length; index += 1) {
    if (!isDeepStrictEqual(expected, canonicalStates[index])) oracleMismatchedIndices.push(index)
  }
  return {
    converged: mismatchedIndices.length === 0,
    oracleMatched: oracleMismatchedIndices.length === 0,
    stateCount: canonicalStates.length,
    reference,
    expected,
    mismatchedIndices,
    oracleMismatchedIndices,
    mismatches: {
      peers: mismatchedIndices.map((index) => ({ index, expected: reference, actual: canonicalStates[index] })),
      oracle: oracleMismatchedIndices.map((index) => ({ index, expected, actual: canonicalStates[index] })),
    },
    canonicalStates,
  }
}

const nearestRank = (sorted, percentile) => sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)]

const captureMemory = () => {
  const memory = process.memoryUsage()
  return {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
  }
}

const subtractMemory = (after, before) =>
  Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - before[key]]))

const stableJsonStringify = (value) => stableJsonValue(value, new Set())

const stableJsonValue = (value, ancestors) => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('evidence records must contain only finite JSON numbers')
    return JSON.stringify(value)
  }
  if (typeof value !== 'object') throw new TypeError('evidence records must contain only JSON values')
  if (ancestors.has(value)) throw new TypeError('evidence records must not contain cycles')

  ancestors.add(value)
  try {
    if (Array.isArray(value)) return `[${value.map((item) => stableJsonValue(item, ancestors)).join(',')}]`
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('evidence records must contain only plain JSON objects')
    }
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJsonValue(value[key], ancestors)}`)
      .join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}

const sha256 = (content) => `sha256:${createHash('sha256').update(content).digest('hex')}`

const readIfPresent = async (path) => {
  try {
    return await readFile(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

const artifactConflict = (path) => {
  const error = new Error(`evidence artifact already exists with different bytes: ${path}`)
  error.code = 'EEXIST'
  return error
}

const assertFunction = (value, name) => {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`)
}

const assertCount = (value, name, allowZero) => {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new RangeError(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`)
  }
}
