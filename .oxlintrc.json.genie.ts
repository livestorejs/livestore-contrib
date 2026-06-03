import { baseOxlintCategories, baseOxlintIgnorePatterns, baseOxlintPlugins, oxlintConfig } from './genie/repo.ts'
import { baseOxlintOverrides, baseOxlintRules } from './repos/effect-utils/genie/oxlint-base.ts'

export default oxlintConfig({
  plugins: baseOxlintPlugins,
  categories: baseOxlintCategories,
  rules: {
    ...baseOxlintRules,
    'import/no-commonjs': 'error',
    'typescript/consistent-type-imports': 'warn',
    'overeng/explicit-boolean-compare': 'warn',
  },
  ignorePatterns: [
    ...baseOxlintIgnorePatterns,
    '**/node_modules/**',
    '**/.pnpm/**',
    '**/.pnpm-store/**',
    '**/dist/**',
    '**/.devenv/**',
    '**/tmp/**',
    '**/playwright-report/**',
    '**/test-results/**',
    '**/.vite/**',
  ],
  overrides: [
    ...baseOxlintOverrides,
    {
      files: ['**/vitest.config.ts', '**/vite.config.ts', '**/playwright.config.ts', '**/*.genie.ts'],
      rules: { 'func-style': 'off' },
    },
    {
      files: ['**/*.test.ts', '**/*.test.tsx', '**/__tests__/**', '**/tests/**'],
      rules: {
        'unicorn/no-array-sort': 'off',
        'unicorn/consistent-function-scoping': 'off',
        'require-yield': 'off',
      },
    },
    {
      files: ['**/*.svelte'],
      rules: { 'import/no-unassigned-import': 'off' },
    },
  ],
})
