import {
  catalog as effectUtilsCatalog,
  defineCatalog,
  packageJson,
  type WorkspaceIdentity,
} from '../repos/effect-utils/genie/external.ts'
import { effectV4Catalog, livestoreOnlyCatalog, obsoleteEffectV3Packages } from '../repos/livestore/genie/external.ts'
import { coreOwnedPackageNames, contribPackageNames } from './internal.ts'

/**
 * Contrib pins one Effect release ahead of core's `4.0.0-beta.97` so the
 * contrib-owned surface resolves at `4.0.0-beta.98`. This still satisfies core's
 * `^4.0.0-beta.97` peer ranges while letting contrib move independently.
 */
const contribEffectVersion = '4.0.0-beta.98'

/**
 * Reuse core's Effect v4 package-name set (single source of truth for *which*
 * packages exist under v4) but remap every version to contrib's pin.
 */
const contribEffectV4Catalog = Object.fromEntries(
  Object.keys(effectV4Catalog).map((name) => [name, contribEffectVersion]),
) as Record<keyof typeof effectV4Catalog, typeof contribEffectVersion>

const obsoleteEffectV3PackageNames = new Set<string>(obsoleteEffectV3Packages)

const contribEffectV4CatalogPackageNames = new Set<string>(Object.keys(contribEffectV4Catalog))

/**
 * Keep inheriting non-Effect tooling versions from effect-utils while contrib
 * owns the Effect v4 surface. Drop the obsolete v3 packages (absorbed into
 * `effect` core) and the v4-overridden names so the flat catalog composition
 * below cannot reintroduce v3-era pins.
 */
const effectUtilsCatalogWithoutEffectV3 = Object.fromEntries(
  Object.entries(effectUtilsCatalog).filter(
    ([name]) =>
      obsoleteEffectV3PackageNames.has(name) === false && contribEffectV4CatalogPackageNames.has(name) === false,
  ),
)

/** TODO: Remove once effect-utils upgrades its TypeScript catalog pin. */
const contribCatalogOverrides = {
  typescript: '6.0.3',
} as const

export const coreWorkspaceCatalog = Object.fromEntries(
  coreOwnedPackageNames.map((name) => [`@livestore/${name}`, 'workspace:*']),
) as Record<`@livestore/${(typeof coreOwnedPackageNames)[number]}`, 'workspace:*'>

export const livestoreContribWorkspaceCatalog = Object.fromEntries(
  contribPackageNames.map((name) => [`@livestore/${name}`, 'workspace:*']),
) as Record<`@livestore/${(typeof contribPackageNames)[number]}`, 'workspace:*'>

/**
 * Contrib-only catalog entries, spread last so they shadow core's.
 *
 * `@livestore/devtools-vite` is keyed to `LIVESTORE_RELEASE_VERSION` in core's
 * `livestoreOnlyCatalog` because core *republishes* the DevTools artifact under its own
 * release version, so during a core publish that version exists. Contrib sets the same env
 * var when packing a snapshot but only consumes devtools-vite, so inheriting core's entry
 * rewrites the dependency to a contrib snapshot version that is never published — the packed
 * tarballs then fail to install with ERR_PNPM_NO_MATCHING_VERSION.
 *
 * Pinning the plain version keeps the dependency resolvable regardless of what contrib is
 * publishing. It intentionally does NOT track core's fallback automatically: this must stay a
 * published version, so bumping it is a deliberate act.
 */
const contribConsumedCoreArtifacts = {
  '@livestore/devtools-vite': '0.4.0-dev.25',
} as const

export const livestoreContribOnlyCatalog = {
  ...contribConsumedCoreArtifacts,
} as const

export const catalog = defineCatalog({
  ...effectUtilsCatalogWithoutEffectV3,
  ...contribCatalogOverrides,
  ...contribEffectV4Catalog,
  ...coreWorkspaceCatalog,
  ...livestoreContribWorkspaceCatalog,
  ...livestoreOnlyCatalog,
  ...livestoreContribOnlyCatalog,
})

export { packageJson }

export const contribWorkspaceMember = (memberPath: string): WorkspaceIdentity => ({
  repoName: 'livestore-contrib',
  memberPath,
})
