import { defineConfig } from "vite";

export default defineConfig({
  build: { target: "es2022" },
  optimizeDeps: { exclude: ["loro-crdt", "loro-prosemirror"] },
  server: {
    host: "127.0.0.1",
    port: 4173,
    headers: {
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
    },
  },
});
