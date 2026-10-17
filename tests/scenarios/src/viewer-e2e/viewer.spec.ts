import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

import { expect, test, type Page } from '@playwright/test'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const failureArtifact = path.join(packageRoot, 'artifacts/sf-03-many-writer-426.json.gz')
const manyWriterArtifact = path.join(packageRoot, 'artifacts/sf-03-many-writer-426.json.gz')
const offlineArtifact = path.join(packageRoot, 'artifacts/reference-offline-writer-recovery-browser.json.gz')
const lifecycleArtifact = path.join(packageRoot, 'artifacts/reference-multi-session-recovery-browser.json.gz')
const denseArtifact = path.join(packageRoot, 'artifacts/reference-seeded-todo-actions-browser.json.gz')
const viewerUrl = 'http://127.0.0.1:4173'

test('saved runs support numeric sorting, combined filters, loading, and collapse', async ({ page }) => {
  const entries = [
    {
      file: path.basename(offlineArtifact),
      scenarioId: 'offline-writer-recovery',
      label: 'BRANCH · offline-writer-recovery',
      sourceRevision: 'livestore@' + 'a'.repeat(40),
      profile: 'browser',
      backend: 'local-sync-cf',
      applicationEventCount: 2,
      traceRecordCount: 100,
      status: 'passed',
    },
    {
      file: path.basename(manyWriterArtifact),
      scenarioId: 'many-writer-convergence',
      label: 'BASELINE · many-writer-convergence',
      sourceRevision: 'livestore@' + 'b'.repeat(40),
      profile: 'in-process',
      backend: 'mock',
      applicationEventCount: 100,
      traceRecordCount: 20,
      status: 'failed',
    },
    {
      file: path.basename(lifecycleArtifact),
      scenarioId: 'multi-session-recovery',
      label: 'BRANCH · multi-session-recovery',
      sourceRevision: 'livestore@' + 'a'.repeat(40),
      profile: 'browser',
      backend: 'local-sync-cf',
      applicationEventCount: 10,
      traceRecordCount: 3,
      status: 'passed',
    },
  ]
  await page.route('**/catalog.json', (route) => route.fulfill({ json: { version: 4, entries } }))
  await page.goto(viewerUrl)
  const table = page.getByRole('table', { name: 'Saved scenario runs' })
  await page.getByRole('button', { name: 'Events', exact: true }).click()
  await expect(table.locator('tbody tr td:nth-child(5)')).toHaveText(['2', '10', '100'])
  await page.getByRole('button', { name: 'Events', exact: true }).click()
  await expect(table.locator('tbody tr td:nth-child(5)')).toHaveText(['100', '10', '2'])
  await expect(page.getByRole('columnheader', { name: 'Events' })).toHaveAttribute('aria-sort', 'descending')
  await page.getByLabel('Filter target').selectOption(entries[0]!.sourceRevision)
  await page.getByLabel('Filter profile').selectOption('browser')
  await page.getByLabel('Filter result').selectOption('failed')
  await expect(page.getByText('No runs match these filters.')).toBeVisible()
  await page.getByLabel('Filter result').selectOption('passed')
  await page.getByRole('searchbox', { name: 'Search runs' }).fill('offline')
  await expect(table.locator('tbody tr')).toHaveCount(1)
  await table.getByRole('button', { name: 'offline-writer-recovery', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('offline-writer-recovery')
  await expect(table.getByRole('button', { name: 'offline-writer-recovery', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.getByRole('button', { name: /Saved runs/ }).click()
  await expect(table).toBeHidden()
  await page.getByRole('button', { name: /Saved runs/ }).click()
  await expect(table.locator('tbody tr')).toHaveCount(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('compares timing and correctness without treating failures as speedups', async ({ page }) => {
  const base = 'livestore@' + 'a'.repeat(40),
    candidate = 'livestore@' + 'b'.repeat(40)
  const common = {
    scenarioId: 'offline-writer-recovery',
    label: 'offline-writer-recovery',
    profile: 'browser',
    backend: 'local-sync-cf',
    comparisonKey: 'same-workload',
    applicationEventCount: 2,
    traceRecordCount: 100,
  }
  const entries = [
    {
      ...common,
      file: path.basename(offlineArtifact),
      sourceRevision: base,
      status: 'passed',
      timings: { runMs: 1000, workloadMs: 500 },
    },
    {
      ...common,
      file: 'candidate-pass.json',
      sourceRevision: candidate,
      status: 'passed',
      timings: { runMs: 800, workloadMs: 400 },
    },
    { ...common, file: 'candidate-fail.json', sourceRevision: candidate, status: 'failed', timings: {} },
  ]
  await page.route('**/catalog.json', (route) => route.fulfill({ json: { version: 4, entries } }))
  await page.goto(viewerUrl)
  await page.getByRole('button', { name: 'Time to pass', exact: true }).click()
  const runs = page.getByRole('table', { name: 'Saved scenario runs' })
  await expect(runs.locator('tbody tr td:last-child')).toHaveText(['800 ms', '1.00 s', '—'])
  await page.getByRole('button', { name: 'Compare', exact: true }).click()
  const comparison = page.getByRole('table', { name: 'Baseline and candidate comparison' })
  await expect(comparison).toContainText('Correctness failed')
  await expect(comparison).toContainText('1 / 2')
  await page.getByText('Choose individual runs', { exact: true }).click()
  await page.getByLabel('Candidate sample', { exact: true }).selectOption('candidate-pass.json')
  await expect(comparison).toContainText('-20.0%')
  await page.getByLabel('Candidate revision', { exact: true }).selectOption(base)
  await expect(page.getByText('Choose two different revisions to compare.')).toBeVisible()
  await page.getByLabel('Candidate revision', { exact: true }).selectOption(candidate)
  await page.getByLabel('Candidate sample', { exact: true }).selectOption('candidate-pass.json')
  await comparison.getByText('Runs', { exact: true }).click()
  await comparison.getByRole('button', { name: '1 · passed · 500 ms', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('offline-writer-recovery')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('loads failure artifacts and preserves comparison interactions', async ({ page }) => {
  await openArtifact(page, viewerUrl, failureArtifact, 'many-writer-convergence')
  await expect(page.getByRole('table', { name: 'Saved scenario runs' })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Target' })).toBeVisible()
  await openArtifact(page, viewerUrl, offlineArtifact, 'offline-writer-recovery')
  await applyComparisonState(page)
  await expect(page.getByText('Logical time')).toBeVisible()
  await expect(page.locator('svg.timeline-main')).toHaveAttribute('aria-valuenow', /\d+/)
})

test('loads the passed lifecycle reference artifact', async ({ page }) => {
  await openArtifact(page, viewerUrl, lifecycleArtifact, 'multi-session-recovery')
  await expect(page.getByLabel('System').locator('.section-heading .badge')).toHaveText('passed')
})

test('SF-03 keeps generated action traffic out of the sync-evidence geometry', async ({ page }) => {
  await openArtifact(page, viewerUrl, manyWriterArtifact, 'many-writer-convergence')
  const timeline = page.getByRole('region', { name: 'Timeline', exact: true })
  await expect(timeline.locator('.evidence-moment')).toHaveCount(11)
  await expect(timeline.locator('.moment-action')).toContainText('426 actions')
  await expect(timeline.locator('.moment-action-sequence')).toHaveCount(0)
})

test('Event color follows its producer through rebase and propagation', async ({ page }) => {
  await openArtifact(page, viewerUrl, offlineArtifact, 'offline-writer-recovery')
  const clientAEvents = page.locator('.event-chip[data-origin-client-id="client-a"]')
  await expect(clientAEvents).toHaveCount(3)

  const producerColor = await page
    .getByRole('heading', { name: 'client-a', level: 3 })
    .evaluate((element) => getComputedStyle(element).color)
  const eventColors = await clientAEvents.evaluateAll((elements) => [
    ...new Set(elements.map((element) => getComputedStyle(element).color)),
  ])
  expect(eventColors).toEqual([producerColor])

  await expect(page.getByRole('button', { name: 'e2r1', exact: true })).toHaveAttribute(
    'data-origin-client-id',
    'client-a',
  )
})

test('opens reconstructed Client Leader State with source-record provenance', async ({ page }) => {
  await openArtifact(page, viewerUrl, offlineArtifact, 'offline-writer-recovery')
  await page.getByRole('button', { name: 'open reconstructed State' }).first().click()

  const inspector = page.getByRole('article', { name: /client-a reconstructed Leader State/i })
  await expect(inspector).toHaveCSS('position', 'fixed')
  expect(
    await inspector
      .locator('.leader-state-status-bar > .badge')
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true)
  await expect(inspector.getByLabel('Reconstructed table', { exact: true })).toHaveValue('todos')
  await expect(inspector.getByText('replayed record #91')).toBeVisible()
  await expect(inspector.getByText(/capture offline-writer-recovery-browser-/)).toBeAttached()
  await expect(inspector.getByText('2 events')).toBeAttached()
  await expect(inspector.getByRole('region', { name: 'Reconstructed table todos' })).toBeVisible()
  await expect(inspector).toContainText('todo-offline')
  await expect(inspector).not.toContainText('historical')

  const resizeHandle = inspector.getByRole('separator', { name: 'Resize reconstructed State drawer' })
  const initialHeight = await inspector.evaluate((element) => element.getBoundingClientRect().height)
  const resizeHandleBounds = await resizeHandle.boundingBox()
  if (resizeHandleBounds === null) throw new Error('State drawer resize handle has no bounds')
  await page.mouse.move(
    resizeHandleBounds.x + resizeHandleBounds.width / 2,
    resizeHandleBounds.y + resizeHandleBounds.height / 2,
  )
  await page.mouse.down()
  await page.mouse.move(resizeHandleBounds.x + resizeHandleBounds.width / 2, resizeHandleBounds.y + 48, { steps: 4 })
  await page.mouse.up()
  await expect
    .poll(() => inspector.evaluate((element) => element.getBoundingClientRect().height))
    .toBeGreaterThan(initialHeight)

  await inspector.getByRole('button', { name: 'close' }).click()
  await expect(inspector).toBeHidden()
})

test('keeps dense reconstructed table rows scrollable inside the drawer', async ({ page }) => {
  await openArtifact(page, viewerUrl, denseArtifact, 'seeded-todo-actions')
  await page.getByRole('button', { name: 'open reconstructed State' }).first().click()

  const inspector = page.getByRole('article', { name: /client-a reconstructed Leader State/i })
  await expect(inspector.getByLabel('Reconstructed table', { exact: true })).toHaveValue('todos')
  const rows = inspector.getByRole('region', { name: 'Reconstructed table todos' }).locator('tbody tr')
  expect(await rows.count()).toBeGreaterThan(20)
  await expect
    .poll(() =>
      inspector
        .locator('.reconstructed-table-scroll')
        .evaluate((element) => element.scrollHeight > element.clientHeight),
    )
    .toBe(true)
})

test('shows reconstructed Leader materialization failures without partial tables', async ({ page }) => {
  const malformed = JSON.parse(gunzipSync(fs.readFileSync(offlineArtifact)).toString('utf8'))
  const sourceRecord = malformed.trace.findLast(
    (record: { clientId: string | null; payload: { _tag: string } }) =>
      record.clientId === 'client-a' && record.payload._tag === 'leader.sync.observed',
  )
  sourceRecord.payload.observation.events[0].args = { id: 'missing-required-text' }

  await page.goto(viewerUrl)
  await page.locator('input[type=file]').setInputFiles({
    name: 'malformed-leader-event.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(malformed)),
  })
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('offline-writer-recovery')
  await page.getByRole('button', { name: 'open reconstructed State' }).first().click()

  const inspector = page.getByRole('article', { name: /client-a reconstructed Leader State/i })
  await expect(inspector.getByText(/Materialization failed:/)).toBeVisible()
  await expect(inspector.getByText('error', { exact: true })).toBeVisible()
  await expect(inspector.getByRole('region', { name: /Reconstructed table/ })).toHaveCount(0)
})

test('playback, cursor, and range keyboard controls remain independent', async ({ page }) => {
  await openArtifact(page, viewerUrl, offlineArtifact, 'offline-writer-recovery')
  const cursor = page.locator('svg.timeline-main')
  const initialCursor = await cursor.getAttribute('aria-valuenow')
  await cursor.scrollIntoViewIfNeeded()
  await cursor.focus()
  await cursor.press('Home')
  await expect(cursor).not.toHaveAttribute('aria-valuenow', initialCursor ?? '')
  await cursor.press('ArrowRight')

  const range = page.locator('svg.range-navigator')
  await range.focus()
  await range.press('+')
  await expect(range.locator('.range-summary')).not.toHaveText('full run')
  await range.press('ArrowRight')
  await range.press('Escape')
  await expect(range.locator('.range-summary')).toHaveText('full run')

  await page.getByRole('button', { name: 'play', exact: true }).click()
  await expect(page.getByRole('button', { name: 'pause', exact: true })).toBeVisible()
  const firstPlaybackCursor = await cursor.getAttribute('aria-valuenow')
  await expect.poll(() => cursor.getAttribute('aria-valuenow')).not.toBe(firstPlaybackCursor)
  await page.getByRole('button', { name: 'pause', exact: true }).click()
  await expect(page.getByRole('button', { name: 'play', exact: true })).toBeVisible()
})

test('pointer scrubbing, range dragging, moment selection, and inspector persistence', async ({ page }) => {
  await openArtifact(page, viewerUrl, offlineArtifact, 'offline-writer-recovery')
  const cursor = page.locator('svg.timeline-main')
  const initialCursor = await cursor.getAttribute('aria-valuenow')
  const timelineBounds = await cursor.boundingBox()
  if (timelineBounds === null) throw new Error('Timeline has no bounds')
  await cursor.click({ position: { x: timelineBounds.width * 0.28, y: timelineBounds.height * 0.52 } })
  await expect(cursor).not.toHaveAttribute('aria-valuenow', initialCursor ?? '')

  const rangeHandleHit = page.locator('.range-handle.start .range-handle-hit')
  await rangeHandleHit.scrollIntoViewIfNeeded()
  const handleBounds = await rangeHandleHit.boundingBox()
  if (handleBounds === null) throw new Error('Range handle has no bounds')
  await page.mouse.move(handleBounds.x + handleBounds.width / 2, handleBounds.y + handleBounds.height / 2)
  await page.mouse.down()
  await page.mouse.move(handleBounds.x + 180, handleBounds.y + handleBounds.height / 2, { steps: 4 })
  await page.mouse.up()
  await expect(page.locator('.range-summary')).not.toHaveText('full run')

  await cursor.focus()
  await cursor.press('Home')
  for (let index = 0; index < 80 && (await page.locator('.moment-record').count()) < 2; index++) {
    await cursor.press('ArrowRight')
  }
  const representedRecords = page.locator('.moment-record')
  await expect(representedRecords).toHaveCount(await representedRecords.count())
  expect(await representedRecords.count()).toBeGreaterThan(1)
  const cursorBeforeDetailSelection = await cursor.getAttribute('aria-valuenow')
  await representedRecords.first().click()
  await expect(cursor).toHaveAttribute('aria-valuenow', cursorBeforeDetailSelection ?? '')
  await page.getByText('Trace metadata').click()
  await expect(page.getByText('Logical time')).toBeVisible()
  await representedRecords.last().click()
  await expect(page.getByText('Logical time')).toBeVisible()
})

test('malformed artifact loads do not lose the runnable shell', async ({ page }) => {
  await page.goto(viewerUrl)
  await page.locator('input[type=file]').setInputFiles({
    name: 'malformed.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"not":"an artifact"}'),
  })
  await expect(page.getByText('Load failed', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'scenario' })).toBeVisible()
})

test('event logs preserve manual scroll and follow new tail evidence', async ({ page }) => {
  await openArtifact(page, viewerUrl, denseArtifact, 'seeded-todo-actions')
  const overflowIndex = await page
    .locator('.eventlog')
    .evaluateAll((elements) => elements.findIndex((element) => element.scrollWidth > element.clientWidth))
  expect(overflowIndex).toBeGreaterThanOrEqual(0)
  const eventlog = page.locator('.eventlog').nth(overflowIndex)
  await eventlog.evaluate((element) => {
    element.scrollLeft = 0
    element.dispatchEvent(new Event('scroll', { bubbles: true }))
  })
  const cursor = page.locator('svg.timeline-main')
  await cursor.focus()
  await cursor.press('ArrowLeft')
  await expect.poll(() => eventlog.evaluate((element) => element.scrollLeft)).toBeLessThanOrEqual(2)

  await eventlog.evaluate((element) => {
    element.scrollLeft = element.scrollWidth - element.clientWidth
    element.dispatchEvent(new Event('scroll', { bubbles: true }))
  })
  await cursor.press('End')
  await expect
    .poll(() => eventlog.evaluate((element) => element.scrollWidth - element.clientWidth - element.scrollLeft))
    .toBeLessThanOrEqual(2)
})

test('Event tooltips show arguments in topology and timeline markers', async ({ page }) => {
  await openArtifact(page, viewerUrl, offlineArtifact, 'offline-writer-recovery')

  await expect(page.locator('[title]')).toHaveCount(0)
  await expect(page.locator('svg title')).toHaveCount(0)

  const eventChip = page.locator('.event-chip').first()
  await eventChip.hover()
  const topologyTooltip = page.getByRole('tooltip')
  await expect(topologyTooltip).toBeVisible()
  await expect(topologyTooltip.getByText('Todo created')).toBeVisible()
  await expect(topologyTooltip.getByText('id', { exact: true })).toBeVisible()
  await expect(topologyTooltip).not.toContainText('inferred correlation')
  await expect(topologyTooltip).not.toContainText('observed change in capture')

  await page.mouse.move(0, 0)
  await expect(topologyTooltip).toBeHidden()

  const timelineEvent = page.locator('svg.timeline-main [data-event-ref]').first()
  await timelineEvent.hover()
  const timelineTooltip = page.getByRole('tooltip')
  await expect(timelineTooltip).toBeVisible()
  await expect(timelineTooltip.getByText('Todo created')).toBeVisible()

  await page.mouse.move(0, 0)
  await eventChip.focus()
  await expect(page.getByRole('tooltip')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('tooltip')).toBeHidden()
})

test('shared tooltips cover trace labels and non-event timeline annotations', async ({ page }) => {
  await openArtifact(page, viewerUrl, offlineArtifact, 'offline-writer-recovery')

  const traceName = page.locator('.trace-name')
  await traceName.focus()
  await expect(page.getByRole('tooltip')).toContainText('offline-writer-recovery')
  await page.keyboard.press('Escape')

  const timelineAnnotation = page.locator('svg.timeline-main [data-timeline-tooltip-id]:not([data-event-ref])').first()
  await timelineAnnotation.hover()
  await expect(page.getByRole('tooltip')).toBeVisible()

  await page.mouse.move(0, 0)
  const rangeAnnotation = page.locator('svg.range-navigator [data-range-action="window"]')
  await rangeAnnotation.hover()
  await expect(page.getByRole('tooltip')).toBeVisible()
})

const openArtifact = async (page: Page, url: string, artifactPath: string, scenarioId: string): Promise<void> => {
  await page.goto(url)
  await page.locator('input[type=file]').setInputFiles(artifactPath)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(scenarioId)
  await expect(page.getByText(/^LiveStore source /)).toBeVisible()
  await expect(page.locator('svg.timeline-main')).toBeVisible()
}

const applyComparisonState = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'time', exact: true }).click()
  await page.getByRole('button', { name: 'raw', exact: true }).click()
  await page.getByRole('button', { name: 'raw trace', exact: true }).click()
  await page.getByRole('button', { name: 'records', exact: true }).click()

  // Select correlation while the final projection still contains the event chips; selection survives cursor movement.
  await page.locator('.event-chip').first().click()

  const cursor = page.locator('svg.timeline-main')
  await cursor.focus()
  await cursor.press('Home')
  for (let index = 0; index < 12; index++) await cursor.press('ArrowRight')

  const range = page.locator('svg.range-navigator')
  await range.focus()
  await range.press('+')
  await range.press('ArrowRight')

  await page.getByText('Trace metadata').click()
  await page.getByText('Raw JSON').click()
  await expect(page.getByText('Logical time')).toBeVisible()
}
