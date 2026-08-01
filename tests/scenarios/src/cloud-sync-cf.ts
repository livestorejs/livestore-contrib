import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import type { CloudSyncCfScenarioBackendOptions } from './backends.ts'

const workspaceDirectory = path.resolve(import.meta.dirname, '..')
const wranglerConfigPath = path.join(import.meta.dirname, 'backends', 'sync-cf', 'wrangler.toml')
const wranglerBin = path.join(workspaceDirectory, 'node_modules', '.bin', 'wrangler')
const managedStatePath = path.join(workspaceDirectory, '.wrangler', 'scenario-cloud.json')
const defaultWorkerName = 'livestore-contrib-scenarios'

interface ManagedCloudState extends CloudSyncCfScenarioBackendOptions {
  readonly workerName: string
}

interface CloudHealth {
  readonly service: 'livestore-scenario-sync-cf'
  readonly backendRevision: string
  readonly tokenFingerprint: string | null
}

export const ensureCloudSyncCf = async (args: {
  readonly backendRevision: string
  readonly forceDeploy?: boolean
}): Promise<CloudSyncCfScenarioBackendOptions> => {
  const attachedUrl = process.env.SCENARIO_CLOUD_SYNC_URL
  if (attachedUrl !== undefined) {
    const token = process.env.SCENARIO_CLOUD_SYNC_TOKEN
    if (token === undefined || token.length === 0) {
      throw new Error('SCENARIO_CLOUD_SYNC_TOKEN is required with SCENARIO_CLOUD_SYNC_URL')
    }
    const url = normalizeCloudUrl(attachedUrl)
    const health = await readCloudHealth(url)
    if (health.tokenFingerprint !== makeTokenFingerprint(token)) {
      throw new Error(`SCENARIO_CLOUD_SYNC_TOKEN does not match the Worker at ${url}`)
    }
    return { url, token, backendRevision: health.backendRevision }
  }

  const deploymentRevision = await makeDeploymentRevision(args.backendRevision)
  if (process.env.CLOUDFLARE_API_TOKEN !== undefined && process.env.CLOUDFLARE_ACCOUNT_ID === undefined) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID is required when CLOUDFLARE_API_TOKEN is set')
  }

  const workerName = process.env.SCENARIO_CLOUD_WORKER_NAME ?? defaultWorkerName
  const cached = await readManagedState()
  if (
    args.forceDeploy !== true &&
    cached?.workerName === workerName &&
    cached.backendRevision === deploymentRevision &&
    (await healthMatches(cached.url, deploymentRevision, cached.token))
  ) {
    console.log(`Cloud sync-cf ready: ${cached.url} (${compactRevision(cached.backendRevision)})`)
    return cached
  }

  await assertWranglerAvailable()
  const token =
    process.env.SCENARIO_CLOUD_SYNC_TOKEN ??
    (cached?.workerName === workerName ? cached.token : randomBytes(32).toString('base64url'))
  console.log(`Deploying cloud sync-cf Worker '${workerName}' for ${compactRevision(deploymentRevision)}...`)
  const deploy = await runWrangler([
    'deploy',
    '--config',
    wranglerConfigPath,
    '--name',
    workerName,
    '--var',
    `SCENARIO_BACKEND_REVISION:${deploymentRevision}`,
  ])
  const url = normalizeCloudUrl(findDeployedUrl(deploy.output) ?? cached?.url ?? '')

  await runWrangler(
    ['secret', 'put', 'SCENARIO_SYNC_TOKEN', '--config', wranglerConfigPath, '--name', workerName],
    token,
  )
  await waitForHealth(url, deploymentRevision, token)

  const state = { url, token, backendRevision: deploymentRevision, workerName } satisfies ManagedCloudState
  await writeManagedState(state)
  console.log(`Cloud sync-cf deployed: ${url}`)
  return state
}

const assertWranglerAvailable = async (): Promise<void> => {
  try {
    await fs.access(wranglerBin)
  } catch {
    throw new Error('Wrangler is not installed for tests/scenarios; run the repository pnpm install task')
  }
  await runWrangler(['whoami'], undefined, false)
}

const runWrangler = async (
  args: ReadonlyArray<string>,
  stdin?: string,
  showOutput = true,
): Promise<{ readonly output: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(wranglerBin, args, {
      cwd: workspaceDirectory,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let output = ''
    const collect = (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      output += text
      if (showOutput === true) process.stdout.write(text)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve({ output })
      else reject(new Error(`Wrangler exited with code ${code ?? 'unknown'}\n${output}`))
    })
    child.stdin.end(stdin === undefined ? undefined : `${stdin}\n`)
  })

const findDeployedUrl = (output: string): string | undefined =>
  output.match(/https:\/\/[a-zA-Z0-9.-]+\.workers\.dev\b/)?.[0]

const readCloudHealth = async (url: string): Promise<CloudHealth> => {
  const response = await fetch(new URL('/__scenario/health', url), { signal: AbortSignal.timeout(10_000) })
  if (response.ok === false) throw new Error(`Cloud sync-cf health failed (${response.status})`)
  const input = (await response.json()) as Partial<CloudHealth>
  if (
    input.service !== 'livestore-scenario-sync-cf' ||
    typeof input.backendRevision !== 'string' ||
    (typeof input.tokenFingerprint !== 'string' && input.tokenFingerprint !== null)
  ) {
    throw new Error(`Unexpected cloud sync-cf health response from ${url}`)
  }
  return input as CloudHealth
}

const healthMatches = async (url: string, expectedRevision: string, token: string): Promise<boolean> => {
  try {
    const health = await readCloudHealth(url)
    return health.backendRevision === expectedRevision && health.tokenFingerprint === makeTokenFingerprint(token)
  } catch {
    return false
  }
}

const waitForHealth = async (url: string, expectedRevision: string, token: string): Promise<void> => {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await healthMatches(url, expectedRevision, token)) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Cloud sync-cf did not report revision ${expectedRevision} at ${url}`)
}

const normalizeCloudUrl = (input: string): string => {
  if (input.length === 0) throw new Error('Wrangler did not report a deployed workers.dev URL')
  const url = new URL(input)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Cloud sync-cf URL must use HTTP(S): ${input}`)
  }
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

const readManagedState = async (): Promise<ManagedCloudState | undefined> => {
  try {
    const input = JSON.parse(await fs.readFile(managedStatePath, 'utf8')) as Partial<ManagedCloudState>
    if (
      typeof input.url !== 'string' ||
      typeof input.token !== 'string' ||
      typeof input.backendRevision !== 'string' ||
      typeof input.workerName !== 'string'
    ) {
      return undefined
    }
    return input as ManagedCloudState
  } catch {
    return undefined
  }
}

const writeManagedState = async (state: ManagedCloudState): Promise<void> => {
  await fs.mkdir(path.dirname(managedStatePath), { recursive: true })
  await fs.writeFile(managedStatePath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await fs.chmod(managedStatePath, 0o600)
}

const compactRevision = (revision: string): string => (revision.length > 20 ? `${revision.slice(0, 20)}…` : revision)

const makeTokenFingerprint = (token: string): string => createHash('sha256').update(token).digest('hex').slice(0, 16)

const makeDeploymentRevision = async (sourceRevision: string): Promise<string> => {
  const workerHash = createHash('sha256')
  for (const file of [wranglerConfigPath, path.join(import.meta.dirname, 'backends', 'sync-cf', 'worker.ts')]) {
    workerHash.update(await fs.readFile(file))
  }
  return `${sourceRevision}+scenario-${workerHash.digest('hex').slice(0, 12)}`
}
