import { oxlintConfig } from './genie/repo.ts'
import {
  livestoreOxlintCategories,
  livestoreOxlintIgnorePatterns,
  livestoreOxlintOverrides,
  livestoreOxlintPlugins,
  livestoreOxlintRules,
} from './repos/livestore/.oxlintrc.json.genie.ts'

export default oxlintConfig({
  plugins: livestoreOxlintPlugins,
  categories: livestoreOxlintCategories,
  rules: livestoreOxlintRules,
  ignorePatterns: [
    ...livestoreOxlintIgnorePatterns,
    '**/node_modules/**',
    '**/.pnpm/**',
    '**/.pnpm-store/**',
    '**/dist/**',
    '**/.devenv/**',
    '**/tmp/**',
    '**/playwright-report/**',
    '**/test-results/**',
    '**/.vite/**',
    'examples/**',
  ],
  overrides: livestoreOxlintOverrides,
})
