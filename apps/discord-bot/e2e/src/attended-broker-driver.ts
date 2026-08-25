import { spawn } from 'node:child_process'

import type { AttendedBrokerDriver, GestureEvidence } from './attended-broker.ts'

/** One bounded semantic operation accepted by `http-capture browser <session>`. */
export interface BrowserControlStep {
  readonly operation: 'snapshot' | 'locate' | 'click' | 'fill' | 'press' | 'wait' | 'navigate'
  readonly [key: string]: unknown
}

export interface HttpCaptureDriverInput {
  /** http-capture session id for the attended official-client profile. */
  readonly sessionId?: string
  /** Input-control epoch of the session; changes on every takeover/handback. */
  readonly epoch?: string
}

interface BrowserStepOutput {
  readonly ok: boolean
  readonly text?: string
  readonly error?: string
}

/**
 * `http-capture browser` reads one JSON operation from stdin, so this cannot go
 * through execFile-style runners that have no stdin channel.
 */
const runBrowserStep = async (
  sessionId: string,
  epoch: string,
  step: BrowserControlStep,
): Promise<BrowserStepOutput> =>
  new Promise((resolve) => {
    const child = spawn('http-capture', ['browser', sessionId, '--epoch', epoch], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('close', (code) => {
      if (code !== 0) {
        resolve({ ok: false, error: `browser ${step.operation} failed: ${stderr.trim() || stdout.trim()}` })
        return
      }
      try {
        resolve(JSON.parse(stdout) as BrowserStepOutput)
      } catch {
        resolve({ ok: false, error: `browser ${step.operation} returned invalid JSON` })
      }
    })
    child.stdin.write(`${JSON.stringify(step)}\n`)
    child.stdin.end()
  })

const guildChannelUrl = (guildId: string, channelId: string): string =>
  `https://discord.com/channels/${guildId}/${channelId}`

export const buildCreateMessageSteps = (input: {
  readonly guildId: string
  readonly channelId: string
  readonly content: string
}): ReadonlyArray<BrowserControlStep> => [
  { operation: 'navigate', url: guildChannelUrl(input.guildId, input.channelId) },
  { operation: 'wait', locator: { kind: 'role', name: 'textbox' }, state: 'visible', timeoutMs: 15000 },
  { operation: 'fill', locator: { kind: 'role', name: 'textbox' }, value: input.content, timeoutMs: 10000 },
  { operation: 'press', locator: { kind: 'role', name: 'textbox' }, key: 'Enter', timeoutMs: 5000 },
]

export const buildDocsCommandSteps = (input: {
  readonly guildId: string
  readonly channelId: string
  readonly query: string
}): ReadonlyArray<BrowserControlStep> => [
  { operation: 'navigate', url: guildChannelUrl(input.guildId, input.channelId) },
  { operation: 'wait', locator: { kind: 'role', name: 'textbox' }, state: 'visible', timeoutMs: 15000 },
  { operation: 'fill', locator: { kind: 'role', name: 'textbox' }, value: `/docs ${input.query}`, timeoutMs: 10000 },
  { operation: 'press', locator: { kind: 'role', name: 'textbox' }, key: 'Enter', timeoutMs: 5000 },
]

export const buildMessageActionSteps = (input: {
  readonly guildId: string
  readonly channelId: string
  readonly sourceMarkerText: string
}): ReadonlyArray<BrowserControlStep> => [
  { operation: 'navigate', url: guildChannelUrl(input.guildId, input.channelId) },
  { operation: 'wait', locator: { kind: 'exact_text', value: input.sourceMarkerText }, state: 'visible', timeoutMs: 15000 },
  { operation: 'click', locator: { kind: 'row_scoped', anchor: { kind: 'exact_text', value: input.sourceMarkerText }, target: { kind: 'role', name: 'button' } }, timeoutMs: 5000 },
  // The context menu item label matches the registered application command.
  { operation: 'click', locator: { kind: 'role', name: 'Create Thread' }, timeoutMs: 5000 },
]

export const buildDeleteMessageSteps = (input: {
  readonly guildId: string
  readonly channelId: string
  readonly markerText: string
}): ReadonlyArray<BrowserControlStep> => [
  { operation: 'navigate', url: guildChannelUrl(input.guildId, input.channelId) },
  { operation: 'wait', locator: { kind: 'exact_text', value: input.markerText }, state: 'visible', timeoutMs: 15000 },
  { operation: 'click', locator: { kind: 'row_scoped', anchor: { kind: 'exact_text', value: input.markerText }, target: { kind: 'role', name: 'button' } }, timeoutMs: 5000 },
  { operation: 'click', locator: { kind: 'role', name: 'Delete Message' }, timeoutMs: 5000 },
]

const evidenceFromText = (text: string | undefined): GestureEvidence => {
  const lowered = (text ?? '').toLowerCase()
  if (
    lowered.includes('denied') === true || lowered.includes('not allowed') === true
  ) return { docsOutcome: 'denied', messageActionOutcome: 'denied' }
  if (lowered.length !== 0) return { docsOutcome: 'answered', messageActionOutcome: 'created' }
  return {}
}

/**
 * Drives the official Discord web client through the http-capture browser
 * control seam. Every gesture is a bounded step list; nothing here talks to a
 * user-token API. Locator labels are calibrated against the live client during
 * the attended Phase F window.
 */
export const makeHttpCaptureBrokerDriver = (input: HttpCaptureDriverInput = {}): AttendedBrokerDriver => {
  const perform = async ({
    operation,
    request,
  }: {
    readonly operation: string
    readonly request: unknown
  }): Promise<GestureEvidence> => {
    const sessionId = process.env.LIVESTORE_DISCORD_E2E_CAPTURE_SESSION ?? input.sessionId
    const epoch = process.env.LIVESTORE_DISCORD_E2E_CAPTURE_EPOCH ?? input.epoch
    if (sessionId === undefined || epoch === undefined) {
      throw new Error(
        'http-capture session is not configured; set LIVESTORE_DISCORD_E2E_CAPTURE_SESSION and _EPOCH after starting the attended capture',
      )
    }
    const record = request as Record<string, unknown>
    const guildId = String(record.guildId)
    const channelId = String(record.channelId)

    let steps: ReadonlyArray<BrowserControlStep>
    switch (operation) {
      case 'create-message':
        steps = buildCreateMessageSteps({ guildId, channelId, content: String(record.content) })
        break
      case 'invoke-docs':
        steps = buildDocsCommandSteps({ guildId, channelId, query: String(record.query ?? record.marker) })
        break
      case 'invoke-message-action':
        steps = buildMessageActionSteps({ guildId, channelId, sourceMarkerText: String(record.marker) })
        break
      case 'delete-message':
      case 'delete-response':
        steps = buildDeleteMessageSteps({ guildId, channelId, markerText: String(record.marker ?? record.id) })
        break
      default:
        throw new Error(`unknown broker operation: ${operation}`)
    }

    let lastText: string | undefined
    for (const step of steps) {
      const output = await runBrowserStep(sessionId, epoch, step)
      if (output.ok === false) throw new Error(output.error ?? 'browser step failed')
      if (typeof output.text === 'string') lastText = output.text
    }
    return evidenceFromText(lastText)
  }

  return { perform }
}
