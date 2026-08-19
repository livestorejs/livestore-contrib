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
 * Suppress the false-positive catalog peer-dep conflict for `ioredis`: Effect v4's
 * `@effect/platform-node` peers `ioredis: ^5.7.0`, but the shared effect-utils catalog
 * still pins `ioredis: 5.6.1`. Nothing in contrib consumes ioredis from the catalog —
 * it resolves transitively to a `^5.7.0`-satisfying version — so the catalog pin is
 * vestigial and the validator error is spurious. Core hits the identical stale-catalog
 * conflict. The override range is matched against the catalog version (5.6.1).
 * TODO(upstream): bump effect-utils' catalog `ioredis` to `^5.7.0`, then drop this.
 */
const contribPeerDependencyRules = {
  allowedVersions: {
    ioredis: '>=5.6.1',
  },
}


/**
 * Catalog duplicates that the examples closure resolves to two versions.
 *
 * These are transitive, not chosen: in every case the catalog already pins the newer version and the
 * older one is pulled in by an example app's dependency tree. `pnpm dedupe` cannot collapse them
 * because the two ranges genuinely do not overlap.
 *
 * They are pre-existing drift rather than anything this branch introduces — they only became visible
 * when the effect-utils bump brought in the catalog-duplicate validator. Recorded here so the drift is
 * explicit rather than silent.
 *
 * TODO: upgrade the example apps so these collapse, and drop the entries. That is a dependency-hygiene
 * change with its own risk surface and belongs in its own pull request.
 */
