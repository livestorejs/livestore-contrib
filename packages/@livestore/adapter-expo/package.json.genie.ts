import {
  catalog,
  getUtilsPeerDeps,
  livestorePackageDefaults,
  packageJson,
  utilsEffectPeerDeps,
  workspaceMember,
} from '../../../genie/repo.ts'
import commonPkg from '../../../repos/livestore/packages/@livestore/common/package.json.genie.ts'
import utilsPkg from '../../../repos/livestore/packages/@livestore/utils/package.json.genie.ts'
import webmeshPkg from '../../../repos/livestore/packages/@livestore/webmesh/package.json.genie.ts'

/** Effect RC the adapter is typechecked against (devDeps only). */
const effectRcVersion = '4.0.0-rc.109'

const runtimeDeps = catalog.compose({
  workspace: workspaceMember('packages/@livestore/adapter-expo'),
  dependencies: {
    workspace: [commonPkg, utilsPkg, webmeshPkg],
    external: catalog.pick('@opentelemetry/api'),
  },
  devDependencies: {
    // Typecheck the adapter against the latest Effect RC. The workspace catalog
    // pins the shared `beta.98`; override just the Effect v4 family here.
    external: {
      ...catalog.pick('@types/node', 'expo-application', 'expo-sqlite', 'react-native'),
      ...catalog.pick('@opentelemetry/api', '@opentelemetry/resources', '@standard-schema/spec'),
      ...Object.fromEntries(
        utilsEffectPeerDeps
          .filter((name) => name === 'effect' || name.startsWith('@effect/'))
          .map((name) => [name, effectRcVersion]),
      ),
    },
  },
  peerDependencies: {
    external: {
      ...getUtilsPeerDeps(),
      // Accept the RC cohort in addition to the beta line that
      // `@livestore/{common,utils,webmesh}` still peer-depend on. Prerelease
      // carets do not cross `rc.N`, so a plain `^4.0.0-rc.109` would be
      // uninstallable alongside the beta.97 core deps.
      effect: '^4.0.0-beta.97 || ^4.0.0-rc.109',
      'expo-application': '^7.0.7',
      'expo-sqlite': '^16.0.8',
    },
  },
})

export default packageJson(
  {
    name: '@livestore/adapter-expo',
    ...livestorePackageDefaults,
    exports: {
      '.': './src/index.ts',
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': './dist/index.js',
      },
    },
    scripts: {
      test: 'echo No tests yet',
    },
  },
  runtimeDeps,
)
