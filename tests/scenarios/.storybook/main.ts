import path from 'node:path'

import type { StorybookConfig } from '@storybook/react-vite'

const config: StorybookConfig = {
  stories: ['../src/viewer/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-a11y'],
  framework: '@storybook/react-vite',
  staticDirs: [{ from: '../artifacts', to: '/' }],
  viteFinal: (viteConfig) => ({
    ...viteConfig,
    cacheDir: path.resolve(import.meta.dirname, '../node_modules/.vite/storybook'),
    resolve: {
      ...viteConfig.resolve,
      alias: {
        ...viteConfig.resolve?.alias,
        '@viewer': path.resolve(import.meta.dirname, '../src/viewer'),
      },
    },
  }),
}

export default config
