import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

const appDirectory = resolve(import.meta.dirname, '../..')
const entrypoint = join(appDirectory, 'src/main.ts')
const installedExecutable = process.env.LIVESTORE_DISCORD_EXECUTABLE
const guildId = '100000000000000001'
const channelId = '100000000000000002'
const applicationId = '100000000000000010'
const firstMessageId = '100000000000000003'
const concurrentMessageId = '100000000000000004'
const reason = 'credential-free black-box verification'

type ControlResult = {
  readonly _tag: 'Success' | 'Planned' | 'AlreadySatisfied' | 'Unrun'
  readonly summary: string
  readonly correlationId?: string
  readonly receiptId?: string
}

type RunningChild = {
  readonly child: ChildProcess
  readonly exited: Promise<void>
  readonly output: () => { readonly stdout: string; readonly stderr: string }
}

const runningChildren = new Set<RunningChild>()

afterEach(async () => {
  await Promise.all([...runningChildren].map(stopChild))
})

describe('Discord bot source-executable black-box runtime', { timeout: 60_000 }, () => {
  it('crosses the source executable, health HTTP server, Unix control socket, CLI, and SQLite journal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'livestore-discord-black-box-'))
    let runtime: RunningChild | undefined
    try {
      const stateDirectory = join(root, 'state')
      const socketPath = join(root, 'control.sock')
      const configPath = join(root, 'runtime.json')
      await writeFile(configPath, `${JSON.stringify(makeConfig({ stateDirectory, socketPath }), undefined, 2)}\n`, {
        mode: 0o600,
      })

      runtime = startChild(['serve', '--config', configPath])
      const currentRuntime = () => {
        if (runtime === undefined) throw new Error('Runtime child was not started')
        return runtime
      }
      const runCli = (args: ReadonlyArray<string>) => cli(socketPath, args, currentRuntime())
      const healthPort = await waitForHealthPort(runtime)
      const ready = await waitUntilReady(healthPort, runtime)
      expect(ready).toMatchObject({
        apiVersion: 1,
        state: 'ready',
        ready: true,
        capabilities: { threading: true },
        restProbe: 'ok',
        gateway: { state: 'ready' },
      })
      expect((await stat(socketPath)).isSocket()).toBe(true)

      const source = messageUrl(firstMessageId)
      const planned = await runCli(['thread', 'plan', source, '--name', 'Black-box runtime'])
      expect(planned).toMatchObject({ _tag: 'Planned' })
      expect(planned.summary).toContain(`${channelId}/${firstMessageId}`)
      expect(journalRows(join(stateDirectory, 'thread-actions.sqlite'))).toEqual([])

      const created = await runCli(createArgs(source))
      expect(created).toMatchObject({ _tag: 'Success', correlationId: firstMessageId })
      expect(created.summary).toMatch(/^Created thread \d+\.$/)

      const status = await runCli(['thread', 'status', source])
      expect(status).toMatchObject({ _tag: 'Success' })
      expect(status.summary).toMatch(/^state=created thread=\d+ outcome=none$/)

      const duplicate = await runCli(createArgs(source))
      expect(duplicate).toMatchObject({ _tag: 'AlreadySatisfied', correlationId: firstMessageId })
      expect(duplicate.summary).toMatch(/^Thread \d+ already satisfies the request\.$/)

      const concurrentSource = messageUrl(concurrentMessageId)
      const barrier = await makeTwoClientBarrier(join(root, 'concurrent.sock'), socketPath)
      let concurrent: ReadonlyArray<ControlResult>
      try {
        concurrent = await Promise.all([
          cli(barrier.path, createArgs(concurrentSource), currentRuntime()),
          cli(barrier.path, createArgs(concurrentSource), currentRuntime()),
        ])
      } finally {
        await barrier.close()
      }
      expect(barrier.arrivals()).toBe(2)
      expect(concurrent.map((result) => result._tag).sort()).toEqual(['AlreadySatisfied', 'Success'])
      expect(new Set(concurrent.map((result) => threadId(result.summary))).size).toBe(1)
      expect(concurrent.every((result) => result.correlationId === concurrentMessageId)).toBe(true)

      const docs = await runCli(['docs', 'query', 'What is an event?'])
      expect(docs).toMatchObject({ _tag: 'Success' })
      expect(docs.summary).toContain('Fake source-backed answer')
      expect(docs.summary).toContain('https://docs.livestore.dev/overview')

      const docsStatus = await runCli(['docs', 'status'])
      expect(docsStatus.summary).toContain('readiness-admitted')

      const configValidation = await runCli(['config', 'validate', '--file', configPath])
      expect(configValidation.summary).toBe('Valid version 1 fake config for staging.')
      const effectiveConfig = await runCli(['config', 'show'])
      expect(JSON.parse(effectiveConfig.summary)).toMatchObject({
        apiVersion: 1,
        mode: 'fake',
        environment: 'staging',
        applicationId,
        parentChannelCount: 1,
        controlSocketPath: socketPath,
        health: { host: '127.0.0.1', port: 0 },
      })

      const runtimeHealth = await runCli(['runtime', 'health'])
      expect(runtimeHealth.summary).toBe(
        'state=ready ready=true authority=true journal=true gateway=ready rest=ok handlers=true docs=true',
      )
      const runtimeStatus = await runCli(['runtime', 'status'])
      expect(runtimeStatus.summary).toBe('environment=staging mode=fake state=ready')

      await stopChild(runtime)
      runtime = startChild(['serve', '--config', configPath])
      const restartedHealthPort = await waitForHealthPort(runtime)
      expect(await waitUntilReady(restartedHealthPort, runtime)).toMatchObject({ state: 'ready', ready: true })
      const persistedStatus = await runCli(['thread', 'status', source])
      expect(persistedStatus.summary).toBe(status.summary)
      const persistedDuplicate = await runCli(createArgs(source))
      expect(persistedDuplicate).toMatchObject({ _tag: 'AlreadySatisfied', correlationId: firstMessageId })

      const rows = journalRows(join(stateDirectory, 'thread-actions.sqlite'))
      expect(rows).toEqual([
        {
          source_message_id: firstMessageId,
          channel_id: channelId,
          state: 'created',
          trigger: 'operator',
          thread_id: threadId(created.summary),
        },
        {
          source_message_id: concurrentMessageId,
          channel_id: channelId,
          state: 'created',
          trigger: 'operator',
          thread_id: threadId(concurrent[0]!.summary),
        },
      ])

      // The config is a real on-disk runtime input. Fake mode has no credential
      // fields, and child processes receive an allowlisted environment below.
      const persistedConfig = await readFile(configPath, 'utf8')
      // Secret references are intentionally present; raw credential fields are not.
      expect(persistedConfig).not.toMatch(/"(?:discordToken|openAiApiKey|password|apiKey)"\s*:/i)
    } finally {
      if (runtime !== undefined) await stopChild(runtime)
      await rm(root, { recursive: true, force: true })
    }
  })
})

