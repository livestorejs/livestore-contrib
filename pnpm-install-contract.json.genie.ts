import { projectionArtifact } from './genie/repo.ts'
import rootPackageJson from './package.json.genie.ts'
import rootPnpmWorkspaceYaml from './pnpm-workspace.yaml.genie.ts'
import { pnpmInstallStorageContractV2 as storage } from './repos/effect-utils/genie/external.ts'

/**
 * Root pnpm install contract consumed by the shared pnpm task module. It captures this repo's
 * install and store policy so the module can hash the install-relevant surface and classify drift
 * across the declared identity inputs.
 *
 * Derived from the generated root manifest and workspace file rather than restated, so the contract
 * cannot describe a policy the repo does not actually have. Shared storage authority comes from the
 * canonical contract in effect-utils.
 */
const packageManager = rootPackageJson.data.packageManager ?? 'pnpm@unknown'
const pnpmVersion = packageManager.startsWith('pnpm@') ? packageManager.slice('pnpm@'.length) : packageManager
const workspaceData = rootPnpmWorkspaceYaml.data

export default projectionArtifact.json({
  schemaVersion: 2,
  data: {
    contract: 'livestore-contrib/pnpm-install-contract',
    packageManager: { name: 'pnpm', version: pnpmVersion },
    storeContract: storage.storeContract,
    dependencyGraphContract: {
      packageManager: { name: 'pnpm', version: pnpmVersion },
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
    dependencyMaterializationProfile: {
      schema: 'dependency-materialization-profile/v0',
      identityInputs: [
        'packageManager',
        'dependencyGraphContract',
        'installPolicy',
        'storeContract',
        'workspaceManifestContract',
      ],
    },
  },
})
