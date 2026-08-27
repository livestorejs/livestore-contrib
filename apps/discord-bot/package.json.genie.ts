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
    'check:cf': 'tsc -p cf/tsconfig.json --noEmit && vitest run cf',
    'check:effect': 'tsgo --build --force tsconfig.json && tsgo --build --force e2e/tsconfig.json',
    'check:e2e': 'tsc -p e2e/tsconfig.json --noEmit',
    'cf:deploy': 'node --experimental-strip-types cf/src/deploy-preflight.ts && (cd cf && node --experimental-strip-types scripts/state-migrate.ts --verify-remote-authoritative) && alchemy deploy cf/alchemy.run.ts',
    'cf:dev': 'ALCHEMY_LOCAL=1 alchemy dev cf/alchemy.local.ts',
    'cf:plan': 'node --experimental-strip-types cf/src/deploy-preflight.ts && (cd cf && node --experimental-strip-types scripts/state-migrate.ts --verify-remote-authoritative) && alchemy plan cf/alchemy.run.ts',
    'cf:preflight': 'node --experimental-strip-types cf/src/deploy-preflight.ts',
    'cf:state:migrate:dry-run': 'node --experimental-strip-types cf/src/deploy-preflight.ts && (cd cf && node --experimental-strip-types scripts/state-migrate.ts --dry-run)',
    'cf:state:migrate:execute': 'node --experimental-strip-types cf/src/deploy-preflight.ts && (cd cf && node --experimental-strip-types scripts/state-migrate.ts --execute)',
    'cf:state:verify-equal': 'node --experimental-strip-types cf/src/deploy-preflight.ts && (cd cf && node --experimental-strip-types scripts/state-migrate.ts --verify-equal)',
    'cf:state:verify-remote-authoritative': 'node --experimental-strip-types cf/src/deploy-preflight.ts && (cd cf && node --experimental-strip-types scripts/state-migrate.ts --verify-remote-authoritative)',
    'e2e:live': 'node --experimental-strip-types e2e/src/live-main.ts',
    start: 'node --experimental-strip-types src/main.ts',
    test: 'vitest run',
    'test:e2e': 'vitest run e2e/src',
    'test:cf': 'vitest run cf',
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
