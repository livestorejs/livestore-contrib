import { baseOxfmtIgnorePatterns, baseOxfmtOptions, oxfmtConfig } from './genie/repo.ts'

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
  ],
})
