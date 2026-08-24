import { describe, it } from '@effect/vitest'
import { Effect, Layer, Schema } from 'effect'
import { RpcTest } from 'effect/unstable/rpc'
import { expect } from 'vitest'

import { BotControl, BotControlOperationNames } from '../control/contract.ts'
import { ControlAuthorizationRejected, ControlResult } from '../control/schema.ts'
import { CliExit, type CliIo } from './model.ts'
import { CliOperationNames, decodeMessageUrl, parseCli } from './parse.ts'
import { runCli } from './run.ts'

const messageUrl = 'https://discord.com/channels/10000000000000001/10000000000000002/10000000000000003'
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))
const result = Schema.decodeUnknownSync(ControlResult)({
  _tag: 'Success',
  summary: 'operation completed',
  correlationId: 'correlation-1',
  receiptId: 'receipt-1',
})

const makeFixture = () => {
  const calls: string[] = []
  const succeed = (operation: string) =>
    Effect.sync(() => {
      calls.push(operation)
      return result
    })
  const handlers = BotControl.toLayer(
    BotControl.of({
      ThreadInspect: () => succeed('ThreadInspect'),
      ThreadPlan: () => succeed('ThreadPlan'),
      ThreadCreate: () => succeed('ThreadCreate'),
      ThreadStatus: () => succeed('ThreadStatus'),
      ThreadReconcile: () => succeed('ThreadReconcile'),
      ThreadPolicyExplain: () => succeed('ThreadPolicyExplain'),
      DocsQuery: () => succeed('DocsQuery'),
      DocsStatus: () => succeed('DocsStatus'),
      RuntimeHealth: () => succeed('RuntimeHealth'),
      RuntimeStatus: () => succeed('RuntimeStatus'),
      ConfigValidate: () => succeed('ConfigValidate'),
      EffectiveConfig: () => succeed('EffectiveConfig'),
      AuthStatus: () => succeed('AuthStatus'),
      ApplicationCommandsDiff: () => succeed('ApplicationCommandsDiff'),
      ApplicationCommandsSync: () => succeed('ApplicationCommandsSync'),
      StagingE2ERun: () => succeed('StagingE2ERun'),
    }),
  )
  const stdout: string[] = []
  const stderr: string[] = []
  const io: CliIo = {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    isTTY: false,
  }
  return { calls, handlers, io, stderr, stdout }
}

