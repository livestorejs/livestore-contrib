import { expect, test, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'

type RefDemoWindow = Window & {
  __REF_DEMO__: {
    getMetrics: () => {
      text: string
      refCount: number
      sideChannelUpdates: number
      sideChannelBytes: number
      connection: string
      loro: unknown
      proseMirror: unknown
    }
  }
}

test('local draft renders devtools and preserves the ref-only document across reload', async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page)
  const room = `local-${Date.now()}`
  await page.goto(`/?client=client-a&room=${room}&relay=disabled`)
  await expect.poll(() => page.locator('body').getAttribute('data-ready')).toBe('true')

  const editor = page.getByTestId('client-a-editor')
  await editor.click()
  await page.locator('[data-command="bold"]').click()
  await page.keyboard.type('Local persistent alpha')

  await expect(editor).toContainText('Local persistent alpha')
  await expect(page.locator('#livestore-count')).toHaveText('1')
  await expect(page.getByRole('heading', { name: 'LiveStore log' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Loro side-channel' })).toBeVisible()
  await page.locator('.devtools-panel').filter({ hasText: 'Loro document' }).locator('pre').click()

  await page.reload()
  await expect.poll(() => page.locator('body').getAttribute('data-ready')).toBe('true')
  await expect(page.getByTestId('client-a-editor')).toContainText('Local persistent alpha')
  await expect(page.locator('#livestore-count')).toHaveText('1')
  expect(await metrics(page)).toMatchObject({ refCount: 1 })
  expect(consoleErrors).toEqual([])
})

test.describe('deployed relay', () => {
  test.skip(process.env.RELAY_URL === undefined, 'RELAY_URL is provided only after the deploy GO')

  test('two isolated browser contexts converge through the deployed Loro relay and survive reload', async ({ browser }) => {
    const relayBase = process.env.RELAY_URL!
    const room = `pw-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const [contextA, contextB] = await Promise.all([browser.newContext(), browser.newContext()])
    const pageA = await contextA.newPage()
    const pageB = await contextB.newPage()
    const consoleErrorsA = collectConsoleErrors(pageA)
    const consoleErrorsB = collectConsoleErrors(pageB)

    try {
      await Promise.all([
        pageA.goto(`/?client=client-a&room=${room}&relay=${encodeURIComponent(relayBase)}`),
        pageB.goto(`/?client=client-b&room=${room}&relay=${encodeURIComponent(relayBase)}`),
      ])
      await Promise.all([
        expect.poll(() => pageA.locator('body').getAttribute('data-ready')).toBe('true'),
        expect.poll(() => pageB.locator('body').getAttribute('data-ready')).toBe('true'),
        expect.poll(async () => (await metrics(pageA))?.connection).toBe('connected'),
        expect.poll(async () => (await metrics(pageB))?.connection).toBe('connected'),
      ])

      const editorA = pageA.getByTestId('client-a-editor')
      const editorB = pageB.getByTestId('client-b-editor')
      await editorA.click()
      await pageA.locator('[data-command="bold"]').click()
      await pageA.keyboard.type('Alpha from A ')
      await expect(editorB).toContainText('Alpha from A')

      await editorB.click()
      await pageB.keyboard.press('End')
      await pageB.locator('[data-command="bold"]').click()
      await pageB.locator('[data-command="italic"]').click()
      await pageB.keyboard.type('Beta from B')

      await expect(editorA).toContainText('Beta from B')
      await expect(editorB).toContainText('Alpha from A')
      await expect(editorA.locator('strong')).toContainText('Alpha from A')
      await expect(editorB.locator('strong')).toContainText('Alpha from A')
      await expect(editorA.locator('em')).toContainText('Beta from B')
      await expect(editorB.locator('em')).toContainText('Beta from B')
      await expect(pageA.locator('#livestore-count')).toHaveText('1')
      await expect(pageB.locator('#livestore-count')).toHaveText('1')

      const beforeReloadA = await metrics(pageA)
      const beforeReloadB = await metrics(pageB)
      expect(beforeReloadA.sideChannelUpdates).toBeGreaterThan(0)
      expect(beforeReloadB.sideChannelUpdates).toBeGreaterThan(0)
      expect(JSON.stringify(beforeReloadA.proseMirror)).toBe(JSON.stringify(beforeReloadB.proseMirror))
      await mkdir('test-results/evidence', { recursive: true })
      await pageA.screenshot({ path: 'test-results/evidence/deployed-client-a-converged.png', fullPage: true })
      await pageB.screenshot({ path: 'test-results/evidence/deployed-client-b-converged.png', fullPage: true })

      await Promise.all([pageA.reload(), pageB.reload()])
      await Promise.all([
        expect.poll(() => pageA.locator('body').getAttribute('data-ready')).toBe('true'),
        expect.poll(() => pageB.locator('body').getAttribute('data-ready')).toBe('true'),
      ])
      await expect(pageA.getByTestId('client-a-editor')).toContainText('Alpha from A')
      await expect(pageA.getByTestId('client-a-editor')).toContainText('Beta from B')
      await expect(pageB.getByTestId('client-b-editor')).toContainText('Alpha from A')
      await expect(pageB.getByTestId('client-b-editor')).toContainText('Beta from B')

      await pageA.getByRole('heading', { name: 'Loro side-channel' }).click()
      await pageA.locator('.devtools-panel details').first().click()
      await expect(pageA.getByRole('heading', { name: 'Relay sync flow' })).toBeVisible()
      await pageA.screenshot({ path: 'test-results/evidence/deployed-client-a-after-reload-devtools.png', fullPage: true })
      expect([...consoleErrorsA, ...consoleErrorsB]).toEqual([])
    } finally {
      await Promise.all([contextA.close(), contextB.close()])
    }
  })
})

function collectConsoleErrors(page: Page): string[] {
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => consoleErrors.push(error.message))
  return consoleErrors
}

async function metrics(page: Page) {
  return page.evaluate(() => (window as unknown as RefDemoWindow).__REF_DEMO__?.getMetrics())
}
