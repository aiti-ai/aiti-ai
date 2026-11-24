/**
 * aiti-plan-first client 构建配置（Vite lib mode）—— git-trace 模板实例。
 *
 * client/src/entry.tsx（JSX + TS）→ 单个 ESM bundle：client/aiti-plan-first-client.mjs
 * 三个必踩的坑（模板已修好，勿回退）：jsx automatic / 正则 alias / external []。
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
      fileName: () => "aiti-plan-first-client.mjs",
    },
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
    minify: false,
    sourcemap: false,
    rollupOptions: { external: [] },
  },
});