describe('livestore-discord control CLI', () => {
  it('keeps the CLI and RPC operation sets symmetric', () => {
    expect([...CliOperationNames].sort()).toEqual([...BotControlOperationNames].sort())
  })

  it('maps every public command family to its declared operation', () => {
    const readRef = [messageUrl] as const
    const writeGuard = ['--environment', 'staging', '--apply', '--reason', 'operator triage'] as const
    const cases = [
      ['ThreadInspect', ['thread', 'inspect', ...readRef]],
      ['ThreadPlan', ['thread', 'plan', ...readRef]],
      ['ThreadCreate', ['thread', 'create', ...readRef, ...writeGuard]],
      ['ThreadStatus', ['thread', 'status', ...readRef]],
      ['ThreadReconcile', ['thread', 'reconcile', ...readRef, '--reason', 'operator triage']],
      ['ThreadPolicyExplain', ['policy', 'explain', ...readRef]],
      ['DocsQuery', ['docs', 'query', 'How does sync work?']],
      ['DocsStatus', ['docs', 'status']],
      ['RuntimeHealth', ['runtime', 'health']],
      ['RuntimeStatus', ['runtime', 'status']],
      ['ConfigValidate', ['config', 'validate']],
      ['EffectiveConfig', ['config', 'show']],
      ['AuthStatus', ['auth', 'status']],
      ['ApplicationCommandsDiff', ['commands', 'diff']],
      ['ApplicationCommandsSync', ['commands', 'sync', ...writeGuard]],
      ['StagingE2ERun', ['e2e', 'run', ...writeGuard, '--confirm-live-write']],
    ] as const

    expect(
      cases.map(([expected, args]) => {
        const parsed = parseCli(args)
        return parsed._tag === 'Invocation' ? [expected, parsed.invocation.operation] : [expected, parsed._tag]
      }),
    ).toEqual(cases.map(([expected]) => [expected, expected]))
  })

  it('decodes canonical Discord message URLs and rejects impostor origins', () => {
    expect(decodeMessageUrl(messageUrl)).toEqual({
      guildId: '10000000000000001',
      channelId: '10000000000000002',
      messageId: '10000000000000003',
    })
    expect(() =>
      decodeMessageUrl('https://discord.invalid/channels/10000000000000001/10000000000000002/10000000000000003'),
    ).toThrow()
  })

  it.effect('executes a read through the schema-derived in-process RPC client', () => {
    const fixture = makeFixture()
    return Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(BotControl)
      const exit = yield* runCli(['thread', 'inspect', messageUrl, '--output', 'json'], client, fixture.io)
      expect(exit).toBe(CliExit.Success)
      expect(fixture.calls).toEqual(['ThreadInspect'])
      expect(decodeJson(fixture.stdout[0] ?? '')).toEqual({
        _tag: 'Success',
        summary: 'operation completed',
        correlationId: 'correlation-1',
        receiptId: 'receipt-1',
      })
      expect(fixture.stderr).toEqual([])
    }).pipe(Effect.provide(fixture.handlers), Effect.scoped)
  })

  it.effect('refuses writes without apply, environment, and reason before transport', () => {
    const fixture = makeFixture()
    return Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(BotControl)
      expect(yield* runCli(['thread', 'create', messageUrl, '--reason', 'triage'], client, fixture.io)).toBe(
        CliExit.Usage,
      )
      expect(yield* runCli(['thread', 'create', messageUrl, '--apply', '--reason', 'triage'], client, fixture.io)).toBe(
        CliExit.Usage,
      )
      expect(
        yield* runCli(['thread', 'create', messageUrl, '--apply', '--environment', 'staging'], client, fixture.io),
      ).toBe(CliExit.Usage)
      expect(fixture.calls).toEqual([])
      expect(fixture.stderr.every((line) => line.startsWith('CRITICAL usage:') || line.startsWith('Usage:'))).toBe(true)
    }).pipe(Effect.provide(fixture.handlers), Effect.scoped)
  })

  it.effect('allows only the explicitly confirmed staging live E2E write', () => {
    const fixture = makeFixture()
    return Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(BotControl)
      const base = ['e2e', 'run', '--apply', '--reason', 'staging tracer bullet'] as const
      expect(yield* runCli([...base, '--environment', 'production', '--confirm-live-write'], client, fixture.io)).toBe(
        CliExit.Usage,
      )
      expect(yield* runCli([...base, '--environment', 'staging'], client, fixture.io)).toBe(CliExit.Usage)
      expect(yield* runCli([...base, '--environment', 'staging', '--confirm-live-write'], client, fixture.io)).toBe(
        CliExit.Success,
      )
      expect(fixture.calls).toEqual(['StagingE2ERun'])
    }).pipe(Effect.provide(fixture.handlers), Effect.scoped)
  })

  it.effect('maps typed authorization rejection to exit 3 and machine stdout', () => {
    const fixture = makeFixture()
    const rejectionLayer = Layer.mergeAll(
      fixture.handlers,
      BotControl.toLayerHandler('ThreadInspect', () =>
        Effect.fail(new ControlAuthorizationRejected({ message: 'operator denied' })),
      ),
    )
    return Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(BotControl)
      const exit = yield* runCli(['thread', 'inspect', messageUrl, '--output', 'json'], client, fixture.io)
      expect(exit).toBe(CliExit.Rejected)
      expect(decodeJson(fixture.stdout[0] ?? '')).toEqual({
        _tag: 'ControlAuthorizationRejected',
        message: 'operator denied',
      })
    }).pipe(Effect.provide(rejectionLayer), Effect.scoped)
  })
})
