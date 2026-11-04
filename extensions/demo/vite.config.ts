/**
 * demo 扩展 client 构建配置（Vite lib mode）。
 *
 * 把 client/src/entry.tsx（JSX + TS + npm 依赖）打包成单个 ESM bundle：
 *   client/demo-jsx.mjs
 *
 * 关键点：
 *  - 不是构建"前端应用"，而是构建"扩展 client 模块"（一个 register(ctx) 函数），
 *    所以用 lib mode（formats: ['es']），产物被宿主 ExtSlots 动态 import()。
 *  - react 重定向：JSX 自动运行时默认 import "react/jsx-runtime"，但扩展 client
 *    不引入 React——经 resolve.alias 指到 client/src/host-shim.ts / jsx-runtime.ts，
 *    所有 hooks 委托宿主 register(ctx) 传入的 h/useState/…。产物零 React 引用。
 *  - 依赖内联：lib mode 默认把 package.json dependencies 外部化（浏览器 import
 *    不了裸 npm 包），这里显式 external: [] 强制 qrcode 等全部打进产物。
 *
 * 构建：npm run build:client    （或 node tools/build-client.mjs 包装）
 */
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  // JSX 自动运行时：JSX 转成 jsx(type, props) 并从 react/jsx-runtime 导入
  // （resolve.alias 把 react/jsx-runtime 指到 client/src/jsx-runtime.ts → host-shim）。
  // 不配的话 vite 默认 classic 模式转成 React.createElement，产物里 React 未定义。
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
    // 显式关 dev 运行时：vite 按 NODE_ENV 推 jsxDev，从 dev 实例 shell 里跑 build 会
    // 继承 NODE_ENV=development → 转成 jsxDEV()，而 jsx-runtime.ts 桩只导出 jsx/jsxs/
    // Fragment（构建即红，产物亦坏）。产物是常驻 bundle，不该随构建环境换运行时。
    jsxDev: false,
  },
  resolve: {
    alias: [
      // 注意：vite 的字符串 alias 是前缀匹配（find 'react' 会吞掉 'react/jsx-runtime'），
      // 所以用正则精确匹配包名。react / react/jsx-runtime → host-shim（模块级 ctx 委托）。
      { find: /^react\/jsx-dev-runtime$/, replacement: fileURLToPath(new URL("client/src/jsx-runtime.ts", import.meta.url)) },
      { find: /^react\/jsx-runtime$/, replacement: fileURLToPath(new URL("client/src/jsx-runtime.ts", import.meta.url)) },
      { find: /^react$/, replacement: fileURLToPath(new URL("client/src/host-shim.ts", import.meta.url)) },
    ],
  },
  build: {
    lib: {
      entry: fileURLToPath(new URL("client/src/entry.tsx", import.meta.url)),
      formats: ["es"],
      fileName: () => "demo-jsx.mjs",
    },
    outDir: "dist", // 产物直接进 client/（index.ts 的 client 字段指向它）
    emptyOutDir: true, // 别清掉同目录的手写 demo-client.mjs / src/
    target: "es2020",
    minify: false, // 便于阅读/调试
    sourcemap: false,
    rollupOptions: {
      // 关键：不外部化任何依赖（qrcode 等全部内联进单个 .mjs）
      external: [],
    },
  },
});
