import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    fileParallelism: false,
    name: '@local/tests-scenarios',
    include: ['src/**/*.test.ts'],
    server: { deps: { inline: ['@effect/vitest'] } },
  },
})
