import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { docsUnavailableMessages } from '../../src/docs/render.ts'
import { docsNotConfiguredMessage, threadPermissionDeniedMessage } from '../../src/runtime/handlers.ts'
import type { AttendedBrokerDriver, GestureEvidence } from './attended-broker.ts'

// Observed in the official Discord web client on 2026-09-26. The message
// toolbar appears after clicking the message article; no hover is required.
export const gestureLocators = {
  composer: {
    locator: { kind: 'css', selector: '[role="textbox"][aria-label^="Message #"]' },
    calibrated: '2026-09-26',
  },
  messageRow: {
    selector: 'li[id^="chat-messages-"]',
    calibrated: '2026-09-26',
  },
  moreButton: { locator: { kind: 'role', role: 'button', name: 'More' }, calibrated: '2026-09-26' },
  apps: { locator: { kind: 'role', role: 'menuitem', name: 'Apps' }, calibrated: '2026-09-26' },
  app: {
    locator: { kind: 'role', role: 'menuitem', name: 'LiveStore Auto Threads Staging' },
    calibrated: '2026-09-26',
  },
  createThread: {
    locator: {
      kind: 'within',
      scope: {
        kind: 'css',
        selector: '[role="menu"][aria-activedescendant^="message-actions-apps--"]:not(:has([role="menu"]))',
      },
      target: { kind: 'role', role: 'menuitem', name: 'Create Thread' },
    },
    calibrated: '2026-09-26',
  },
} as const

type Locator =
  | { readonly kind: 'role'; readonly role: string; readonly name: string }
  | { readonly kind: 'css'; readonly selector: string }
  | { readonly kind: 'within'; readonly scope: Locator; readonly target: Locator }

type BrowserOperation =
  | { readonly kind: 'navigate'; readonly url: string; readonly intent: string; readonly effect: 'read' }
  | { readonly kind: 'wait'; readonly locator: Locator; readonly state: 'visible'; readonly timeoutMs: number }
  | { readonly kind: 'click'; readonly locator: Locator; readonly intent: string; readonly effect: 'read' | 'write' }
  | {
      readonly kind: 'press'
      readonly locator: Locator
      readonly key: 'Enter'
      readonly intent: string
      readonly effect: 'write'
    }
  | {
      readonly kind: 'fill' | 'type'
      readonly locator: Locator
      readonly valueSource: 'stdin'
      readonly intent: string
      readonly effect: 'write'
    }
  | { readonly kind: 'snapshot' }
  | { readonly kind: 'locate'; readonly locator: Locator }

/** Only fill/type carries a value, out of the request file and into stdin. */
export type BrowserControlStep = { readonly operation: BrowserOperation; readonly stdinValue?: string }

export interface HttpCaptureDriverInput {
  readonly maintainerSessionId?: string
  readonly memberSessionId?: string
}
export class CaptureGestureFailure extends Error {
  readonly operation: BrowserOperation['kind']
  readonly exitCode: number | undefined
  readonly step: number | undefined
  /** HTTP Capture's fixed browser-control error code, e.g. `browser_unavailable`. */
  readonly code: string | undefined

  constructor(operation: BrowserOperation['kind'], exitCode: number | undefined, step?: number, code?: string) {
    super(`Capture ${operation} failed`)
    this.operation = operation
    this.exitCode = exitCode
    this.step = step
    this.code = code
  }
}

/**
 * HTTP Capture fences each browser step to one document generation and answers
 * `browser_unavailable` when Discord's SPA replaces the document mid-step (it
 * does so after a navigation, and slower under host load). Re-running a
 * read-only step against the settled document is correct; write steps are
 * never retried because their effect may already have landed.
 */
export const runReadStepAcrossDocumentReplacement = async <A>(
  step: BrowserControlStep,
  run: () => Promise<A>,
  maxAttempts = 3,
): Promise<A> => {
  const readOnly =
    step.operation.kind === 'snapshot' ||
    step.operation.kind === 'locate' ||
    step.operation.kind === 'wait' ||
    (step.operation.kind === 'navigate' && step.operation.effect === 'read')
  for (let attempt = 1; ; attempt++) {
    try {
      return await run()
    } catch (error) {
      if (
        readOnly === false ||
        attempt >= maxAttempts ||
        !(error instanceof CaptureGestureFailure) ||
        error.code !== 'browser_unavailable'
      )
        throw error
    }
  }
}

