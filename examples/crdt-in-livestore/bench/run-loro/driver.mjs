#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { verifyEvidenceArtifact } from '../harness/src/metrics.mjs'

const RUN_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_RUNNER = join(RUN_DIR, 'cell-runner.mjs')
const DEFAULT_MANIFEST = join(RUN_DIR, 'manifest.json')
const DEFAULT_LIVESTORE_CWD = RUN_DIR
const DEFAULT_TIMEOUT_MS = 300_000
const MAX_DISK_BYTES = 100 * 1024 * 1024
const DISK_SAFETY_RESERVE_BYTES = 2 * 1024 * 1024
const DISK_LAUNCH_LIMIT_BYTES = MAX_DISK_BYTES - DISK_SAFETY_RESERVE_BYTES
const DISK_POLL_INTERVAL_MS = 1_000
const LOG_TAIL_BYTES = 16 * 1024
const DISCLAIMER =
  'Generated matrix concurrency uses conflict-free, actor-owned lanes for transport, size, speed, and memory measurement. It does not measure shared-region conflict behavior; adversarial shared-region correctness is covered by the conformance suite.'
const HARNESS_INPUTS = ['model.mjs', 'trace.mjs', 'oracle.mjs', 'conformance.mjs', 'metrics.mjs', 'results.mjs'].map((name) =>
  join(RUN_DIR, '..', 'harness', 'src', name),
)

const DOCUMENT_SIZES = [2_048, 20_480, 204_800]
const EDIT_COUNTS = [1_000, 10_000, 100_000]
const CONCURRENCY_LEVELS = [2, 3, 8]
const MATRIX = DOCUMENT_SIZES.flatMap((docSizeBytes) =>
  EDIT_COUNTS.flatMap((editCount) =>
    CONCURRENCY_LEVELS.map((concurrency) => ({
      id: `${docSizeBytes / 1024}kb-${editCount}edits-${concurrency}way`,
      docSizeBytes,
      editCount,
      concurrency,
      phase: docSizeBytes === 204_800 ? 'large' : docSizeBytes === 20_480 ? 'medium' : 'small',
    })),
  ),
)

const usage = `Usage: node --experimental-strip-types --expose-gc driver.mjs [options]

Runs the 27 Loro Phase-2 cells sequentially: all 2 KB and 20 KB cells first,
then all 200 KB cells. The one-cell runner contract is:

  cell-runner.mjs --doc-size-bytes N --edit-count N --concurrency N \\
    --seed STRING --output ABSOLUTE_PATH

Options:
  --runner PATH          One-cell runner (default: ${DEFAULT_RUNNER})
  --manifest PATH        Atomic manifest (default: ${DEFAULT_MANIFEST})
  --livestore-cwd PATH   Child cwd used for real LiveStore imports
  --node PATH            Node 24 executable (default: current process executable)
  --timeout-ms N         External per-cell wall cap (default: ${DEFAULT_TIMEOUT_MS})
  --seed-prefix STRING   Deterministic seed prefix (default: loro-p2)
  --retry-skipped        Retry prior timeout/failure/disk-budget skips
  --dry-run              Print ordered cells and exit without writing
  --help                 Show this help

Resume is automatic: completed cells are never rerun. Skipped cells remain
terminal unless --retry-skipped is supplied. Child results are written under
results/<cell-id>.json and referenced (not duplicated) by the manifest.

${DISCLAIMER}
`

