import {
  catalog,
  livestorePackageDefaults,
  packageJson,
  utilsEffectPeerDeps,
  workspaceMember,
} from '../../../genie/repo.ts'
import adapterWebPkg from '../../../repos/livestore/packages/@livestore/adapter-web/package.json.genie.ts'
import commonPkg from '../../../repos/livestore/packages/@livestore/common/package.json.genie.ts'
import utilsPkg from '../../../repos/livestore/packages/@livestore/utils/package.json.genie.ts'
import utilsDevPkg from '../../../repos/livestore/packages/@livestore/utils-dev/package.json.genie.ts'
import devtoolsReactPkg from '../devtools-react/package.json.genie.ts'

const composition = catalog.compose({
  workspace: workspaceMember('packages/@livestore/devtools-vite'),
  dependencies: {
    workspace: [adapterWebPkg, devtoolsReactPkg],
    // `@parcel/watcher` is a native module kept external in the plugin bundle
    // (see build.ts) and must be a declared runtime dependency so it resolves
    // from the published package instead of being inlined.
    external: catalog.pick('@parcel/watcher'),
  },
  devDependencies: {
    workspace: [commonPkg, utilsPkg, utilsDevPkg],
    external: catalog.pick('@types/bun', '@types/node', 'typescript', 'vitest'),
  },
  peerDependencies: {
    external: {
      // Use contrib's beta.98 catalog, not core's beta.99 getUtilsPeerDeps()
      // helper, so this package matches the workspace it is built and tested in.
      ...catalog.peers(...utilsEffectPeerDeps, 'react', 'react-dom'),
      ...catalog.peers('vite'),
    },
  },
  mode: 'install',
})

export default packageJson(
  {
    name: '@livestore/devtools-vite',
    ...livestorePackageDefaults,
    license: 'LicenseRef-LiveStore-Community-1.0',
    exports: {
      '.': './src/plugin.ts',
    },
    files: ['dist'],
    publishConfig: {
      access: 'public',
      exports: {
        '.': {
          types: './dist/plugin.d.ts',
          default: './dist/plugin.js',
        },
      },
    },
    scripts: {
      build: 'bun --tsconfig-override tsconfig.bun-runtime.json build.ts',
      'build:dev': 'bun --tsconfig-override tsconfig.bun-runtime.json build.ts --devBuild',
      test: 'vitest',
    },
    $genie: {
      releaseBuild: {
        command: ['pnpm', 'run', 'build'],
        outputs: ['dist'],
      },
      // `releaseBuild` is emitted under the same marker as the generator's
      // closure metadata, so list the exact D5 source-building closure here.
      workspaceClosureDirs: [
        'packages/@livestore/devtools-common',
        'packages/@livestore/devtools-react',
        'packages/@livestore/devtools-vite',
        'repos/effect-utils/packages/@overeng/react-inspector',
        'repos/livestore/packages/@livestore/adapter-web',
        'repos/livestore/packages/@livestore/common',
        'repos/livestore/packages/@livestore/common-cf',
        'repos/livestore/packages/@livestore/framework-toolkit',
        'repos/livestore/packages/@livestore/livestore',
        'repos/livestore/packages/@livestore/react',
        'repos/livestore/packages/@livestore/sqlite-wasm',
        'repos/livestore/packages/@livestore/utils',
        'repos/livestore/packages/@livestore/utils-dev',
        'repos/livestore/packages/@livestore/wa-sqlite',
        'repos/livestore/packages/@livestore/webmesh',
      ],
    },
  },
  composition,
)
