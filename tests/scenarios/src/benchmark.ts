import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { writeArtifactCatalog } from './artifact-catalog-fs.ts'
import type { BenchmarkManifest } from './benchmark-model.ts'
import { withCoreSource } from './core-source.ts'
import { parseScenarioDurationMs } from './duration.ts'

const workspaceRoot = path.resolve(import.meta.dirname, '../../..')
export const parseBenchmarkOptions = (args: ReadonlyArray<string>) => {
  const values = new Map<string, string[]>()
  const allowed = [
    '--baseline',
    '--candidate',
    '--scenario',
    '--profile',
    '--samples',
    '--warmups',
    '--set',
    '--stabilization-timeout',
    '--sample-timeout',
  ]
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!
    const value = args[i + 1]
    if (!allowed.includes(flag) || value === undefined || value.startsWith('--'))
      throw new Error(`Invalid option: ${flag}. Use --help.`)
    const existing = values.get(flag) ?? []
    if (!['--scenario', '--profile', '--set'].includes(flag) && existing.length > 0)
      throw new Error(`Duplicate ${flag}`)
    values.set(flag, [...existing, value])
  }
  const required = (key: string) => {
    const value = values.get(key)?.[0]
    if (!value) throw new Error(`Required: ${key}`)
    return value
  }
  const count = (key: string, fallback: number, min: number) => {
    const value = Number(values.get(key)?.[0] ?? fallback)
    if (!Number.isSafeInteger(value) || value < min || value > 1000)
      throw new Error(`${key} must be an integer between ${min} and 1000`)
    return value
  }
  const profiles = [...new Set(values.get('--profile') ?? ['browser'])]
  if (profiles.some((p) => !['browser', 'process', 'in-process'].includes(p)))
    throw new Error('Profiles: browser, process, in-process')
  const scenarios = [
    ...new Set(
      values.get('--scenario') ?? ['offline-writer-recovery', 'pending-tail-recovery', 'many-writer-convergence'],
    ),
  ]
  const parameters = values.get('--set') ?? []
  if (parameters.some((p) => !/^\w+=.+$/.test(p))) throw new Error('--set requires name=value')
  return {
    baseline: required('--baseline'),
    candidate: required('--candidate'),
    profiles,
    scenarios,
    parameters,
    samples: count('--samples', 10, 1),
    warmups: count('--warmups', 1, 0),
    stabilizationTimeout: values.get('--stabilization-timeout')?.[0],
    sampleTimeoutMs: parseScenarioDurationMs(values.get('--sample-timeout')?.[0] ?? '15m'),
  }
}

const hash = (content: string | Buffer) => createHash('sha256').update(content).digest('hex')
const harnessHash = async () => {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'tests/scenarios/src'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .sort()
  const digest = createHash('sha256')
  for (const file of files) {
    digest.update(file)
    try {
      digest.update(await fs.readFile(path.join(workspaceRoot, file)))
    } catch {
      digest.update('<deleted>')
    }
  }
  return digest.digest('hex')
}

