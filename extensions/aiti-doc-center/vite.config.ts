/**
 * 扩展 client 构建配置（Vite lib mode）——JSX + npm 依赖模板。
 *
 * 把 client/src/entry.tsx（JSX + TS + npm 依赖）打包成单个 ESM bundle：
 *   client/<your-ext>.mjs
 *
 * 复制本模板到 pi-web-ext/<your-ext>/ 后，需要改：
 *   1. build.lib.fileName → "<your-ext>.mjs"（产物名，与 index.ts 的 client 字段一致）
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

// esbuild 自动 JSX 运行时按 NODE_ENV 决定发射 jsx/jsxDEV（读进程 env，不看 vite mode）——
// 本机 shell 未设 NODE_ENV 会走 dev JSX（体积翻倍 + shim 需补 jsxDEV）。这里兜底钉死 production。
process.env.NODE_ENV = "production";

// 本模板根（复制后仍指向你的扩展目录，因为文件是随扩展一起复制的）
const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  // 显式 production：防环境变量缺失时 esbuild 走 jsxDEV（dev JSX 体积翻倍）
  mode: "production",
  esbuild: {
    jsxDev: false,
  },
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
      entry: {
        // 浏览器弹窗 bundle（= index.ts 的 client 字段）
        "aiti-doc-center-client": fileURLToPath(new URL("client/src/entry.tsx", import.meta.url)),
        // 索引 Worker（node:sqlite 同步 API 真后台；主线程只做查询，§10.2 教训）
        "doc-worker": fileURLToPath(new URL("worker-src/doc-worker.ts", import.meta.url)),
      },
      formats: ["es"],
    },
    outDir: "dist", // 产物直接进 client/（deploy 递归拷贝；worker 由 index.ts 经 Worker 线程加载）
    emptyOutDir: true, // 别清掉同目录的手写/其他文件
    target: "es2020",
    minify: false, // 便于阅读/调试
    sourcemap: false,
    rollupOptions: {
      // npm 依赖全部内联；node: 内建保持导入（Worker 在 Node 里跑）
      external: [/^node:/],
      output: { entryFileNames: "[name].mjs" },
    },
  },
});
