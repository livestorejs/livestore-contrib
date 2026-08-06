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

const contribCatalogOverrides = {
  /** TODO: Remove once effect-utils upgrades its TypeScript catalog pin. */
  typescript: '6.0.3',
  /**
   * effect-utils has moved to Vite 8, but the pinned core still peers on Vite 7
   * (`@livestore/devtools-vite` on `^7.3.1`, `@sveltejs/vite-plugin-svelte@6.2.1`
   * on `^6.3.0 || ^7.0.0`). Hold the catalog at core's line until the core pin
   * moves; taking Vite 8 here would break those peers rather than just duplicate.
   */
  vite: '7.3.1',
  /**
   * Same shape as the Vite hold: effect-utils moved the OTel SDK forward, but core's
   * tracing helpers are typed against the 2.2.0 family, so taking the newer line here
   * makes contrib's own spans structurally incompatible with core's signatures
   * (`InMemorySpanExporter@2.8.0` vs `@2.2.0`). Hold until the core pin moves.
   */
  '@opentelemetry/api': '1.9.0',
  '@opentelemetry/resources': '2.2.0',
  '@opentelemetry/sdk-trace-base': '2.2.0',
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
