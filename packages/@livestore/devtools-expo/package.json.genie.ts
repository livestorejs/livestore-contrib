import { contribCoreReleaseVersion } from '../../../genie/external.ts'
import {
  catalog,
  getUtilsPeerDeps,
  livestorePackageDefaults,
  packageJson,
  workspaceMember,
} from '../../../genie/repo.ts'
import utilsPkg from '../../../repos/livestore/packages/@livestore/utils/package.json.genie.ts'
import adapterNodePkg from '../adapter-node/package.json.genie.ts'

const runtimeDeps = catalog.compose({
  workspace: workspaceMember('packages/@livestore/devtools-expo'),
  dependencies: {
    workspace: [adapterNodePkg, utilsPkg],
  },
  devDependencies: {
    external: catalog.pick('@types/node', 'expo', 'vite'),
  },
  peerDependencies: {
    external: {
      ...getUtilsPeerDeps(),
      ...catalog.pick('@livestore/devtools-vite'),
      expo: '^54.0.12',
    },
  },
})

const releaseRuntimeDeps = {
  ...runtimeDeps,
  // Mirrored dev publication requires an exact core cohort, while compose intentionally ranges peers.
  peerDependencies: {
    ...runtimeDeps.peerDependencies,
    '@livestore/devtools-vite': contribCoreReleaseVersion,
  },
}

export default packageJson(
  {
    name: '@livestore/devtools-expo',
    ...livestorePackageDefaults,
    types: './dist/index.d.cts',
    main: './dist/index.cjs',
    peerDependenciesMeta: adapterNodePkg.data.peerDependenciesMeta,
    files: [...livestorePackageDefaults.files, 'expo-module.config.json', 'webui'],
    publishConfig: {
      access: 'public',
    },
    scripts: {
      test: 'echo No tests yet',
    },
  },
  releaseRuntimeDeps,
)
