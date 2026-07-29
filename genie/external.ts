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
  // DevTools UI stack (#1497). Versions taken from the upstream devtools-react
  // manifest so the import is a move rather than an upgrade.
  '@dagrejs/dagre': '1.1.4',
  '@dprint/formatter': '0.4.1',
  '@dprint/sql': '0.2.0',
  // alpha24, not the `latest` 6.0.3: it is the first release whose peer range
  // includes React 19 (`^16.12.0 || 17.x || 18.x || 19.x`). alpha02 peers on
  // <=18 and conflicts with contrib's React 19.2.3. Both packages track the
  // upstream `beta` dist-tag, which is where this dependency has always been.
  '@glideapps/glide-data-grid': '6.0.4-alpha24',
  '@glideapps/glide-data-grid-cells': '6.0.4-alpha24',
  clsx: '2.1.1',
  'lucide-react': '0.488.0',
  'react-aria': '3.50.0',
  'react-error-boundary': '6.0.0',
  'react-icons': '5.5.0',
  reactflow: '11.11.4',
  'tailwind-merge': '2.6.0',
  tailwindcss: '4.3.1',
} as const

export const coreWorkspaceCatalog = Object.fromEntries(
  coreOwnedPackageNames.map((name) => [`@livestore/${name}`, 'workspace:*']),
) as Record<`@livestore/${(typeof coreOwnedPackageNames)[number]}`, 'workspace:*'>

export const livestoreContribWorkspaceCatalog = Object.fromEntries(
  contribPackageNames.map((name) => [`@livestore/${name}`, 'workspace:*']),
) as Record<`@livestore/${(typeof contribPackageNames)[number]}`, 'workspace:*'>

export const livestoreContribOnlyCatalog = {
  '@tailwindcss/cli': '4.1.18',
  // Source-built devtools-vite owns both of these entries. Keep them after the
  // inherited LiveStore catalog spread so the old npm artifact pin and
  // package-extension-only watcher declaration cannot win.
  '@livestore/devtools-vite': 'workspace:*',
  '@parcel/watcher': '2.5.6',
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
