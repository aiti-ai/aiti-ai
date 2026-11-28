/**
 * Extension client build config (Vite lib mode) — aiti-zcode-agent capability card.
 *
 * Output dist/aiti-zcode-cards.mjs (= the client field in index.ts).
 * The three must-know pitfalls and their workarounds follow the aiti-recovery template
 * (jsx automatic / exact regex alias / external []).
 */
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
    // Production lib bundle: never let the JSX runtime follow the build shell's NODE_ENV.
    // Vite infers jsxDev from NODE_ENV; a build from a dev-instance shell inherits
    // NODE_ENV=development -> jsxDEV(), but jsx-runtime.ts only exports jsx/jsxs/Fragment.
    jsxDev: false,
  },
  resolve: {
    alias: [
      // vite string aliases are prefix-matched (find 'react' would swallow 'react/jsx-runtime') — use an exact regex.
      { find: /^react\/jsx-dev-runtime$/, replacement: fileURLToPath(new URL("client/src/jsx-runtime.ts", import.meta.url)) },
      { find: /^react\/jsx-runtime$/, replacement: fileURLToPath(new URL("client/src/jsx-runtime.ts", import.meta.url)) },
      { find: /^react$/, replacement: fileURLToPath(new URL("client/src/host-shim.ts", import.meta.url)) },
    ],
  },
  build: {
    lib: {
      entry: fileURLToPath(new URL("client/src/entry.tsx", import.meta.url)),
      formats: ["es"],
      fileName: () => "aiti-zcode-cards.mjs",
    },
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
    minify: false,
    sourcemap: false,
    rollupOptions: {
      external: [],
    },
  },
});
