import { packageJson } from '../../genie/repo.ts'

/**
 * The bot intentionally owns a nested workspace so its DFX-compatible Effect
 * graph cannot be flattened into contrib's root dependency cohort.
 */
export default packageJson({
  name: 'livestore-discord',
  version: '0.0.0',
  private: true,
  type: 'module',
  bin: {
    'livestore-discord': './src/main.ts',
  },
  engines: {
    node: '>=24.0.0',
  },
  packageManager: 'pnpm@11.8.0',
  overrides: {
    '@effect/platform-node-shared': '4.0.0-beta.105',
    '@effect/sql-sqlite-do': '4.0.0-beta.105',
    'discord-api-types': '0.38.40',
    effect: '4.0.0-beta.105',
    '@effect/platform-node': '4.0.0-beta.105',
    '@effect/vitest': '4.0.0-beta.105',
  },
  scripts: {
    check: 'tsc --noEmit && tsc -p e2e/tsconfig.json --noEmit && tsc -p cf/tsconfig.json --noEmit',
    'check:cf': 'tsc -p cf/tsconfig.json --noEmit',
    'check:effect': 'tsgo --build --force tsconfig.json && tsgo --build --force e2e/tsconfig.json',
    'check:e2e': 'tsc -p e2e/tsconfig.json --noEmit',
    'e2e:live': 'node --experimental-strip-types e2e/src/live-main.ts',
    start: 'node --experimental-strip-types src/main.ts',
    test: 'vitest run',
    'test:e2e': 'vitest run e2e/src',
  },
  dependencies: {
    '@effect/platform-node': '4.0.0-beta.105',
    '@effect/platform-node-shared': '4.0.0-beta.105',
    '@effect/sql-sqlite-do': '4.0.0-beta.105',
    dfx: '1.0.15',
    'discord-api-types': '0.38.40',
    effect: '4.0.0-beta.105',
  },
  devDependencies: {
    '@cloudflare/workers-types': '^5.20260825.1',
    '@effect/vitest': '4.0.0-beta.105',
    '@types/node': '25.3.3',
    alchemy: 'next',
    typescript: '5.9.3',
    vitest: '4.1.11',
  },
  workspaces: ['.'],
})