const composer = gestureLocators.composer.locator
const markedRow = (marker: string): Locator => ({
  kind: 'css',
  selector: `${gestureLocators.messageRow.selector}:has-text(${JSON.stringify(marker)})`,
})
const withinRow = (marker: string, target: Locator): Locator => ({ kind: 'within', scope: markedRow(marker), target })
const channelUrl = (guildId: string, channelId: string) => `https://discord.com/channels/${guildId}/${channelId}`
const navigate = (guildId: string, channelId: string): BrowserControlStep => ({
  operation: {
    kind: 'navigate',
    url: channelUrl(guildId, channelId),
    intent: 'Open selected staging channel',
    effect: 'read',
  },
})
const click = (locator: Locator, intent: string, effect: 'read' | 'write' = 'read'): BrowserControlStep => ({
  operation: { kind: 'click', locator, intent, effect },
})
const fill = (locator: Locator, value: string): BrowserControlStep => ({
  operation: { kind: 'fill', locator, valueSource: 'stdin', intent: 'Enter attended staging gesture', effect: 'write' },
  stdinValue: value,
})
const send = (locator: Locator): BrowserControlStep => ({
  operation: { kind: 'press', locator, key: 'Enter', intent: 'Submit attended staging gesture', effect: 'write' },
})
const ready = (locator: Locator): BrowserControlStep => ({
  operation: { kind: 'wait', locator, state: 'visible', timeoutMs: 15_000 },
})

export const buildCreateMessageSteps = (input: {
  readonly guildId: string
  readonly channelId: string
  readonly content: string
}): ReadonlyArray<BrowserControlStep> => [
  navigate(input.guildId, input.channelId),
  ready(composer),
  fill(composer, input.content),
  send(composer),
]

export const buildDocsCommandSteps = (input: {
  readonly guildId: string
  readonly channelId: string
  readonly query: string
}): ReadonlyArray<BrowserControlStep> => [
  navigate(input.guildId, input.channelId),
  ready(composer),
  // One fill of the full invocation: Discord parses it into the command with its `query`
  // option (calibrated 2026-09-27). Choosing the listbox option and then entering text
  // cancels the command, because capture text entry replaces the composer content.
  fill(composer, `/docs query:${input.query}`),
  send(composer),
]

export const buildMessageActionSteps = (input: {
  readonly guildId: string
  readonly channelId: string
  readonly sourceMarkerText: string
}): ReadonlyArray<BrowserControlStep> => [
  navigate(input.guildId, input.channelId),
  ready(markedRow(input.sourceMarkerText)),
  click(markedRow(input.sourceMarkerText), 'Reveal marked message actions'),
  click(withinRow(input.sourceMarkerText, gestureLocators.moreButton.locator), 'Open marked message menu'),
  click(gestureLocators.apps.locator, 'Open Apps submenu'),
  click(gestureLocators.app.locator, 'Open LiveStore Auto Threads Staging commands'),
  click(gestureLocators.createThread.locator, 'Invoke Create Thread action', 'write'),
]

/** Only the fixed `error.code` token leaves the CLI output; messages may quote page evidence. */
const captureErrorCode = (stdout: string): string | undefined => {
  try {
    const decoded: unknown = JSON.parse(stdout)
    if (typeof decoded !== 'object' || decoded === null || !('error' in decoded)) return undefined
    const error = decoded.error
    if (typeof error !== 'object' || error === null || !('code' in error) || typeof error.code !== 'string')
      return undefined
    return /^[a-z_]{1,64}$/u.test(error.code) === true ? error.code : undefined
  } catch {
    return undefined
  }
}

const runBrowserStep = (sessionId: string, step: BrowserControlStep, stepIndex?: number): Promise<unknown> =>
  runReadStepAcrossDocumentReplacement(step, () => runBrowserStepOnce(sessionId, step, stepIndex))

const runBrowserStepOnce = async (
  sessionId: string,
  step: BrowserControlStep,
  stepIndex?: number,
): Promise<unknown> => {
  const directory = await mkdtemp(join(tmpdir(), 'discord-e2e-capture-'))
  const requestFile = join(directory, 'request.json')
  try {
    await writeFile(requestFile, JSON.stringify(step.operation), { mode: 0o600 })
    const { promise, resolve, reject } = Promise.withResolvers<unknown>()
    const child = spawn('http-capture', ['browser', step.operation.kind, sessionId, '--request', requestFile], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.resume() // never display private page evidence or fill values
    child.on('error', () => reject(new CaptureGestureFailure(step.operation.kind, undefined, stepIndex)))
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new CaptureGestureFailure(step.operation.kind, code ?? undefined, stepIndex, captureErrorCode(stdout)))
        return
      }
      try {
        const result: unknown = JSON.parse(stdout)
        if (typeof result !== 'object' || result === null || !('ok' in result) || result.ok !== true) {
          reject(new CaptureGestureFailure(step.operation.kind, 0, stepIndex, captureErrorCode(stdout)))
        } else resolve(result)
      } catch {
        reject(new CaptureGestureFailure(step.operation.kind, 0, stepIndex))
      }
    })
    // v2 reads only fill/type values from stdin. Do not log either stream.
    child.stdin.end(step.stdinValue)
    return await promise
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