const parseArgs = (argv) => {
  const options = {
    runner: DEFAULT_RUNNER,
    manifest: DEFAULT_MANIFEST,
    liveStoreCwd: DEFAULT_LIVESTORE_CWD,
    node: process.execPath,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    seedPrefix: 'loro-p2',
    retrySkipped: false,
    dryRun: false,
    help: false,
  }

  const takeValue = (index, flag) => {
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`)
    return value
  }

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    switch (flag) {
      case '--runner':
        options.runner = resolve(takeValue(index, flag))
        index += 1
        break
      case '--manifest':
        options.manifest = resolve(takeValue(index, flag))
        index += 1
        break
      case '--livestore-cwd':
        options.liveStoreCwd = resolve(takeValue(index, flag))
        index += 1
        break
      case '--node':
        options.node = takeValue(index, flag)
        index += 1
        break
      case '--timeout-ms':
        options.timeoutMs = Number(takeValue(index, flag))
        index += 1
        break
      case '--seed-prefix':
        options.seedPrefix = takeValue(index, flag)
        index += 1
        break
      case '--retry-skipped':
        options.retrySkipped = true
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        throw new Error(`Unknown option: ${flag}`)
    }
  }

  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive integer')
  }
  if (options.seedPrefix.length === 0) throw new Error('--seed-prefix must not be empty')
  return options
}

const pathExists = async (path) => {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

const directorySize = async (path) => {
  let total = 0
  const entries = await readdir(path, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return []
    throw error
  })
  for (const entry of entries) {
    const entryPath = join(path, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) total += await directorySize(entryPath)
    else if (entry.isFile()) {
      total += await lstat(entryPath)
        .then(({ size }) => size)
        .catch((error) => {
          if (error?.code === 'ENOENT') return 0
          throw error
        })
    }
  }
  return total
}

const sha256File = async (path) => {
  const bytes = await readFile(path)
  return { bytes: bytes.byteLength, sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }
}

const fingerprintImplementation = async (runner) => {
  const paths = [...new Set([fileURLToPath(import.meta.url), runner, join(RUN_DIR, 'runner.mjs'), join(RUN_DIR, 'loro-arm.mjs'), ...HARNESS_INPUTS])]
  const hash = createHash('sha256')
  const files = []
  for (const path of paths) {
    const bytes = await readFile(path)
    const fileHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    const identity = isAbsolute(path) ? path : resolve(path)
    hash.update(identity)
    hash.update('\0')
    hash.update(bytes)
    hash.update('\0')
    files.push({ path: identity, bytes: bytes.byteLength, sha256: fileHash })
  }
  return { sha256: `sha256:${hash.digest('hex')}`, files }
}

const writeJsonAtomic = async (path, value) => {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`)
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
  try {
    await rename(temporaryPath, path)
  } catch (error) {
    await rm(temporaryPath, { force: true })
    throw error
  }
}

const appendTail = (current, chunk) => {
  const next = Buffer.concat([current, chunk])
  return next.byteLength <= LOG_TAIL_BYTES ? next : next.subarray(next.byteLength - LOG_TAIL_BYTES)
}

