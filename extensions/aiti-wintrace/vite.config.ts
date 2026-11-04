/**
 * 扩展 client 构建配置（Vite lib mode）——JSX + npm 依赖模板。
 *
 * 把 client/src/entry.tsx（JSX + TS + npm 依赖）打包成单个 ESM bundle：
 *   client/aiti-wintrace-client.mjs
 *
 * 复制本模板到 pi-web-ext/<your-ext>/ 后，需要改：
 *   1. build.lib.fileName → "aiti-wintrace-client.mjs"（产物名，与 index.ts 的 client 字段一致）
 *   2. 想用 npm 包 → 加进 package.json dependencies（构建时内联，浏览器不需要 node_modules）
 *
 * 三个必踩的坑（都已实测修好，勿回退）：
 *   1. esbuild.jsx 必须 "automatic"：vite 默认 classic → 转成 React.createElement，
 *      产物里 React 未定义 → 浏览器 ReferenceError。
 *   2. alias 用正则精确匹配：vite 字符串 alias 是前缀匹配（find "react" 会吞掉
 *      "react/jsx-runtime"），必须 /^react$/ 与 /^react\/jsx-runtime$/ 分开。
 *   3. rollupOptions.external 必须 []：vite lib mode 默认把 dependencies 外部化，
 *      浏览器 import 不了裸 npm 包 → 显式清空强制内联。
 *
 * 构建：npm run build:client      （或 npm run watch 自动重建，配前端 rev poller = HMR）
 */
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// 本模板根（复制后仍指向你的扩展目录，因为文件是随扩展一起复制的）
const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  // JSX 自动运行时：JSX 转成 jsx(type, props) 并从 react/jsx-runtime 导入
  // （resolve.alias 把 react/jsx-runtime 指到 client/src/jsx-runtime.ts → host-shim）。
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
  resolve: {
    alias: [
      // 注意：vite 的字符串 alias 是前缀匹配（find 'react' 会吞掉 'react/jsx-runtime'），
      // 所以用正则精确匹配包名。react → host-shim（模块级 ctx 委托；不打包 react）。
      { find: /^react\/jsx-dev-runtime$/, replacement: fileURLToPath(new URL("client/src/jsx-runtime.ts", import.meta.url)) },
      { find: /^react\/jsx-runtime$/, replacement: fileURLToPath(new URL("client/src/jsx-runtime.ts", import.meta.url)) },
      { find: /^react$/, replacement: fileURLToPath(new URL("client/src/host-shim.ts", import.meta.url)) },
    ],
  },
  build: {
    lib: {
      entry: fileURLToPath(new URL("client/src/entry.tsx", import.meta.url)),
      formats: ["es"],
      fileName: () => "aiti-wintrace-client.mjs", // ← 改成你的扩展产物名（= index.ts 的 client 字段）
    },
    outDir: "dist", // 产物直接进 client/（index.ts 的 client 字段指向它）
    emptyOutDir: true, // 别清掉同目录的手写/其他文件
    target: "es2020",
    minify: false, // 便于阅读/调试
    sourcemap: false,
    rollupOptions: {
      // 关键：不外部化任何依赖（npm 包全部内联进单个 .mjs）
      external: [],
    },
  },
});
