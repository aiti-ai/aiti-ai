/**
 * aiti-sysmon client build config (Vite lib mode).
 *
 * client/src/entry.tsx (JSX + TS) → single ESM bundle: dist/aiti-proc-tree-client.mjs
 * (matches the client field in index.ts).
 *
 * Template: ext-jsx-client three fixed pitfalls already handled here (jsx automatic /
 * regex alias / external []).
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
      // Regex exact match (string alias is prefix matching; find 'react' would swallow 'react/jsx-runtime')
      { find: /^react\/jsx-dev-runtime$/, replacement: fileURLToPath(new URL("client/src/jsx-runtime.ts", import.meta.url)) },
      { find: /^react\/jsx-runtime$/, replacement: fileURLToPath(new URL("client/src/jsx-runtime.ts", import.meta.url)) },
      { find: /^react$/, replacement: fileURLToPath(new URL("client/src/host-shim.ts", import.meta.url)) },
    ],
  },
  build: {
    lib: {
      entry: fileURLToPath(new URL("client/src/entry.tsx", import.meta.url)),
      formats: ["es"],
      fileName: () => "aiti-proc-tree-client.mjs",
    },
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
    minify: false,
    sourcemap: false,
    rollupOptions: {
      external: [], // npm packages (incl. core.ts helpers) inline into the single .mjs
    },
  },
});
