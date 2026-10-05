import { type Browser, expect, type Page, test } from '@playwright/test'

test.setTimeout(90_000)

test('todos sync between two browsers through celld', async ({ browser, baseURL }) => {
  if (!baseURL) throw new Error('baseURL is required')

  // Separate contexts have separate OPFS storage, so changes can only arrive through the sync backend.
  const storeId = `celld-e2e-${Date.now()}`
  const [alice, bob] = await Promise.all([openApp(browser, baseURL, storeId), openApp(browser, baseURL, storeId)])

  await addTodo(alice, 'from alice')
  await expect(todo(bob, 'from alice')).toBeVisible({ timeout: 15_000 })

  await addTodo(bob, 'from bob')
  await expect(todo(alice, 'from bob')).toBeVisible({ timeout: 15_000 })

  await todo(alice, 'from alice').locator('input[type="checkbox"]').check()
  await expect(todo(bob, 'from alice').locator('input[type="checkbox"]')).toBeChecked({ timeout: 15_000 })
})

const openApp = async (browser: Browser, baseURL: string, storeId: string) => {
  const page = await (await browser.newContext()).newPage()
  await page.goto(`${baseURL}/?storeId=${storeId}`)
  await expect(page.getByPlaceholder('What needs to be done?')).toBeVisible({ timeout: 30_000 })
  return page
}

const addTodo = async (page: Page, text: string) => {
  const input = page.getByPlaceholder('What needs to be done?')
  await input.fill(text)
  await input.press('Enter')
  await expect(todo(page, text)).toBeVisible()
}

const todo = (page: Page, text: string) => page.getByRole('listitem').filter({ hasText: text }).first()
