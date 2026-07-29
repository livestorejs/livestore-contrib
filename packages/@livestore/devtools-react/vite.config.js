// @ts-check

import path from 'node:path'

import typescript from '@rollup/plugin-typescript'
import tailwindcss from '@tailwindcss/vite'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import { visualizer } from 'rollup-plugin-visualizer'
import { defineConfig } from 'vite'

const outDir = process.env.VITE_OUT_DIR ?? 'dist'
const isDevBuild = process.env.BUILD_DEV !== 'true'
console.log('vite: outDir', outDir, 'isDevBuild', isDevBuild)

export default defineConfig({
  resolve: {
    dedupe: ['effect', 'react', 'react-dom'],
    alias: {
      // Needed for `glide-data-grid` to work
      'react-responsive-carousel': path.resolve('./src/empty-module.ts'),
      // Needed for `glide-data-grid` to work
      marked: path.resolve('./src/empty-module.ts'),
    },
  },
  build: {
    lib: {
      name: 'LiveStoreDevtoolsReact',
      entry: {
        'index.js': 'src/index.ts',
        'components/index.js': 'src/components/index.ts',
        'components/Tabs/index.js': 'src/components/Tabs/index.ts',
      },
      // will use the entry aliases as `entrypoint`
      fileName: (_format, entrypoint) => entrypoint,
      formats: ['es'],
    },
    outDir,
    minify: isDevBuild,
    sourcemap: isDevBuild,
    rollupOptions: {
      // NOTE we're bundling all dependencies (actually devDependencies) into the final bundle in order to
      // speed up the build process of apps using this package except for the packages below
      // `external` entries are not package names, but import modules (e.g. `effect/Function`)
      //
      // NOTE we're bundling `react-dom` as it won't be guaranteed to be available in React Native environments
      // This might need to be revisted later if we want to support embedding React components more directly
      external: [
        // 'react',
        // /^@livestore\/.+/,
        // '@livestore/utils',
        // '@livestore/common',
        '@livestore/livestore',
        '@livestore/adapter-web',
        // '@livestore/wa-sqlite',
        /^@livestore\/wa-sqlite\/.+/,
        // 'effect',
        // /^effect\/.+/,
        // /^@effect\/.+/,
      ],
      // NOTE even though we're also usually running `dev:ts:watch` in the background, we're still using `typescript()` here
      // to be sure we have up-to-date types for a given build
      plugins: [
        typescript({
          outDir,
          tsBuildInfoFile: `${outDir}/.tsbuildinfo`,
          emitDeclarationOnly: true,
        }),
      ],
    },
  },
  worker: { format: 'es' },
  plugins: [
    TanStackRouterVite({ target: 'react' }),
    visualizer({ gzipSize: true, brotliSize: true, filename: `${outDir}/stats/index.html` }),
    tailwindcss(),
  ],
  // Needed for Storybook
  optimizeDeps: {
    exclude: [
      '@livestore/wa-sqlite', // TODO remove once fixed https://github.com/vitejs/vite/issues/8427
    ],
  },
})