const runChild = ({ node, runner, liveStoreCwd, timeoutMs, cell, outputPath, seed, budgetDirectory }) =>
  new Promise((resolveChild) => {
    const args = [
      '--experimental-strip-types',
      '--expose-gc',
      runner,
      '--doc-size-bytes',
      String(cell.docSizeBytes),
      '--edit-count',
      String(cell.editCount),
      '--concurrency',
      String(cell.concurrency),
      '--seed',
      seed,
      '--output',
      outputPath,
    ]
    const startedAt = new Date().toISOString()
    const startedMs = Date.now()
    let stdoutTail = Buffer.alloc(0)
    let stderrTail = Buffer.alloc(0)
    let timedOut = false
    let diskBudgetExceeded
    let diskMonitorError
    let diskCheckActive = false
    let settled = false

    const child = spawn(node, args, {
      cwd: liveStoreCwd,
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        LORO_BENCH_CELL_ID: cell.id,
        LORO_BENCH_CONCURRENCY_DISCLAIMER: DISCLAIMER,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk) => {
      stdoutTail = appendTail(stdoutTail, chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderrTail = appendTail(stderrTail, chunk)
    })

    const killTree = (signal) => {
      try {
        if (process.platform === 'win32') child.kill(signal)
        else process.kill(-child.pid, signal)
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error
      }
    }
    const timeout = setTimeout(() => {
      timedOut = true
      killTree('SIGKILL')
    }, timeoutMs)
    timeout.unref()
    const diskMonitor = setInterval(async () => {
      if (diskCheckActive || settled) return
      diskCheckActive = true
      try {
        const observedBytes = await directorySize(budgetDirectory)
        if (observedBytes >= DISK_LAUNCH_LIMIT_BYTES) {
          diskBudgetExceeded = observedBytes
          killTree('SIGKILL')
        }
      } catch (error) {
        diskMonitorError = error.message
        killTree('SIGKILL')
      } finally {
        diskCheckActive = false
      }
    }, DISK_POLL_INTERVAL_MS)
    diskMonitor.unref()

    const finish = (outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearInterval(diskMonitor)
      resolveChild({
        ...outcome,
        timedOut,
        diskBudgetExceeded,
        diskMonitorError,
        startedAt,
        finishedAt: new Date().toISOString(),
        wallTimeMs: Date.now() - startedMs,
        stdoutTail: stdoutTail.toString('utf8'),
        stderrTail: stderrTail.toString('utf8'),
      })
    }
    child.on('error', (error) => finish({ spawnError: error.message }))
    child.on('close', (exitCode, signal) => finish({ exitCode, signal }))
  })

const newManifest = (options) => ({
  schemaVersion: 1,
  benchmark: 'loro-embedding-tax-phase-2',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  disclaimer: DISCLAIMER,
  matrix: {
    documentSizesBytes: DOCUMENT_SIZES,
    editCounts: EDIT_COUNTS,
    concurrencyLevels: CONCURRENCY_LEVELS,
    order: ['small', 'medium', 'large'],
    cellCount: MATRIX.length,
  },
  execution: {
    runner: options.runner,
    implementationFingerprint: options.implementationFingerprint,
    node: options.node,
    nodeVersion: options.nodeVersion,
    nodeFlags: ['--experimental-strip-types', '--expose-gc'],
    liveStoreCwd: options.liveStoreCwd,
    timeoutMs: options.timeoutMs,
    seedPrefix: options.seedPrefix,
    maxDiskBytesExclusive: MAX_DISK_BYTES,
    diskSafetyReserveBytes: DISK_SAFETY_RESERVE_BYTES,
    diskPollIntervalMs: DISK_POLL_INTERVAL_MS,
    sequential: true,
  },
  records: [],
})

const assertResumeCompatible = (manifest, options) => {
  const expected = newManifest(options)
  const fields = [
    ['schemaVersion', manifest.schemaVersion, expected.schemaVersion],
    ['benchmark', manifest.benchmark, expected.benchmark],
    ['matrix', manifest.matrix, expected.matrix],
    ['execution.runner', manifest.execution?.runner, expected.execution.runner],
    ['execution.node', manifest.execution?.node, expected.execution.node],
    ['execution.nodeFlags', manifest.execution?.nodeFlags, expected.execution.nodeFlags],
    ['execution.liveStoreCwd', manifest.execution?.liveStoreCwd, expected.execution.liveStoreCwd],
    ['execution.timeoutMs', manifest.execution?.timeoutMs, expected.execution.timeoutMs],
    ['execution.seedPrefix', manifest.execution?.seedPrefix, expected.execution.seedPrefix],
    ['execution.nodeVersion', manifest.execution?.nodeVersion, expected.execution.nodeVersion],
    ['execution.implementationFingerprint', manifest.execution?.implementationFingerprint, expected.execution.implementationFingerprint],
  ]
  for (const [field, actual, wanted] of fields) {
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
      throw new Error(`Cannot resume: manifest ${field} differs (actual ${JSON.stringify(actual)}, expected ${JSON.stringify(wanted)})`)
    }
  }
  if (!Array.isArray(manifest.records)) throw new Error('Cannot resume: manifest records must be an array')
}

const loadManifest = async (options) => {
  if (!(await pathExists(options.manifest))) return newManifest(options)
  const manifest = JSON.parse(await readFile(options.manifest, 'utf8'))
  assertResumeCompatible(manifest, options)
  return manifest
}

const completedRecordIsValid = async (record) => {
  if (record.status !== 'completed') return false
  const { path, bytes, sha256 } = record.result ?? {}
  if (typeof path !== 'string' || !Number.isSafeInteger(bytes) || typeof sha256 !== 'string') return false
  try {
    const resultBytes = await readFile(path)
    const observed = {
      bytes: resultBytes.byteLength,
      sha256: `sha256:${createHash('sha256').update(resultBytes).digest('hex')}`,
    }
    if (observed.bytes !== bytes || observed.sha256 !== sha256) return false
    const document = JSON.parse(resultBytes.toString('utf8'))
    const wireEvidence = [
      document?.results?.standalone?.metrics?.wire?.perOp?.value?.evidence,
      document?.results?.embedded?.metrics?.wire?.perOp?.value?.evidence,
    ]
    if (wireEvidence.some((reference) => reference?._tag !== 'external')) return false
    const verifications = await Promise.all(wireEvidence.map((reference) => verifyEvidenceArtifact(reference)))
    return verifications.every(({ valid }) => valid)
  } catch {
    return false
  }
}

const pairedRunId = (cell, seed) =>
  `loro-${String(seed).replaceAll(/[^a-zA-Z0-9_.-]/g, '_')}-${cell.docSizeBytes}-${cell.editCount}-${cell.concurrency}`

