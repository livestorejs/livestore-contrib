import { defineConfig } from 'vite'

export default defineConfig({
  build: { target: 'es2022' },
  optimizeDeps: { exclude: ['loro-crdt', 'loro-prosemirror'] },
  server: {
    host: '127.0.0.1',
    port: 4174,
  },
})
