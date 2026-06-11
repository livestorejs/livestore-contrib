import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/tests/node-sync/**/*.test.ts'],
    server: { deps: { inline: ['@effect/vitest'] } },
  },
})
