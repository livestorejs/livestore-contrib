import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test, type Page } from '@playwright/test'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const failureArtifact = path.join(packageRoot, 'artifacts/sf-01-concurrent-hotel-booking.json.gz')
const manyWriterArtifact = path.join(packageRoot, 'artifacts/sf-03-many-writer-426.json.gz')
const offlineArtifact = path.join(packageRoot, 'artifacts/reference-offline-writer-recovery-browser.json.gz')
const lifecycleArtifact = path.join(packageRoot, 'artifacts/reference-browser-multi-session-recovery-browser.json.gz')
const denseArtifact = path.join(packageRoot, 'artifacts/reference-shared-todo-workday-browser.json.gz')
const viewerUrl = 'http://127.0.0.1:4173'

test('canonical viewer matches the approved failure and interaction baselines', async ({ page }) => {
  await openArtifact(page, viewerUrl, failureArtifact, 'concurrent-hotel-booking')
  await expect(
    page.getByLabel('Saved scenario run').locator('option').filter({ hasText: 'core working tree' }).first(),
  ).toBeAttached()
  await expect(page).toHaveScreenshot('loaded-failure.png', { fullPage: true })

  await openArtifact(page, viewerUrl, offlineArtifact, 'offline-writer-recovery')
  await applyComparisonState(page)
  await expect(page).toHaveScreenshot('interaction-state.png', { fullPage: true })
  await expect(page.getByText('Logical time')).toBeVisible()
  await expect(page.locator('svg.timeline-main')).toHaveAttribute('aria-valuenow', /\d+/)
})

test('canonical viewer matches the approved passed lifecycle baseline', async ({ page }) => {
  await openArtifact(page, viewerUrl, lifecycleArtifact, 'browser-multi-session-recovery')
  await expect(page.getByLabel('System').locator('.section-heading .badge')).toHaveText('passed')
  await expect(page).toHaveScreenshot('loaded-success.png', { fullPage: true })
})

test('SF-03 keeps workload control traffic out of the sync-evidence geometry', async ({ page }) => {
  await openArtifact(page, viewerUrl, manyWriterArtifact, 'many-writer-convergence')
  const timeline = page.getByRole('region', { name: 'Timeline', exact: true })
  await expect(timeline.locator('.evidence-moment')).toHaveCount(19)
  await expect(timeline.locator('.moment-workload')).toContainText('426 actions')
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
  await openArtifact(page, viewerUrl, denseArtifact, 'shared-todo-workday')
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
