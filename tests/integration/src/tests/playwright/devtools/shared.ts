import type * as PW from '@playwright/test'
import { errors, expect } from '@playwright/test'

export const checkConnectionRemainsActive = async (options: {
  devtools: PW.Frame | PW.Page
  label: string
  durationMs: number
}) => {
  await expect(
    options.devtools.getByText('Connection to app lost', { exact: false }).describe(`${options.label}:connection-lost`),
  ).not.toBeVisible()

  try {
    await options.devtools
      .getByText('Connection to app lost', { exact: false })
      .describe(`${options.label}:connection-lost-during-watch`)
      .waitFor({ state: 'visible', timeout: options.durationMs })
  } catch (error) {
    if (error instanceof errors.TimeoutError) return
    throw error
  }

  throw new Error(`DevTools lost its app connection during ${options.label}`)
}