const makeConfig = ({
  stateDirectory,
  socketPath,
}: {
  readonly stateDirectory: string
  readonly socketPath: string
}) => ({
  apiVersion: 1,
  payload: {
    _tag: 'fake',
    environment: 'staging',
    applicationId,
    commandScope: { _tag: 'GuildCommandScope', applicationId, guildId },
    guildId,
    schemaVersion: 1,
    actionChannelIds: [channelId],
    aiTitleChannelIds: [],
    docsAudience: { publicChannelIds: [channelId], roleRestrictedChannelIds: [], contributorMaintainerRoleIds: [] },
    stagingOnlyChannelIds: [],
    botTokenSecretRef: 'op://vault/discord/bot-credential',
    openAi: {
      projectId: 'proj',
      serviceAccountSecretRef: 'op://vault/openai/key',
      retentionPosture: 'standard-store-false',
      limits: {
        requestsPerMemberPerHour: 10,
        requestsPerMinute: 2,
        inputTokensPerRequest: 40000,
        outputTokensPerRequest: 2000,
        monthlyCostUsdMicros: 1000000,
      },
    },
    releaseId: 'test-release',
    telemetry: {
      sink: 'dev3-tempo',
      delivery: 'best-effort',
      accessBoundary: 'tailnet-trusted-grafana',
      retentionDays: 30,
    },
    e2e: {
      actorApplicationId: '100000000000000011',
      actorTokenSecretRef: 'op://vault/discord/e2e',
      targetChannelId: channelId,
      requiredPurposeMarker: 'livestore-discord-e2e-only',
    },
    legacyCommands: ['!help'],
    stateDirectory,
    controlSocketPath: socketPath,
    health: { host: '127.0.0.1', port: 0 },
  },
})

