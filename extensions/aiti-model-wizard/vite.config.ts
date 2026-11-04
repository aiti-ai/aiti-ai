/**
 * aiti-model-wizard client 构建配置（Vite lib mode）——JSX 模板实例。
 *
 * client/src/entry.tsx（JSX + TS）→ 单个 ESM bundle：client/aiti-model-wizard-client.mjs
 * （与 index.ts 的 client 字段一致；产物覆盖原手写版，源码在 git 历史可回溯）。
 * 模板与原理：pi-web-ext/templates/ext-jsx-client/ + docs/aiti-ext-jsx-vite-plan.md
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
      // 正则精确匹配（字符串 alias 是前缀匹配，find 'react' 会吞掉 'react/jsx-runtime'）
      { find: /^react\/jsx-dev-runtime$/, replacement: fileURLToPath(new URL("client/src/jsx-runtime.ts", import.meta.url)) },
      { find: /^react\/jsx-runtime$/, replacement: fileURLToPath(new URL("client/src/jsx-runtime.ts", import.meta.url)) },
      { find: /^react$/, replacement: fileURLToPath(new URL("client/src/host-shim.ts", import.meta.url)) },
    ],
  },
  build: {
    lib: {
      entry: fileURLToPath(new URL("client/src/entry.tsx", import.meta.url)),
      formats: ["es"],
      fileName: () => "aiti-model-wizard-client.mjs",
    },
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
    minify: false,
    sourcemap: false,
    rollupOptions: {
      external: [], // npm 包全部内联进单个 .mjs
    },
  },
});
