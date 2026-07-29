import {
  catalog,
  getUtilsPeerDeps,
  livestorePackageDefaults,
  packageJson,
  workspaceMember,
} from '../../../genie/repo.ts'
import reactInspectorPkg from '../../../repos/effect-utils/packages/@overeng/react-inspector/package.json.genie.ts'
import adapterWebPkg from '../../../repos/livestore/packages/@livestore/adapter-web/package.json.genie.ts'
import commonPkg from '../../../repos/livestore/packages/@livestore/common/package.json.genie.ts'
import livestorePkg from '../../../repos/livestore/packages/@livestore/livestore/package.json.genie.ts'
import reactPkg from '../../../repos/livestore/packages/@livestore/react/package.json.genie.ts'
import sqliteWasmPkg from '../../../repos/livestore/packages/@livestore/sqlite-wasm/package.json.genie.ts'
import utilsPkg from '../../../repos/livestore/packages/@livestore/utils/package.json.genie.ts'
import webmeshPkg from '../../../repos/livestore/packages/@livestore/webmesh/package.json.genie.ts'
import devtoolsCommonPkg from '../devtools-common/package.json.genie.ts'

const runtimeDeps = catalog.compose({
  workspace: workspaceMember('packages/@livestore/devtools-react'),
  dependencies: {
    workspace: [
      adapterWebPkg,
      commonPkg,
      devtoolsCommonPkg,
      livestorePkg,
      reactInspectorPkg,
      reactPkg,
      sqliteWasmPkg,
      utilsPkg,
      webmeshPkg,
    ],
    external: catalog.pick(
      '@dagrejs/dagre',
      '@dprint/formatter',
      '@dprint/sql',
      '@glideapps/glide-data-grid',
      '@glideapps/glide-data-grid-cells',
      'clsx',
      'lucide-react',
      'react-aria',
      'react-aria-components',
      'react-error-boundary',
      'react-icons',
      'reactflow',
      'tailwind-merge',
      '@tanstack/react-router',
    ),
  },
  devDependencies: {
    external: catalog.pick('@storybook/react', '@storybook/react-vite', 'tailwindcss', 'vite', 'vitest'),
  },
  peerDependencies: {
    external: {
      ...getUtilsPeerDeps(),
      ...catalog.peers('react', 'react-dom'),
    },
  },
})

export default packageJson(
  {
    name: '@livestore/devtools-react',
    ...livestorePackageDefaults,
    /**
     * Overrides the Apache-2.0 default inherited from core's
     * `livestorePackageDefaults`. This package is the former sponsorware DevTools
     * UI and ships under the size-gated source-available terms decided in
     * livestorejs/livestore#1511; `LICENSE` carries the text.
     *
     * The override is a plain key after the spread — no core change is required
     * for contrib to license a package differently.
     */
    license: 'LicenseRef-LiveStore-Community-1.0',
    /**
     * Ships TypeScript source, not built ESM: `devtools-vite` compiles it for the
     * drop-in plugin and consumers compile it when embedding DevTools in their own
     * app, so the two paths cannot drift (livestorejs/livestore#1497).
     *
     * Only the Tailwind stylesheet is prebuilt — it is injected into a shadow root
     * at runtime, which is what keeps consumers from needing Tailwind config or
     * content globs of their own.
     */
    exports: {
      '.': './src/mod.ts',
      './components': './src/components/mod.ts',
      './components/Tabs': './src/components/Tabs/mod.ts',
      './index.css': './dist/index.css',
    },
    /**
     * `src` is required because the exports above resolve into it. Upstream ships
     * `dist` only, which would publish a broken package — it is never exercised
     * there because the package is private.
     */
    files: ['dist', 'LICENSE.chromium', 'package.json', 'src'],
    publishConfig: {
      access: 'public',
    },
    scripts: {
      build: 'tailwindcss -i ./src/index.css -o ./dist/index.css',
      test: 'vitest',
    },
    $genie: {
      releaseBuild: {
        command: ['pnpm', 'exec', 'tailwindcss', '-i', './src/index.css', '-o', './dist/index.css'],
        outputs: ['dist'],
      },
    },
  },
  runtimeDeps,
)