const messageUrl = (messageId: string) => `https://discord.com/channels/${guildId}/${channelId}/${messageId}`

const createArgs = (source: string) => [
  'thread',
  'create',
  source,
  '--environment',
  'staging',
  '--apply',
  '--reason',
  reason,
  '--name',
  'Black-box runtime',
]

const cli = async (socketPath: string, args: ReadonlyArray<string>, runtime: RunningChild): Promise<ControlResult> => {
  const result = await runChild([...args, '--output', 'json'], {
    LIVESTORE_DISCORD_CONTROL_SOCKET: socketPath,
  })
  if (result.code !== 0) {
    throw new Error(
      `CLI ${args.slice(0, 2).join(' ')} exited ${result.code}: ${summarizeFailure(result)} runtime=${summarizeFailure(runtime.output())}`,
    )
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(result.stdout.trim())
  } catch {
    throw new Error(
      `CLI ${args.slice(0, 2).join(' ')} returned invalid JSON: ${summarizeFailure(result)} runtime=${summarizeFailure(runtime.output())}`,
    )
  }
  if (isControlResult(decoded) === false) {
    throw new Error(`CLI ${args.slice(0, 2).join(' ')} returned an invalid control result`)
  }
  return decoded
}

const isControlResult = (value: unknown): value is ControlResult => {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record._tag === 'string' && typeof record.summary === 'string'
}

const startChild = (args: ReadonlyArray<string>): RunningChild => {
  const child = spawnApplication(args, {
    cwd: appDirectory,
    env: childEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout!.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr!.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk
  })
  const exited = new Promise<void>((resolveExit) => child.once('close', () => resolveExit()))
  const running = { child, exited, output: () => ({ stdout, stderr }) }
  runningChildren.add(running)
  return running
}

const stopChild = async (running: RunningChild) => {
  if (runningChildren.has(running) === false) return
  if (running.child.exitCode !== null || running.child.signalCode !== null) {
    runningChildren.delete(running)
    await running.exited
    return
  }
  running.child.kill('SIGTERM')
  const exited = await Promise.race([
    running.exited.then(() => true),
    new Promise<false>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 3_000)),
  ])
  if (exited === false) {
    running.child.kill('SIGKILL')
    await running.exited
  }
  runningChildren.delete(running)
}

const waitUntilReady = async (port: number, runtime: RunningChild) => {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) {
      throw new Error(
        `Runtime exited before readiness with code=${runtime.child.exitCode} signal=${runtime.child.signalCode}: ${summarizeFailure(runtime.output())}`,
      )
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(500) })
      if (response.ok === true) return await response.json()
    } catch {
      // Connection refusal is expected while the child acquires its resources.
    }
    await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 25))
  }
  throw new Error(`Runtime did not become ready: ${summarizeFailure(runtime.output())}`)
}

