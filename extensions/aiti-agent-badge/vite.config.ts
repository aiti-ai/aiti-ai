/**
 * aiti-agent-badge client build (Vite lib mode).
 *
 * client/src/entry.tsx (JSX + TS) -> dist/aiti-agent-badge.mjs.
 * The three JSX-template pitfalls are handled here (do not regress):
 * automatic jsx runtime, regex aliases for react / react/jsx-runtime, and an
 * empty rollup external list so the bundle is browser-loadable.
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
      { find: /^react\/jsx-dev-runtime$/, replacement: fileURLToPath(new URL("client/src/jsx-runtime.ts", import.meta.url)) },
      { find: /^react\/jsx-runtime$/, replacement: fileURLToPath(new URL("client/src/jsx-runtime.ts", import.meta.url)) },
      { find: /^react$/, replacement: fileURLToPath(new URL("client/src/host-shim.ts", import.meta.url)) },
    ],
  },
  build: {
    lib: {
      entry: fileURLToPath(new URL("client/src/entry.tsx", import.meta.url)),
      formats: ["es"],
      fileName: () => "aiti-agent-badge.mjs",
    },
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
    minify: true,
    sourcemap: false,
    rollupOptions: {
      external: [],
    },
  },
});