type MessageRow = { readonly text: string }

/**
 * Interaction replies are deferred (a "thinking" row that is later edited), so read the
 * history until a new app-authored row has settled or the deadline passes. Reading once
 * can classify the placeholder, which shows the source preview but not the outcome.
 */
export const settledAppReplies = async (
  readMessages: () => Promise<ReadonlyArray<MessageRow>>,
  before: ReadonlyArray<MessageRow>,
  options: { readonly timeoutMs?: number; readonly intervalMs?: number; readonly marker?: string } = {},
): Promise<ReadonlyArray<MessageRow>> => {
  const deadline = Date.now() + (options.timeoutMs ?? 90_000)
  for (;;) {
    const rows = await readMessages()
    const settled = rows
      .slice(before.length)
      .some(
        (row) =>
          (row.text.includes(gestureLocators.app.locator.name) ||
            (options.marker !== undefined && row.text.includes(options.marker))) &&
          /is thinking|sending command/iu.test(row.text) === false,
      )
    if (settled === true || Date.now() >= deadline) return rows
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 3_000))
  }
}

/** v2 command fetches health.control.epoch at invocation time and fences the envelope itself. */
export const makeHttpCaptureBrokerDriver = (input: HttpCaptureDriverInput = {}): AttendedBrokerDriver => ({
  perform: async ({ operation, request }): Promise<GestureEvidence> => {
    const identity =
      operation === 'invoke-docs' &&
      typeof request === 'object' &&
      request !== null &&
      'persona' in request &&
      request.persona === 'member' &&
      'location' in request &&
      request.location === 'restricted'
        ? 'member'
        : 'maintainer'
    const sessionId =
      identity === 'member'
        ? (process.env.LIVESTORE_DISCORD_E2E_CAPTURE_SESSION_MEMBER ?? input.memberSessionId)
        : (process.env.LIVESTORE_DISCORD_E2E_CAPTURE_SESSION_MAINTAINER ?? input.maintainerSessionId)
    if (
      sessionId === undefined ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(sessionId) === false
    )
      return { declined: true }
    if (typeof request !== 'object' || request === null || Array.isArray(request) === true)
      throw new Error('invalid gesture request')
    const record = request as Record<string, unknown>
    const required = (key: string): string => {
      const value = record[key]
      if (typeof value !== 'string' || value.length === 0) throw new Error(`gesture request missing ${key}`)
      return value
    }
    const guildId = required('guildId')
    const channelId = required('channelId')
    let steps: ReadonlyArray<BrowserControlStep>
    switch (operation) {
      case 'create-message':
        steps = buildCreateMessageSteps({ guildId, channelId, content: required('content') })
        break
      case 'invoke-docs':
        steps = buildDocsCommandSteps({ guildId, channelId, query: required('query') })
        break
      case 'invoke-message-action':
        steps = buildMessageActionSteps({ guildId, channelId, sourceMarkerText: required('marker') })
        break
      default:
        throw new Error(`unknown broker operation: ${operation}`)
    }
    // The accessibility snapshot exposes message text and worker-assigned action refs,
    // not Discord's DOM message IDs. Never treat refs as IDs or persist raw page text.
    const readSnapshot = async (): Promise<string> => {
      const response = await runBrowserStep(sessionId, { operation: { kind: 'snapshot' } })
      if (
        typeof response !== 'object' ||
        response === null ||
        !('result' in response) ||
        typeof response.result !== 'object' ||
        response.result === null ||
        !('kind' in response.result) ||
        response.result.kind !== 'snapshot' ||
        !('ariaYaml' in response.result) ||
        typeof response.result.ariaYaml !== 'string'
      )
        throw new CaptureGestureFailure('snapshot', 0)
      return response.result.ariaYaml
    }
    const readMessages = async (): Promise<ReadonlyArray<MessageRow>> => parseMessageRows(await readSnapshot())
    await runBrowserStep(sessionId, steps[0]!, 0)
    // Read the history only once the channel view has rendered its composer.
    await runBrowserStep(sessionId, ready(composer), 0)
    let beforeSnapshot = await readSnapshot()
    // Discord can put informational announcements over a channel on account switch.
    // The row remains locatable behind these dialogs, but cannot be clicked.
    if (
      beforeSnapshot.includes('heading "New in the Shop: Profile Frames"') === true ||
      beforeSnapshot.includes('heading "We’ve Launched Additional Protections for Teens"') === true
    ) {
      await runBrowserStep(
        sessionId,
        click({ kind: 'role', role: 'button', name: 'Close' }, 'Dismiss Discord announcement'),
      )
      beforeSnapshot = await readSnapshot()
    }
    // Posting a message needs no history: the correlator proves it over REST. Only interaction
    // replies (ephemeral, invisible to REST) are read from the page.
    if (operation === 'create-message') {
      for (let index = 1; index < steps.length; index++) await runBrowserStep(sessionId, steps[index]!, index)
      return {}
    }
    const before = parseMessageRows(beforeSnapshot)
    if (operation === 'invoke-message-action') {
      const sourceId = required('sourceMessageId')
      if (/^\d{17,20}$/u.test(sourceId) === false) throw new Error('invalid source message ID')
      try {
        await runBrowserStep(sessionId, {
          operation: {
            kind: 'locate',
            locator: {
              kind: 'css',
              selector: `${gestureLocators.messageRow.selector}[id$="-${sourceId}"]:has-text(${JSON.stringify(required('marker'))})`,
            },
          },
        })
      } catch (error) {
        if (error instanceof CaptureGestureFailure && error.code === 'locator_not_found') return { declined: true }
        throw error
      }
    }
    for (let index = 1; index < steps.length; index++) await runBrowserStep(sessionId, steps[index]!, index)
    const marker = required('marker')
    const after = await settledAppReplies(readMessages, before, operation === 'invoke-message-action' ? { marker } : {})
    const newResponses = newAppReplies(operation, before, after, marker)
    if (newResponses.length === 0) return { declined: true }
    const outcome = classifyReplies(
      operation,
      newResponses.map((item) => item.text),
    )
    return {
      ...outcome,
      ...(operation === 'invoke-docs' && outcome.docsOutcome === 'answered'
        ? { publicResponseCount: newResponses.length }
        : { ephemeralResponseCount: newResponses.length }),
    }
  },
})

