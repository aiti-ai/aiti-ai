/**
 * aiti-msg-nav · client 构建配置（Vite lib mode，参考 pi-web-ext/demo）。
 *
 * 把 client/src/entry.tsx（JSX + TS）打包成单个 ESM bundle：client/aiti-msg-nav-client.mjs
 * （index.ts 的 client 字段指向它）。
 *  - lib mode（formats: ['es']）：产物是一个 register(ctx) 函数，宿主 ExtSlots 动态 import。
 *  - react 重定向：JSX 自动运行时默认 import "react/jsx-runtime"，扩展 client 不引入
 *    React——resolve.alias 指到 client/src/host-shim.ts / jsx-runtime.ts，所有 hooks 委托
 *    宿主 register(ctx) 传入的 h/useState/…。产物零 React 引用。
 *
 * 构建：npm run build:client   （或 node tools/build-client.mjs）
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
      // 正则精确匹配包名（字符串 alias 前缀匹配会吞掉 react/jsx-runtime）
      { find: /^react\/jsx-dev-runtime$/, replacement: fileURLToPath(new URL("client/src/jsx-runtime.ts", import.meta.url)) },
      { find: /^react\/jsx-runtime$/, replacement: fileURLToPath(new URL("client/src/jsx-runtime.ts", import.meta.url)) },
      { find: /^react$/, replacement: fileURLToPath(new URL("client/src/host-shim.ts", import.meta.url)) },
    ],
  },
  build: {
    lib: {
      entry: fileURLToPath(new URL("client/src/entry.tsx", import.meta.url)),
      formats: ["es"],
      fileName: () => "aiti-msg-nav-client.mjs",
    },
    outDir: "dist",
    emptyOutDir: true, // 别清掉 client/src（源码）
    target: "es2020",
    minify: false,
    sourcemap: false,
    rollupOptions: {
      // 本扩展无外部 npm 依赖；全部内联进单个 .mjs
      external: [],
    },
  },
});