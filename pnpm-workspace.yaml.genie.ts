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
 * Dedupe the Effect v4 family to contrib's single `4.0.0-rc.109` pin across the
 * workspace. Core's materialized packages (e.g. `@livestore/peer-deps`) pin the
 * same cohort; the override keeps the lockfile on one exact version so the
 * generated catalog peer-dep validator can evaluate it (its minimal semver
 * cannot resolve caret prerelease ranges).
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
})
