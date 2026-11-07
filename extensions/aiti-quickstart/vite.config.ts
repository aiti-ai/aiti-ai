/**
 * aiti-quickstart client 构建配置（Vite lib mode）——JSX 模板实例。
 *
 * client/src/entry.tsx（JSX + TS）→ 单个 ESM bundle：dist/aiti-quickstart-client.mjs
 * （与 index.ts 的 client 字段一致）。
 *
 * 模板与原理：pi-web-ext/templates/ext-jsx-client/ + docs/aiti-ext-jsx-vite-plan.md
 * 三个必踩的坑（模板已修好，勿回退）：jsx automatic / 正则 alias / external []。
 * react → client/src/host-shim.ts（委托宿主渲染原语；跨 bundle 服务交付的组件与
 * session-manager 树同属宿主单 React 实例）。
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
      { find: /^react-dom$/, replacement: fileURLToPath(new URL("client/src/host-shim.ts", import.meta.url)) },
      { find: /^react$/, replacement: fileURLToPath(new URL("client/src/host-shim.ts", import.meta.url)) },
    ],
  },
  build: {
    lib: {
      entry: fileURLToPath(new URL("client/src/entry.tsx", import.meta.url)),
      formats: ["es"],
      fileName: () => "aiti-quickstart-client.mjs",
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
