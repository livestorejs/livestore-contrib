import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/tests/node-misc/**/*.test.ts'],
    server: { deps: { inline: ['@effect/vitest'] } },
  },
})
