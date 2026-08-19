import { baseOxfmtIgnorePatterns, baseOxfmtOptions, oxfmtConfig } from './genie/repo.ts'

export default oxfmtConfig({
  ...baseOxfmtOptions,
  printWidth: 120,
  experimentalSortImports: {
    ...baseOxfmtOptions.experimentalSortImports,
    internalPattern: ['@livestore/', '@local/'],
  },
  ignorePatterns: [
    // Emitted verbatim from a shared source in effect-utils, which formats at a different print
    // width. The file is generated, read-only and never hand-edited, so formatting it here would
    // only make the two repos disagree about the bytes of a security-relevant validator.
    '.github/scripts/pr-snapshot-artifact.mjs',
    '.github/scripts/pr-snapshot-artifact.test.mjs',
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
