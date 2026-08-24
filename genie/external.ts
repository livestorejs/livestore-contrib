import {
  catalog as effectUtilsCatalog,
  defineCatalog,
  packageJson,
  type WorkspaceIdentity,
} from '../repos/effect-utils/genie/external.ts'
import { effectV4Catalog, livestoreOnlyCatalog, obsoleteEffectV3Packages } from '../repos/livestore/genie/external.ts'
import { coreOwnedPackageNames, contribPackageNames } from './internal.ts'

const obsoleteEffectV3PackageNames = new Set<string>(obsoleteEffectV3Packages)

const effectV4CatalogPackageNames = new Set<string>(Object.keys(effectV4Catalog))

/**
 * Keep inheriting non-Effect tooling versions from effect-utils while contrib
 * owns the Effect v4 surface. Drop the obsolete v3 packages (absorbed into
 * `effect` core) and the v4-overridden names so the flat catalog composition
 * below cannot reintroduce v3-era pins.
 */
const effectUtilsCatalogWithoutEffectV3 = Object.fromEntries(
  Object.entries(effectUtilsCatalog).filter(
    ([name]) => obsoleteEffectV3PackageNames.has(name) === false && effectV4CatalogPackageNames.has(name) === false,
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
 * publishing. Release generation selects the explicit core release version so future mirrored dev
 * cohorts do not retain this checkout's fallback; ordinary generation deliberately falls back to a
 * reviewed, published version.
 */
const requestedContribReleaseVersion = process.env.LIVESTORE_RELEASE_VERSION
const requestedCoreReleaseVersion = process.env.LIVESTORE_CORE_RELEASE_VERSION
const mirroredDevVersionPattern = /^\d+\.\d+\.\d+-dev\.\d+$/

export const contribCoreReleaseVersion =
  requestedContribReleaseVersion === requestedCoreReleaseVersion &&
  requestedCoreReleaseVersion !== undefined &&
  mirroredDevVersionPattern.test(requestedCoreReleaseVersion)
    ? requestedCoreReleaseVersion
    : '0.5.0-dev.0'

export const contribConsumedCoreArtifacts = {
  '@livestore/devtools-vite': contribCoreReleaseVersion,
} as const

export const livestoreContribOnlyCatalog = {
  ...contribConsumedCoreArtifacts,
} as const

export const catalog = defineCatalog({
  ...effectUtilsCatalogWithoutEffectV3,
  ...contribCatalogOverrides,
  ...effectV4Catalog,
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
