import {
  catalog,
  getUtilsPeerDeps,
  livestorePackageDefaults,
  packageJson,
  workspaceMember,
} from '../../../genie/repo.ts'
import adapterWebPkg from '../../../repos/livestore/packages/@livestore/adapter-web/package.json.genie.ts'
import commonPkg from '../../../repos/livestore/packages/@livestore/common/package.json.genie.ts'
import frameworkToolkitPkg from '../../../repos/livestore/packages/@livestore/framework-toolkit/package.json.genie.ts'
import livestorePkg from '../../../repos/livestore/packages/@livestore/livestore/package.json.genie.ts'
import utilsDevPkg from '../../../repos/livestore/packages/@livestore/utils-dev/package.json.genie.ts'
import utilsPkg from '../../../repos/livestore/packages/@livestore/utils/package.json.genie.ts'

const runtimeDeps = catalog.compose({
  workspace: workspaceMember('packages/@livestore/solid'),
  dependencies: {
    workspace: [commonPkg, frameworkToolkitPkg, livestorePkg, utilsPkg],
    external: catalog.pick('@opentelemetry/api'),
  },
  devDependencies: {
    workspace: [adapterWebPkg, utilsDevPkg],
    external: {
      ...catalog.pick(
        '@opentelemetry/sdk-trace-base',
        '@solidjs/testing-library',
        'jsdom',
        'solid-js',
        'typescript',
        'vite',
        'vitest',
      ),
      'vite-plugin-solid': '2.11.10',
      ...catalog.pick('@testing-library/jest-dom'),
    },
  },
  peerDependencies: {
    external: {
      ...getUtilsPeerDeps(),
      'solid-js': '^1.9.10',
    },
  },
})

export default packageJson(
  {
    name: '@livestore/solid',
    ...livestorePackageDefaults,
    exports: {
      '.': './src/mod.ts',
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': './dist/mod.js',
      },
    },
    scripts: {
      build: 'tsc',
      test: "echo 'todo'",
    },
  },
  runtimeDeps,
)
