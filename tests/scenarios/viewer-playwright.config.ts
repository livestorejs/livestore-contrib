import path from 'node:path'

import { defineConfig } from '@playwright/test'

const viewerPort = process.env.SCENARIO_VIEWER_PORT ?? '4173'

export default defineConfig({
  testDir: './src/viewer-e2e',
  outputDir: './test-results/viewer',
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    locale: 'en-US',
    timezoneId: 'Europe/Copenhagen',
    reducedMotion: 'reduce',
  },
  projects: [
    { name: 'desktop-light', use: { viewport: { width: 1440, height: 1000 }, colorScheme: 'light' } },
    { name: 'desktop-dark', use: { viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' } },
    { name: 'narrow-light', use: { viewport: { width: 700, height: 900 }, colorScheme: 'light' } },
  ],
  webServer: {
    command: `pnpm viewer --host 127.0.0.1 --port ${viewerPort} --strictPort`,
    cwd: path.resolve(import.meta.dirname),
    url: `http://127.0.0.1:${viewerPort}`,
    reuseExistingServer: false,
  },
})
