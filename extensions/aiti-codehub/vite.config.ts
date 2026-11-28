/**
 * Client bundle build (vite lib mode). JSX is transformed with the automatic runtime
 * and `react` / `react/jsx-runtime` are aliased to the host shim, so the bundle has
 * zero React references and runs on the host's renderer.
 */
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  esbuild: { jsx: "automatic", jsxImportSource: "react" },
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
      fileName: () => "aiti-codehub-client.mjs",
    },
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
    minify: false,
    sourcemap: false,
    rollupOptions: { external: [] },
  },
});
