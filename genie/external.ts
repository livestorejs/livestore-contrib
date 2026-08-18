import {
  catalog as effectUtilsCatalog,
  defineCatalog,
  packageJson,
  type WorkspaceIdentity,
} from '../repos/effect-utils/genie/external.ts'
import { effectV4Catalog, livestoreOnlyCatalog, obsoleteEffectV3Packages } from '../repos/livestore/genie/external.ts'
import { coreOwnedPackageNames, contribPackageNames } from './internal.ts'

/**
 * Contrib matches core's Effect 4 cohort (`4.0.0-rc.109` from
 * livestorejs/livestore#1558). Prerelease carets do not match across `rc.N`, so
 * pinning one release ahead would unsatisfy core's `^4.0.0-rc.109` peers.
 */
const contribEffectVersion = '4.0.0-rc.109'

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

export const livestoreContribOnlyCatalog = {} as const

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
