# @livestore/devtools-vite

Vite plugin for the LiveStore Devtools.

## Usage

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import { livestoreVitePlugin } from '@livestore/devtools-vite'

export default defineConfig({
  plugins: [livestoreDevtoolsPlugin({ schemaPath: './src/livestore/schema.ts' })],
})
```
