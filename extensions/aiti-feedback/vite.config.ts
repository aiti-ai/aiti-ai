/**
 * aiti-feedback client build (Vite lib mode) — JSX template instance.
 *
 * client/src/entry.tsx (JSX + TS) → single ESM bundle: dist/aiti-feedback-client.mjs
 * (matches the client field in index.ts).
 *
 * Template & notes: extensions/templates/ext-jsx-client/ — three known pitfalls
 * (jsx automatic / regex alias / external []) are already handled; do not regress.
 */
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
  resolve: {
    alias: [
      // Regex-exact matches (string alias is prefix matching; 'react' would swallow 'react/jsx-runtime')
      { find: /^react\/jsx-dev-runtime$/, replacement: fileURLToPath(new URL("client/src/jsx-runtime.ts", import.meta.url)) },
      { find: /^react\/jsx-runtime$/, replacement: fileURLToPath(new URL("client/src/jsx-runtime.ts", import.meta.url)) },
      { find: /^react$/, replacement: fileURLToPath(new URL("client/src/host-shim.ts", import.meta.url)) },
    ],
  },
  build: {
    lib: {
      entry: fileURLToPath(new URL("client/src/entry.tsx", import.meta.url)),
      formats: ["es"],
      fileName: () => "aiti-feedback-client.mjs",
    },
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
    minify: false,
    sourcemap: false,
    rollupOptions: {
      external: [], // everything inlines into a single .mjs
    },
  },
});
