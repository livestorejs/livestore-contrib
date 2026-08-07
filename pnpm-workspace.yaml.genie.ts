import { catalog } from './genie/external.ts'
import { commonPnpmPolicySettings, pnpmWorkspaceYaml, repoPnpmAllowBuilds } from './genie/repo.ts'
import { rootWorkspaceExtraMembers, rootWorkspacePackages } from './package.json.genie.ts'

/**
 * The shared effect-utils pnpm policy still suppresses peer conflicts for
 * obsolete Effect v3 package names. Drop those suppressions (mirroring core) so
 * stale v3 peers fail loudly during the v4 migration instead of being hidden.
 */
const { peerDependencyRules: _effectV3PeerDependencyRules, ...contribPnpmPolicySettings } = commonPnpmPolicySettings

/**
 * Dedupe the Effect v4 family to contrib's single `4.0.0-beta.98` pin across the
 * workspace. Core's materialized packages (e.g. `@livestore/peer-deps`) pin some
 * of these to core's `4.0.0-beta.97`; without overrides pnpm would install both
 * betas side by side. Overriding also rewrites the recorded peer ranges to exact
 * versions in the lockfile, which the generated catalog peer-dep validator can
 * evaluate (its minimal semver cannot resolve caret prerelease ranges).
 */
const effectDedupeOverrides = catalog.pick(
  'effect',
  '@effect/platform-browser',
  '@effect/platform-bun',
  '@effect/platform-node',
  '@effect/platform-node-shared',
  '@effect/opentelemetry',
  '@effect/vitest',
)

/**
 * Catalog packages that legitimately resolve to more than one version.
 *
 * These duplicates **predate** the effect-utils pin bump that introduced the
 * `catalog-duplicates` validator — `main`'s lockfile already contains the same sets.
 * `pnpm dedupe` collapses none of them: every stale version is exact-pinned by
 * something, so there is no in-range fix. Tracked in livestorejs/livestore-contrib#29.
 *
 * The validator warns when an entry stops matching a real duplicate, so these expire
 * on their own once the underlying cause is fixed.
 */