const cleanupPartialCellArtifacts = async ({ cell, seed, outputPath }) => {
  const prefix = pairedRunId(cell, seed)
  await Promise.all([
    rm(outputPath, { force: true }),
    rm(join(dirname(outputPath), 'evidence', `${prefix}-standalone-deliveries.ndjson.gz`), { force: true }),
    rm(join(dirname(outputPath), 'evidence', `${prefix}-embedded-deliveries.ndjson.gz`), { force: true }),
  ])
}

const replaceRecord = (manifest, record) => {
  manifest.records = [...manifest.records.filter(({ cellId }) => cellId !== record.cellId), record].sort(
    (left, right) => MATRIX.findIndex(({ id }) => id === left.cellId) - MATRIX.findIndex(({ id }) => id === right.cellId),
  )
  manifest.updatedAt = new Date().toISOString()
}

const persistRecord = async (manifest, manifestPath, record) => {
  replaceRecord(manifest, record)
  await writeJsonAtomic(manifestPath, manifest)
}

const skipForDiskBudget = async ({ manifest, options, pendingCells, observedBytes }) => {
  const timestamp = new Date().toISOString()
  for (const cell of pendingCells) {
    await persistRecord(manifest, options.manifest, {
      cellId: cell.id,
      workload: cell,
      seed: `${options.seedPrefix}-${cell.id}`,
      status: 'skipped',
      reason: {
        _tag: 'disk-budget-exceeded',
        observedBytes,
        limitBytesExclusive: MAX_DISK_BYTES,
      },
      startedAt: timestamp,
      finishedAt: timestamp,
      wallTimeMs: 0,
    })
  }
}

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(usage)
    return
  }
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({ disclaimer: DISCLAIMER, cells: MATRIX }, null, 2)}\n`)
    return
  }

  if (!(await pathExists(options.runner))) throw new Error(`One-cell runner not found: ${options.runner}`)
  if (!(await pathExists(options.liveStoreCwd))) throw new Error(`LiveStore child cwd not found: ${options.liveStoreCwd}`)
  const nodeVersion = spawnSync(options.node, ['--version'], { encoding: 'utf8' })
  if (nodeVersion.status !== 0) throw new Error(`Could not execute Node at ${options.node}: ${nodeVersion.stderr || nodeVersion.error}`)
  const major = Number(/^v(\d+)/u.exec(nodeVersion.stdout.trim())?.[1])
  if (major !== 24) throw new Error(`Node 24 is required; ${options.node} reported ${nodeVersion.stdout.trim()}`)
  options.nodeVersion = nodeVersion.stdout.trim()
  options.implementationFingerprint = await fingerprintImplementation(options.runner)

  await mkdir(dirname(options.manifest), { recursive: true })
  const resultsDir = join(dirname(options.manifest), 'results')
  await mkdir(resultsDir, { recursive: true })
  const manifest = await loadManifest(options)
  const priorByCell = new Map(manifest.records.map((record) => [record.cellId, record]))
  const pendingCells = []
  for (const cell of MATRIX) {
    const prior = priorByCell.get(cell.id)
    if (prior === undefined || (options.retrySkipped && prior.status === 'skipped')) {
      pendingCells.push(cell)
    } else if (prior.status === 'completed' && !(await completedRecordIsValid(prior))) {
      process.stderr.write(`${cell.id}: completed manifest record has a missing or corrupt result; scheduling it again.\n`)
      pendingCells.push(cell)
    }
  }

  process.stdout.write(`${DISCLAIMER}\n`)
  process.stdout.write(`Pending ${pendingCells.length}/${MATRIX.length} cells; sequential timeout ${options.timeoutMs} ms.\n`)

  for (let index = 0; index < pendingCells.length; index += 1) {
    const cell = pendingCells[index]
    const diskBytesBefore = await directorySize(dirname(options.manifest))
    if (diskBytesBefore >= DISK_LAUNCH_LIMIT_BYTES) {
      process.stderr.write(
        `Disk launch limit reached before ${cell.id}: ${diskBytesBefore} >= ${DISK_LAUNCH_LIMIT_BYTES}; skipping remaining cells.\n`,
      )
      await skipForDiskBudget({ manifest, options, pendingCells: pendingCells.slice(index), observedBytes: diskBytesBefore })
      break
    }

    const seed = `${options.seedPrefix}-${cell.id}`
    const outputPath = join(resultsDir, `${cell.id}.json`)
    await rm(outputPath, { force: true })
    process.stdout.write(`[${index + 1}/${pendingCells.length}] ${cell.id}\n`)
    const outcome = await runChild({
      ...options,
      cell,
      outputPath,
      seed,
      budgetDirectory: dirname(options.manifest),
    })
    const common = {
      cellId: cell.id,
      workload: cell,
      seed,
      startedAt: outcome.startedAt,
      finishedAt: outcome.finishedAt,
      wallTimeMs: outcome.wallTimeMs,
    }

    if (outcome.diskBudgetExceeded !== undefined || outcome.diskMonitorError !== undefined) {
      await cleanupPartialCellArtifacts({ cell, seed, outputPath })
      await skipForDiskBudget({
        manifest,
        options,
        pendingCells: pendingCells.slice(index),
        observedBytes: outcome.diskBudgetExceeded ?? (await directorySize(dirname(options.manifest))),
      })
      process.stderr.write(
        outcome.diskMonitorError === undefined
          ? `${cell.id}: killed at the disk launch limit; cleaned its partial artifacts and skipped remaining cells.\n`
          : `${cell.id}: disk monitor failed (${outcome.diskMonitorError}); killed the cell and skipped remaining cells.\n`,
      )
      break
    }

    if (outcome.timedOut) {
      await cleanupPartialCellArtifacts({ cell, seed, outputPath })
      await persistRecord(manifest, options.manifest, {
        ...common,
        status: 'skipped',
        reason: { _tag: 'timeout', timeoutMs: options.timeoutMs },
        process: { exitCode: outcome.exitCode ?? null, signal: outcome.signal ?? null },
        stdoutTail: outcome.stdoutTail,
        stderrTail: outcome.stderrTail,
      })
      process.stderr.write(`${cell.id}: skipped after external ${options.timeoutMs} ms timeout.\n`)
      continue
    }

    if (outcome.spawnError !== undefined || outcome.exitCode !== 0) {
      await cleanupPartialCellArtifacts({ cell, seed, outputPath })
      await persistRecord(manifest, options.manifest, {
        ...common,
        status: 'skipped',
        reason: { _tag: 'runner-failure', message: outcome.spawnError ?? `exit code ${outcome.exitCode}` },
        process: { exitCode: outcome.exitCode ?? null, signal: outcome.signal ?? null },
        stdoutTail: outcome.stdoutTail,
        stderrTail: outcome.stderrTail,
      })
      process.stderr.write(`${cell.id}: skipped because the runner failed.\n`)
      continue
    }

    try {
      const result = JSON.parse(await readFile(outputPath, 'utf8'))
      if (result === null || typeof result !== 'object' || Array.isArray(result)) throw new Error('top-level JSON must be an object')
      const digest = await sha256File(outputPath)
      const diskBytesAfter = await directorySize(dirname(options.manifest))
      if (diskBytesAfter >= DISK_LAUNCH_LIMIT_BYTES) {
        await cleanupPartialCellArtifacts({ cell, seed, outputPath })
        await skipForDiskBudget({
          manifest,
          options,
          pendingCells: pendingCells.slice(index),
          observedBytes: diskBytesAfter,
        })
        process.stderr.write(
          `${cell.id}: result reached the disk launch limit (${diskBytesAfter} >= ${DISK_LAUNCH_LIMIT_BYTES}); removed it and skipped remaining cells.\n`,
        )
        break
      }
      await persistRecord(manifest, options.manifest, {
        ...common,
        status: 'completed',
        result: {
          path: isAbsolute(outputPath) ? outputPath : resolve(outputPath),
          ...digest,
        },
        diskBytesAfter,
      })
      process.stdout.write(`${cell.id}: completed (${digest.bytes} result bytes; ${diskBytesAfter} run bytes).\n`)
    } catch (error) {
      await cleanupPartialCellArtifacts({ cell, seed, outputPath })
      await persistRecord(manifest, options.manifest, {
        ...common,
        status: 'skipped',
        reason: { _tag: 'invalid-or-missing-result', message: error.message },
        process: { exitCode: outcome.exitCode ?? null, signal: outcome.signal ?? null },
        stdoutTail: outcome.stdoutTail,
        stderrTail: outcome.stderrTail,
      })
      process.stderr.write(`${cell.id}: skipped because its result was missing or invalid JSON.\n`)
    }
  }

  const counts = manifest.records.reduce((accumulator, { status }) => {
    accumulator[status] = (accumulator[status] ?? 0) + 1
    return accumulator
  }, {})
  process.stdout.write(`Manifest: ${options.manifest}\nRecords: ${JSON.stringify(counts)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`)
  process.exitCode = 1
})
