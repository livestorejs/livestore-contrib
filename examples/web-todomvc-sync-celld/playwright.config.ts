import http from 'node:http'

import type { PlaywrightTestConfig } from '@playwright/test'

const baseURL = process.env.BASE_URL

if (!process.env.PLAYWRIGHT_PORT && !process.env.PORT) {
  process.env.PLAYWRIGHT_PORT = String(await getFreePort())
}
if (!process.env.CELLD_PORT) {
  process.env.CELLD_PORT = String(await getFreePort())
}

const port = process.env.PORT
  ? Number.parseInt(process.env.PORT, 10)
  : Number.parseInt(process.env.PLAYWRIGHT_PORT!, 10)
const celldPort = Number.parseInt(process.env.CELLD_PORT, 10)

const config: PlaywrightTestConfig = {
  // Requires `celld` on PATH (https://github.com/denoland/celld/releases); `--clean` starts each run empty.
  webServer: baseURL
    ? undefined
    : [
        {
          command: `celld dev . --host 127.0.0.1 --port ${celldPort} --no-watch --clean`,
          url: `http://127.0.0.1:${celldPort}/.well-known/celld/health`,
          reuseExistingServer: false,
          timeout: 120_000,
        },
        {
          command: 'pnpm vite --force --host 127.0.0.1',
          port,
          reuseExistingServer: true,
          timeout: 180_000,
          env: { PORT: String(port), CELLD_URL: `http://127.0.0.1:${celldPort}` },
        },
      ],
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  use: {
    headless: true,
    baseURL: baseURL ?? `http://localhost:${port}`,
    screenshot: 'on',
  },
}

export default config

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer()
    server.listen(0, () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Failed to get port'))
        return
      }
      const freePort = address.port
      server.close(() => resolve(freePort))
    })
    server.on('error', reject)
  })
}