export const runBenchmark = async (args: ReadonlyArray<string>): Promise<boolean> => {
  const options = parseBenchmarkOptions(args)
  // Resolve mutable branch names once, before any measured run.
  const pin = async (ref: string) =>
    withCoreSource({
      workspaceRoot,
      selection: { _tag: 'ref', ref },
      run: async (core) => core.sourceRevision.replace(/^livestore@/, ''),
    })
  const baseline = await pin(options.baseline)
  const candidate = await pin(options.candidate)
  if (baseline === candidate) throw new Error('Baseline and candidate resolve to the same commit')
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
  const artifactRoot = path.join(workspaceRoot, 'tests/scenarios/artifacts')
  const directory = path.join(artifactRoot, 'benchmarks', id)
  await fs.mkdir(directory, { recursive: true })
  const manifest: BenchmarkManifest = {
    version: 1,
    id,
    startedAt: new Date().toISOString(),
    status: 'running',
    baseline: `livestore@${baseline}`,
    candidate: `livestore@${candidate}`,
    environment: {
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
      cpu: os.cpus()[0]?.model ?? 'unknown',
      release: os.release(),
      lockHash: hash(await fs.readFile(path.join(workspaceRoot, 'pnpm-lock.yaml'))),
      harnessHash: await harnessHash(),
    },
    samples: [],
  }
  const save = async () => {
    const destination = path.join(directory, 'manifest.json')
    await fs.writeFile(destination + '.tmp', JSON.stringify(manifest, null, 2) + '\n')
    await fs.rename(destination + '.tmp', destination)
  }
  let interrupted = false
  let timedOut = false
  let child: ReturnType<typeof spawn> | undefined
  const stop = () => {
    interrupted = true
    child?.kill('SIGINT')
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try {
    await save()
    for (const scenario of options.scenarios)
      for (const profile of options.profiles) {
        for (const phase of ['warmup', 'measured'] as const)
          for (let iteration = 1; iteration <= (phase === 'warmup' ? options.warmups : options.samples); iteration++) {
            // AB / BA ordering reduces drift bias while keeping source projection serial.
            const roles =
              iteration % 2 === 1 ? (['baseline', 'candidate'] as const) : (['candidate', 'baseline'] as const)
            for (const role of roles) {
              if (interrupted) throw new Error('Benchmark interrupted')
              const file = `${manifest.samples.length.toString().padStart(4, '0')}-${role}.json`
              const output = path.join(directory, file)
              console.log(`${phase} ${iteration}: ${role} · ${scenario} · ${profile}`)
              const runSample = () =>
                withCoreSource({
                  workspaceRoot,
                  selection: { _tag: 'ref', ref: role === 'baseline' ? baseline : candidate },
                  run: async (core) =>
                    new Promise<number>((resolve, reject) => {
                      child = spawn(
                        process.execPath,
                        [
                          '--import',
                          import.meta.resolve('tsx'),
                          path.join(import.meta.dirname, 'cli.ts'),
                          '--scenario',
                          scenario,
                          '--profile',
                          profile,
                          ...options.parameters.flatMap((value) => ['--set', value]),
                          ...(options.stabilizationTimeout === undefined
                            ? []
                            : ['--stabilization-timeout', options.stabilizationTimeout]),
                          '--output',
                          output,
                        ],
                        {
                          cwd: path.join(workspaceRoot, 'tests/scenarios'),
                          env: {
                            ...process.env,
                            LIVESTORE_SCENARIO_CORE_PATH: core.path,
                            LIVESTORE_SCENARIO_SOURCE_REVISION: core.sourceRevision,
                          },
                          stdio: 'inherit',
                        },
                      )
                      // A sample that never finishes would stall the campaign silently. Stop it; the loop below
                      // retries it once and fails the campaign if it stalls again.
                      const sampleTimer = setTimeout(() => {
                        timedOut = true
                        child?.kill('SIGINT')
                        setTimeout(() => child?.kill('SIGKILL'), 20_000).unref()
                      }, options.sampleTimeoutMs)
                      child.once('error', reject)
                      child.once('exit', (code) => {
                        clearTimeout(sampleTimer)
                        child = undefined
                        resolve(code ?? 1)
                      })
                    }),
                })
              let attempts = 0
              let exitCode = 1
              while (true) {
                attempts += 1
                timedOut = false
                exitCode = await runSample()
                if (interrupted) throw new Error('Benchmark interrupted')
                if (timedOut === false) break
                const message = `Sample ${file} did not finish within ${options.sampleTimeoutMs / 1000} s and was stopped`
                // Rare stalls happened before a run printed anything; one retry keeps them from ending a campaign,
                // while a run that stalls twice points at a real problem.
                if (attempts >= 2) throw new Error(`${message} twice`)
                console.log(`${message}; retrying once`)
                await fs.rm(output, { force: true })
              }
              const artifact = JSON.parse(await fs.readFile(output, 'utf8'))
              if (
                !['passed', 'failed'].includes(artifact.status) ||
                artifact.descriptor?.sourceRevision !== manifest[role] ||
                (exitCode !== 0 && artifact.status !== 'failed')
              )
                throw new Error(`Invalid run artifact: ${file}`)
              manifest.samples.push({
                role,
                phase,
                iteration,
                scenario,
                profile,
                file,
                exitCode,
                ...(attempts > 1 ? { attempts } : {}),
              })
              await save()
            }
          }
      }
    if (
      (await harnessHash()) !== manifest.environment.harnessHash ||
      hash(await fs.readFile(path.join(workspaceRoot, 'pnpm-lock.yaml'))) !== manifest.environment.lockHash
    )
      throw new Error('Harness or dependencies changed during the campaign; results are not a controlled comparison')
    manifest.status = 'complete'
  } catch (cause) {
    manifest.status = 'interrupted'
    manifest.error = String(cause)
    throw cause
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    await save()
    await writeArtifactCatalog(artifactRoot)
    console.log(`Benchmark ${manifest.status}: ${path.join(directory, 'manifest.json')}`)
  }
  return manifest.samples.filter((sample) => sample.phase === 'measured').every((sample) => sample.exitCode === 0)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help'))
    console.log(`Usage: pnpm benchmark --baseline <ref> --candidate <ref>
  --scenario <id>     Repeat to select scenarios (default: offline, pending-tail, many-writer)
  --profile <profile> Repeat to select profiles (default: browser)
  --samples <n>       Measured runs per target/case (default: 10)
  --warmups <n>       Cache warmup runs per target/case (default: 1)
  --set <name=value>  Scenario parameter; applies to all selected cases
  --stabilization-timeout <duration>  Passed to every run (default: the CLI's 60s)
  --sample-timeout <duration>  Stops a run that takes longer and fails the campaign (default: 15m)
Results: artifacts/benchmarks/<campaign>/manifest.json and immutable run artifacts.
Warmups use fresh clients, prime host caches, and are excluded from statistics.
Correctness failures are retained and exit nonzero; no performance regression threshold is enforced.`)
  else
    await runBenchmark(process.argv.slice(2))
      .then((passed) => {
        if (!passed) process.exitCode = 1
      })
      .catch((cause) => {
        console.error(cause)
        process.exitCode = 1
      })
}