/** New rows are identified by snapshot row order, not worker refs or inaccessible DOM IDs. */
export const newAppReplies = (
  operation: 'invoke-docs' | 'invoke-message-action',
  before: ReadonlyArray<MessageRow>,
  after: ReadonlyArray<MessageRow>,
  marker: string,
): ReadonlyArray<MessageRow> =>
  after
    .slice(before.length)
    .filter(
      (item) =>
        (operation === 'invoke-docs'
          ? item.text.includes(gestureLocators.app.locator.name) && item.text.includes(marker) === false
          : item.text.includes(gestureLocators.app.locator.name) || item.text.includes(marker)) &&
        /is thinking|sending command/iu.test(item.text) === false,
    )

/** Rows are accessibility listitems, not DOM IDs; preserve row boundaries and duplicates. */
export const parseMessageRows = (ariaYaml: string): ReadonlyArray<MessageRow> => {
  const rows: string[] = []
  let row: string[] = []
  let depth = -1
  for (const line of ariaYaml.split('\n')) {
    const indent = line.length - line.trimStart().length
    if (row.length > 0 && indent <= depth) {
      rows.push(row.join(' '))
      row = []
    }
    if (/^\s*- listitem(?:\s|:|$)/u.test(line) === true && row.length === 0) {
      depth = indent
      row = [line.trim()]
    } else if (row.length > 0) row.push(line.trim())
  }
  if (row.length > 0) rows.push(row.join(' '))
  return rows.map((text) => ({ text: text.replaceAll(/\s*\[ref=e\d+\]/gu, '') }))
}

/** Classifies bot replies by the bot's own user-facing texts; a non-answer never counts as answered. */
export const classifyReplies = (
  operation: 'invoke-docs' | 'invoke-message-action',
  texts: ReadonlyArray<string>,
): Pick<GestureEvidence, 'docsOutcome' | 'messageActionOutcome'> => {
  if (operation === 'invoke-message-action')
    return {
      messageActionOutcome:
        texts.some((text) => text.includes(threadPermissionDeniedMessage)) === true ? 'denied' : 'created',
    }
  if (texts.some((text) => text.includes(docsNotConfiguredMessage)) === true) return { docsOutcome: 'denied' }
  if (texts.some((text) => Object.values(docsUnavailableMessages).some((message) => text.includes(message))) === true)
    throw new Error('docs reply was an unavailable notice, not an answer')
  return { docsOutcome: 'answered' }
}