const contribCatalogDuplicateExceptions = [
  // --- 1. @tanstack/react-start exact-pins the older router family -------------
  // The examples already use the catalog's `@tanstack/react-router@1.145.7`. The
  // duplicate comes from `@tanstack/react-start@1.139.14`, which is not a catalog
  // package and pins the `1.139.x` router family exactly. Fixing it means moving
  // react-start to a release whose router pin is in `1.145.x`, not touching these.
  ...[
    { package: '@tanstack/react-router', versions: ['1.145.7', '1.139.14'] },
    { package: '@tanstack/router-core', versions: ['1.145.7', '1.139.14'] },
    { package: '@tanstack/router-plugin', versions: ['1.145.10', '1.139.14'] },
    { package: '@tanstack/history', versions: ['1.145.7', '1.139.0'] },
  ].map((entry) => ({
    ...entry,
    reason:
      '@tanstack/react-start@1.139.14 exact-pins the 1.139.x router family; the examples themselves already use the catalog 1.145.x router',
    issue: '#29',
  })),

  // --- 2. Playwright is coupled to the Nix browser build ------------------------
  {
    package: '@playwright/test',
    versions: ['1.61.0', '1.59.1'],
    // Not a stale pin to bump in isolation: `mr:lock-sync-check` requires the
    // playwright flake's Nix lock revision to match `megarepo.lock`, so browser
    // builds follow the megarepo pin rather than upstream. Moving the examples to
    // 1.61.0 without moving that pin installs a Playwright whose expected chromium
    // build is absent. A previous attempt was reverted for exactly this reason.
    reason:
      'examples pin 1.59.1 to match the chromium build shipped by the megarepo-pinned playwright flake; aligning to the catalog 1.61.0 requires moving both together',
    issue: '#29',
  },

  // --- 3. Hand-maintained example manifests drift from the catalog --------------
  // `examples/*` have no `package.json.genie.ts`, so nothing keeps them aligned.
  // The structural fix is to make them genie-managed; see #29.
  ...[
    { package: '@types/react', versions: ['19.2.7', '19.1.17'] },
    { package: '@types/react-dom', versions: ['19.2.3', '19.1.11'] },
    { package: '@vitejs/plugin-react', versions: ['5.1.2', '5.0.4'] },
    { package: '@web/test-runner', versions: ['0.20.0', '0.18.3'] },
    { package: '@cloudflare/workers-types', versions: ['4.20251118.0', '4.20250924.0'] },
    { package: '@rollup/plugin-node-resolve', versions: ['16.0.1', '15.3.1'] },
  ].map((entry) => ({
    ...entry,
    reason:
      'hand-maintained example manifests under examples/ are not genie-managed and have drifted from the catalog pin',
    issue: '#29',
  })),

  // --- 4. Third-party CLIs pinning their own dependencies -----------------------
  // Dev/build tooling only, never shipped surface. Least tractable, lowest value.
  ...[
    { package: 'esbuild', versions: ['0.28.0', '0.27.7', '0.25.4'], by: 'wrangler' },
    { package: 'graphql', versions: ['16.11.0', '16.8.1'], by: 'eas-cli, graphql-tag, @0no-co/graphql.web' },
    { package: 'nanoid', versions: ['5.0.9', '3.3.12', '3.3.8'], by: 'eas-cli' },
    { package: 'yaml', versions: ['2.9.0', '2.6.0'], by: 'eas-cli' },
    { package: 'pretty-bytes', versions: ['7.0.1', '5.6.0'], by: '@expo/cli' },
    { package: 'string-width', versions: ['5.1.2', '4.2.3'], by: '@oclif/core, cli-progress' },
  ].map(({ by, ...entry }) => ({
    ...entry,
    reason: `${by} pins its own copy exactly; dev/build tooling only, never part of the published surface`,
    issue: '#29',
  })),

  // --- 5. Effect v4 pulls a newer OTel core than the catalog -------------------
  // The catalog still pins `@opentelemetry/core@2.2.0`; `@effect/opentelemetry`
  // resolves the newer line for itself. An artifact of contrib deliberately running
  // one Effect beta ahead of core; it resolves when the catalog's OTel pins catch up
  // to what Effect v4 peers on.
  {
    package: '@opentelemetry/core',
    versions: ['2.8.0', '2.2.0'],
    reason: '@effect/opentelemetry@4.0.0-beta.98 requires a newer OTel core than the effect-utils catalog pins',
    issue: '#29',
  },

  // --- 6. Current core deliberately holds pre-upgrade dependency lines ----------
  // Core 63cb2f26 inherits the bumped effect-utils catalog but intentionally pins
  // these external dependencies to the prior compatible lines pending its dedicated
  // dependency-upgrade work. Contrib composes that core catalog while newer tooling
  // still resolves the newer lines transitively, so both versions remain until core's
  // hold is removed.
  ...[
    { package: '@opentelemetry/api', versions: ['1.9.1', '1.9.0'] },
    { package: '@opentelemetry/resources', versions: ['2.8.0', '2.2.0'] },
    { package: '@opentelemetry/sdk-trace-base', versions: ['2.8.0', '2.2.0'] },
    { package: '@types/node', versions: ['26.0.0', '25.3.3'] },
    { package: 'vite', versions: ['8.0.16', '7.3.1'] },
  ].map((entry) => ({
    ...entry,
    reason:
      'core 63cb2f26 deliberately holds the prior compatible dependency line pending its dedicated dependency-upgrade work',
    issue: '#29',
  })),

  // --- 7. A published @livestore/utils resolves beside the workspace one --------
  {
    package: '@livestore/utils',
    versions: ['0.4.0', '0.4.0-dev.25'],
    // Different in kind from the rest and worth investigating: the catalog pins
    // `workspace:*`, so a registry copy resolving alongside suggests something
    // depends on the published package rather than the workspace member.
    reason:
      'a published @livestore/utils resolves alongside the workspace member; cause not yet identified, unlike the other entries here',
    issue: '#29',
  },
] as const

export default pnpmWorkspaceYaml.root({
  packages: rootWorkspacePackages,
  repoName: 'livestore-contrib',
  extraMembers: rootWorkspaceExtraMembers,
  catalogVersions: catalog,
  ...contribPnpmPolicySettings,
  injectWorkspacePackages: false,
  allowBuilds: repoPnpmAllowBuilds,
  strictPeerDependencies: false,
  linkWorkspacePackages: true,
  overrides: effectDedupeOverrides,
  catalogDuplicateExceptions: contribCatalogDuplicateExceptions,
})