const contribCatalogDuplicateExceptions = [
  {
    package: '@cloudflare/workers-types',
    versions: ['4.20251118.0', '4.20250924.0'],
    reason:
      'Transitive duplicate in the examples closure. The catalog already pins the newer version; the older one arrives through an example app\'s own dependency tree, so nothing in contrib selects it directly.',
  },
  {
    package: '@livestore/utils',
    versions: ['0.4.0', '0.4.0-dev.25'],
    reason:
      'Transitive duplicate in the examples closure. The catalog already pins the newer version; the older one arrives through an example app\'s own dependency tree, so nothing in contrib selects it directly.',
  },
  {
    package: '@opentelemetry/core',
    versions: ['2.7.1', '2.2.0'],
    reason:
      'Transitive duplicate in the examples closure. The catalog already pins the newer version; the older one arrives through an example app\'s own dependency tree, so nothing in contrib selects it directly.',
  },
  {
    package: '@opentelemetry/resources',
    versions: ['2.7.1', '2.2.0'],
    reason:
      'Transitive duplicate in the examples closure. The catalog already pins the newer version; the older one arrives through an example app\'s own dependency tree, so nothing in contrib selects it directly.',
  },
  {
    package: '@playwright/test',
    versions: ['1.61.0', '1.59.1'],
    reason:
      'Transitive duplicate in the examples closure. The catalog already pins the newer version; the older one arrives through an example app\'s own dependency tree, so nothing in contrib selects it directly.',
  },
  {
    package: '@rollup/plugin-node-resolve',
    versions: ['16.0.1', '15.3.1'],
    reason:
      'Transitive duplicate in the examples closure. The catalog already pins the newer version; the older one arrives through an example app\'s own dependency tree, so nothing in contrib selects it directly.',
  },
  {
    package: '@tanstack/history',
    versions: ['1.145.7', '1.139.0'],
    reason:
      'Transitive duplicate in the examples closure. The catalog already pins the newer version; the older one arrives through an example app\'s own dependency tree, so nothing in contrib selects it directly.',
  },
  {
    package: '@tanstack/react-router',
    versions: ['1.145.7', '1.139.14'],
    reason:
      'Transitive duplicate in the examples closure. The catalog already pins the newer version; the older one arrives through an example app\'s own dependency tree, so nothing in contrib selects it directly.',
  },
  {
    package: '@tanstack/router-core',
    versions: ['1.145.7', '1.139.14'],
    reason:
      'Transitive duplicate in the examples closure. The catalog already pins the newer version; the older one arrives through an example app\'s own dependency tree, so nothing in contrib selects it directly.',
  },
  {
    package: '@tanstack/router-plugin',
    versions: ['1.145.10', '1.139.14'],
    reason:
      'Transitive duplicate in the examples closure. The catalog already pins the newer version; the older one arrives through an example app\'s own dependency tree, so nothing in contrib selects it directly.',
  },
  {
    package: '@types/react',
    versions: ['19.2.7', '19.1.17'],
    reason:
      'Transitive duplicate in the examples closure. The catalog already pins the newer version; the older one arrives through an example app\'s own dependency tree, so nothing in contrib selects it directly.',
  },
  {
    package: '@types/react-dom',
    versions: ['19.2.3', '19.1.11'],
    reason:
      'Transitive duplicate in the examples closure. The catalog already pins the newer version; the older one arrives through an example app\'s own dependency tree, so nothing in contrib selects it directly.',
  },
  {
    package: '@vitejs/plugin-react',
    versions: ['5.1.2', '5.0.4'],
    reason:
      'Transitive duplicate in the examples closure. The catalog already pins the newer version; the older one arrives through an example app\'s own dependency tree, so nothing in contrib selects it directly.',
  },
  {
    package: '@web/test-runner',
    versions: ['0.20.0', '0.18.3'],
    reason:
      'Transitive duplicate in the examples closure. The catalog already pins the newer version; the older one arrives through an example app\'s own dependency tree, so nothing in contrib selects it directly.',
  },
  {
    package: 'graphql',
    versions: ['16.11.0', '16.8.1'],
    reason:
      'Transitive duplicate in the examples closure. The catalog already pins the newer version; the older one arrives through an example app\'s own dependency tree, so nothing in contrib selects it directly.',
  },
  {
    package: 'pretty-bytes',
    versions: ['7.0.1', '5.6.0'],
    reason:
      'Transitive duplicate in the examples closure. The catalog already pins the newer version; the older one arrives through an example app\'s own dependency tree, so nothing in contrib selects it directly.',
  },
  {
    package: 'string-width',
    versions: ['5.1.2', '4.2.3'],
    reason:
      'Transitive duplicate in the examples closure. The catalog already pins the newer version; the older one arrives through an example app\'s own dependency tree, so nothing in contrib selects it directly.',
  },
  {
    package: 'yaml',
    versions: ['2.9.0', '2.6.0'],
    reason:
      'Transitive duplicate in the examples closure. The catalog already pins the newer version; the older one arrives through an example app\'s own dependency tree, so nothing in contrib selects it directly.',
  },
  {
    package: 'nanoid',
    versions: ['5.0.9', '3.3.12', '3.3.8'],
    reason:
      'Transitive duplicate in the examples closure. The catalog already pins the newest version; the v3 lines arrive through example dependency trees that have not moved to v5.',
  },
  {
    package: 'esbuild',
    versions: ['0.28.0', '0.27.7', '0.25.4'],
    reason:
      'Transitive duplicate in the examples closure. Bundlers and dev servers pin their own esbuild ranges, so several coexist regardless of the catalog pin.',
  },
]

export default pnpmWorkspaceYaml.root({
  packages: rootWorkspacePackages,
  repoName: 'livestore-contrib',
  extraMembers: rootWorkspaceExtraMembers,
  catalogVersions: catalog,
  ...contribPnpmPolicySettings,
  peerDependencyRules: contribPeerDependencyRules,
  injectWorkspacePackages: false,
  allowBuilds: repoPnpmAllowBuilds,
  strictPeerDependencies: false,
  linkWorkspacePackages: true,
  overrides: effectDedupeOverrides,
  catalogDuplicateExceptions: contribCatalogDuplicateExceptions,
})