const waitForHealthPort = async (runtime: RunningChild) => {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) {
      throw new Error(`Runtime exited before publishing its health port: ${summarizeFailure(runtime.output())}`)
    }
    const output = runtime.output()
    const match = /healthPort=(\d+)/.exec(`${output.stdout}\n${output.stderr}`)
    if (match?.[1] !== undefined) return Number(match[1])
    await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 25))
  }
  throw new Error(`Runtime did not publish its health port: ${summarizeFailure(runtime.output())}`)
}

const runChild = async (args: ReadonlyArray<string>, environment: Readonly<Record<string, string>>) =>
  await new Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }>(
    (resolveChild, rejectChild) => {
      const child = spawnApplication(args, {
        cwd: appDirectory,
        env: { ...childEnvironment(), ...environment },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout!.setEncoding('utf8').on('data', (chunk) => {
        stdout += chunk
      })
      child.stderr!.setEncoding('utf8').on('data', (chunk) => {
        stderr += chunk
      })
      const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000)
      child.once('error', (cause) => {
        clearTimeout(timeout)
        rejectChild(cause)
      })
      child.once('close', (code) => {
        clearTimeout(timeout)
        resolveChild({ code, stdout, stderr })
      })
    },
  )

/** Runs either the source entrypoint or an installed package executable. */
const spawnApplication = (args: ReadonlyArray<string>, options: SpawnOptions) =>
  installedExecutable === undefined
    ? spawn(process.execPath, ['--experimental-strip-types', entrypoint, ...args], options)
    : spawn(installedExecutable, args, options)

/** Prevents an ambient shell credential from silently entering fake mode. */
const childEnvironment = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  LANG: process.env.LANG,
  LC_ALL: process.env.LC_ALL,
  NODE_NO_WARNINGS: '1',
})

/** Holds both control connections until they have concurrently reached the process boundary. */
const makeTwoClientBarrier = async (path: string, upstreamPath: string) => {
  const clients: Array<{ readonly socket: Socket; data: string; ended: boolean }> = []
  const sockets = new Set<Socket>()
  let arrivals = 0
  const release = () => {
    if (clients.length !== 2 || clients.some((client) => client.ended === false) === true) return
    for (const admitted of clients) {
      const upstream = createConnection(upstreamPath)
      sockets.add(upstream)
      const deadline = setTimeout(() => upstream.destroy(new Error('Concurrent control forwarding timed out')), 5_000)
      upstream.setEncoding('utf8')
      upstream.on('data', (chunk) => admitted.socket.write(chunk))
      upstream.once('error', () => admitted.socket.destroy())
      upstream.once('close', () => {
        clearTimeout(deadline)
        sockets.delete(upstream)
      })
      upstream.once('end', () => admitted.socket.end())
      upstream.once('connect', () => upstream.end(admitted.data))
    }
  }
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    const admitted = { socket, data: '', ended: false }
    clients.push(admitted)
    sockets.add(socket)
    arrivals += 1
    socket.setEncoding('utf8')
    socket.once('error', () => undefined)
    socket.once('close', () => sockets.delete(socket))
    socket.on('data', (chunk) => {
      admitted.data += chunk
    })
    socket.once('end', () => {
      admitted.ended = true
      release()
    })
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(path, resolveListen)
  })
  return {
    path,
    arrivals: () => arrivals,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    },
  }
}

const journalRows = (path: string) => {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    return database
      .prepare(`
      SELECT source_message_id, channel_id, state, trigger, thread_id
      FROM thread_actions
      ORDER BY source_message_id
    `)
      .all()
  } finally {
    database.close()
  }
}

const threadId = (summary: string) => {
  const match = /(?:Created thread|Thread) (\d+)/.exec(summary)
  if (match?.[1] === undefined) throw new Error('CLI result did not contain an observable thread identifier')
  return match[1]
}

const summarizeFailure = ({ stdout, stderr }: { readonly stdout: string; readonly stderr: string }) =>
  `stdout=${truncate(stdout)} stderr=${truncate(stderr)}`

const truncate = (value: string) => JSON.stringify(value.trim().slice(0, 2_000))
