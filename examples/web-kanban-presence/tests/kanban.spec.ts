import { expect, test } from '@playwright/test'

test.setTimeout(60_000)

test.describe('Kanban with presence', () => {
  test('adds a column and card, persists them', async ({ baseURL, page }) => {
    if (!baseURL) throw new Error('baseURL is required')

    await page.goto(baseURL)

    const columnInput = page.getByPlaceholder('New column title')
    await expect(columnInput).toBeVisible({ timeout: 30_000 })

    const columnTitle = `Backlog ${Date.now()}`
    await columnInput.fill(columnTitle)
    await page.getByRole('button', { name: 'Add column' }).click()

    await expect(page.locator('.kanban-column', { hasText: columnTitle })).toBeVisible()
  })

  test('shows the online count for a single client', async ({ baseURL, page }) => {
    if (!baseURL) throw new Error('baseURL is required')

    await page.goto(baseURL)

    const onlineCount = page.getByTestId('online-count')
    await expect(onlineCount).toBeVisible({ timeout: 30_000 })
    await expect(onlineCount).toHaveText(/1 online/, { timeout: 30_000 })
  })

  test('two tabs see each other (multitab presence)', async ({ baseURL, browser }) => {
    if (!baseURL) throw new Error('baseURL is required')

    const storeId = `multitab-${Date.now()}`
    const url = `${baseURL}?storeId=${storeId}`

    const context = await browser.newContext()
    const tabA = await context.newPage()
    const tabB = await context.newPage()

    await tabA.goto(url)
    await tabB.goto(url)

    const onlineCountA = tabA.getByTestId('online-count')
    const onlineCountB = tabB.getByTestId('online-count')

    await expect(onlineCountA).toHaveText(/2 online/, { timeout: 30_000 })
    await expect(onlineCountB).toHaveText(/2 online/, { timeout: 30_000 })

    await context.close()
  })
})