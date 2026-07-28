import { projectionArtifact } from './genie/repo.ts'
import rootPackageJson from './package.json.genie.ts'
import rootPnpmWorkspaceYaml from './pnpm-workspace.yaml.genie.ts'
import { pnpmInstallStorageContractV2 as storage } from './repos/effect-utils/genie/external.ts'

/**
 * Root pnpm install contract consumed by effect-utils' shared pnpm task module
 * (`nix/devenv-modules/tasks/shared/pnpm.nix`), which refuses to install without
 * it. It captures contrib's pnpm install/store policy so the module can hash the
 * install-relevant surface (`dependencyGraphContract`) and classify contract
 * drift across the `identityInputs` sections. Repository-specific graph policy
 * is derived from contrib's own workspace; shared storage authority comes from
 * effect-utils' canonical v2 contract.
 *
 * Mirrors core's contract (`repos/livestore/pnpm-install-contract.json.genie.ts`)
 * rather than diverging: contrib composes core's materialized packages into one
 * workspace, so the two install policies have to be describable in the same
 * terms.
 *
 * Fields contrib intentionally does not set are omitted from the generated JSON
 * (undefined keys are dropped on serialization):
 * - `installPolicy.peerDependencyRules`: contrib drops the shared Effect-v3 peer
 *   suppressions so stale peers fail loudly during the v4 migration, matching
 *   core (see `pnpm-workspace.yaml.genie.ts`).
 * - `workspaceManifestContract.patchedDependencies` / `allowUnusedPatches`:
 *   contrib ships no pnpm patches.
 *
 * Note the contract deliberately does not capture `overrides`, even though
 * contrib sets them to dedupe the Effect v4 family. Neither core's nor
 * effect-utils' contract does; widening the shape here would make contrib's
 * artifact incomparable with theirs.
 */
const packageManager = rootPackageJson.data.packageManager ?? 'pnpm@unknown'
const pnpmVersion = packageManager.startsWith('pnpm@') ? packageManager.slice('pnpm@'.length) : packageManager
const workspaceData = rootPnpmWorkspaceYaml.data

export default projectionArtifact.json({
  schemaVersion: 2,
  data: {
    contract: 'livestore-contrib/pnpm-install-contract',
    packageManager: {
      name: 'pnpm',
      version: pnpmVersion,
    },
    storeContract: storage.storeContract,
    dependencyGraphContract: {
      packageManager: {
        name: 'pnpm',
        version: pnpmVersion,
      },
      allowBuilds: workspaceData.allowBuilds,
      packageExtensions: workspaceData.packageExtensions,
    },
    installPolicy: {
      dedupePeerDependents: workspaceData.dedupePeerDependents,
      ignoreScripts: workspaceData.ignoreScripts,
      minimumReleaseAgeExclude: workspaceData.minimumReleaseAgeExclude,
      optimisticRepeatInstall: workspaceData.optimisticRepeatInstall,
      packageImportMethod: storage.packageImportMethod,
      peerDependencyRules: workspaceData.peerDependencyRules,
      pmOnFail: workspaceData.pmOnFail,
      sideEffectsCache: workspaceData.sideEffectsCache,
      strictPeerDependencies: workspaceData.strictPeerDependencies,
      strictStorePkgContentCheck: workspaceData.strictStorePkgContentCheck,
      supportedArchitectures: workspaceData.supportedArchitectures,
      verifyDepsBeforeRun: workspaceData.verifyDepsBeforeRun,
      verifyStoreIntegrity: workspaceData.verifyStoreIntegrity,
    },
    workspaceManifestContract: {
      injectWorkspacePackages: workspaceData.injectWorkspacePackages,
      allowUnusedPatches: workspaceData.allowUnusedPatches,
      patchedDependencies: workspaceData.patchedDependencies,
      packages: workspaceData.packages,
    },
    metadata: {
      pnpmStoreOwnership: {
        cacheLifecycle: 'pnpm-owned disposable Store Cache',
        derivedIndexLifecycle: 'shared only inside one same-user trust boundary',
        virtualStoreLifecycle: 'Materialization-Root-owned rebuildable dependency graph',
      },
      nixIntegration: {
        liveVirtualStoreScope: 'materialization-root',
        fixedOutputDependencyPrepUsesSameVirtualStoreScope: true,
      },
      buck2Integration: {
        consumeContractArtifact: true,
        avoidNodeModulesLayoutAsApi: true,
      },
    },
    dependencyMaterializationProfile: {
      schema: 'dependency-materialization-profile/v0',
      identityInputs: [
        'packageManager',
        'dependencyGraphContract',
        'installPolicy',
        'storeContract',
        'workspaceManifestContract',
      ],
      supportedTraits: {
        ciJobLocal: {
          mutableState: 'job-local',
          gcAuthority: 'profile-local',
          repairAuthority: 'ci-job',
        },
        hostUserStoreCache: {
          mutableState: 'materialization-root-and-host-user-cache',
          sharedContent: 'complete-pnpm-store-cache',
          gcAuthority: 'host-fleet-maintenance',
          repairAuthority: 'materialization-root',
        },
        nixPreparedDeps: {
          mutableState: 'none',
          gcAuthority: 'nix-store',
          repairAuthority: 'evergreen-fod',
        },
      },
      nativeBuildPolicyInputs: {
        allowBuilds: 'dependencyGraphContract.allowBuilds',
        compilerEnv: ['CC', 'CXX'],
      },
      buck2Boundary: {
        consumesEvidence: true,
        ownsLiveMaterialization: false,
      },
    },
  },
})
