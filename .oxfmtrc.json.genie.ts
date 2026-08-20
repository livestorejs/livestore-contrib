import { baseOxfmtOptions, oxfmtConfig } from './genie/repo.ts'
// Imported straight from effect-utils, not through core's re-export. Core is composed here at a pinned
// revision that resolves effect-utils through its own lock, so shared values reaching us that way are
// whatever that older pin carried — silently stale.
import { baseOxfmtIgnorePatterns } from './repos/effect-utils/genie/oxfmt-base.ts'

export default oxfmtConfig({
  ...baseOxfmtOptions,
  printWidth: 120,
  experimentalSortImports: {
    ...baseOxfmtOptions.experimentalSortImports,
    internalPattern: ['@livestore/', '@local/'],
  },
  ignorePatterns: [
    ...baseOxfmtIgnorePatterns,
    '**/node_modules/**',
    '**/.pnpm/**',
    '**/.pnpm-store/**',
    '**/dist/**',
    '**/tmp/**',
    '**/*.gen.ts',
    '**/*.gen.tsx',
    '**/*.generated.ts',
    '**/*.generated.tsx',
    '**/package.json',
    '**/tsconfig.json',
    '**/tsconfig.*.json',
    '**/*.mdx',
    'examples/**',
    'packages/@livestore/*/src/**',
    'packages/@livestore/*/test/**',
    'packages/@livestore/*/tests/**',
  ],
})
