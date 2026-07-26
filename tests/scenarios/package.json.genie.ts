import { catalog, effectDevDeps, localPackageDefaults, packageJson, workspaceMember } from '../../genie/repo.ts'
import adapterWebPkg from '../../packages/@livestore/adapter-web/package.json.genie.ts'
import commonPkg from '../../packages/@livestore/common/package.json.genie.ts'
import livestorePkg from '../../packages/@livestore/livestore/package.json.genie.ts'
import syncCfPkg from '../../packages/@livestore/sync-cf/package.json.genie.ts'
import utilsDevPkg from '../../packages/@livestore/utils-dev/package.json.genie.ts'
import utilsPkg from '../../packages/@livestore/utils/package.json.genie.ts'

const runtimeDeps = catalog.compose({
  workspace: workspaceMember('tests/scenarios'),
  dependencies: {
    workspace: [adapterWebPkg, commonPkg, livestorePkg, syncCfPkg, utilsPkg],
    external: {
      ...catalog.pick('@cloudflare/workers-types'),
      '@playwright/test': '1.61.0',
      ...catalog.pick('react', 'react-dom'),
    },
  },
  devDependencies: {
    workspace: [utilsDevPkg],
    external: {
      ...effectDevDeps('@types/node', '@types/react', '@types/react-dom', '@vitejs/plugin-react', 'vite', 'vitest'),
      '@storybook/addon-a11y': '10.5.4',
      '@storybook/react-vite': '10.5.4',
      storybook: '10.5.4',
      tsx: '^4.20.0',
    },
  },
})

export default packageJson(
  {
    name: '@local/tests-scenarios',
    ...localPackageDefaults,
    scripts: {
      'scenario:run': 'tsx src/cli.ts',
      test: 'vitest run',
      'test:watch': 'vitest',
      viewer: 'pnpm exec vite --config scenario-viewer.vite.config.ts',
      'viewer:build': 'pnpm exec vite build --config scenario-viewer.vite.config.ts',
      storybook: 'pnpm exec storybook dev -p 6006',
      'storybook:build': 'pnpm exec storybook build',
      'viewer:parity': 'pnpm exec playwright test --config viewer-playwright.config.ts',
    },
  },
  runtimeDeps,
)
