/**
 * session-manager client 构建配置（Vite lib mode）——JSX 模板实例。
 *
 * client/src/entry.tsx（JSX + TS）→ 单个 ESM bundle：client/session-manager.mjs
 * （与 index.ts 的 client 字段一致；产物覆盖原手写版，源码在 git 历史可回溯）。
 *
 * 模板与原理：pi-web-ext/templates/ext-jsx-client/ + docs/aiti-ext-jsx-vite-plan.md
 *
 * SidebarClone（2026-09-06）：复制宿主 SessionSidebar.tsx 为基础——通过 `@` alias
 * 解析宿主源码模块（components/lib/hooks）。**全部 react* import 统一 alias 到
 * host-shim/jsx-runtime（委托宿主 ctx 的真 hooks/真 createElement）**——单渲染实例，
 * 避免引入 npm 真 React 的 CJS 产物（process.env 在浏览器未定义，运行时炸）。
 */
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const runtimeShim = fileURLToPath(new URL("./client/src/jsx-runtime.ts", import.meta.url));
const shim = fileURLToPath(new URL("./client/src/host-shim.ts", import.meta.url));

export default defineConfig({
  plugins: [],
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
  // 真 React 的 CJS 产物引用 process.env.NODE_ENV——浏览器无 process，需 define 替换
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    "process.env.NEXT_PUBLIC_BASE_PATH": JSON.stringify("/dev"),
    "process.env.NEXT_PUBLIC_APP_VERSION": JSON.stringify("0.0.0"),
    "process.env.NEXT_PUBLIC_PI_VERSION": JSON.stringify("0.0.0"),
  },
  resolve: {
    alias: [
      // 全部 react* → host-shim（hooks 委托宿主 ctx；jsx-runtime.ts 委托宿主 h()）
      { find: /^react\/jsx-dev-runtime$/, replacement: runtimeShim },
      { find: /^react\/jsx-runtime$/, replacement: runtimeShim },
      { find: /^react$/, replacement: shim },
      { find: /^react-dom$/, replacement: shim },
      // 注：@/ 宿主源码 alias 已废除（2026-09-06 拍板：扩展自包含，禁 import 宿主源码；
      // 旧 SidebarDock 复制链已由 sidebar/ 自包含重写取代）
    ],
  },
  build: {
    lib: {
      // 双入口（2026-09-12）：client bundle + 索引后台 worker（照 aiti-doc-center 双入口
      // 先例）。worker 线程内没有 jiti/strip-types，必须预打包成纯 .mjs 才能被 new Worker
      // 加载；产物名由 entryFileNames 定（[name].mjs → session-manager.mjs 名字不变）。
      entry: {
        "session-manager": fileURLToPath(new URL("client/src/entry.tsx", import.meta.url)),
        "index-worker": fileURLToPath(new URL("worker-src/index-worker.ts", import.meta.url)),
      },
      formats: ["es"],
    },
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
    // 薄壳拆分（2026-09-14）：chunk 由浏览器按需直接拉取（不再经宿主批量包二次
    // minify），必须自身压缩；entry 共享 chunk 同理。
    minify: true,
    sourcemap: true,
    rollupOptions: {
      // node: 内建必须 external（index-worker 用 node:sqlite/fs/worker_threads——浏览器
      // 代码无 node: import，对 client bundle 无影响）；其余 npm 包仍全部内联。
      external: [/^node:/],
      output: {
        entryFileNames: "[name].mjs",
        // ext-lazy pick 坑（2026-09-16）：chunk 若同时被静态 import（如 move-cwd-picker
        // 静态引 directory-browser）又被 lazy pick 字符串访问（sidebar-content 的
        // dirBrowserRef），rollup 默认 minifyInternalExports 会把该 chunk 导出改名成
        // A/C/D…——静态引用点会配对改写（安全），但 mod["DirectoryBrowser"] 字符串取值
        // 永远 miss → LazyMount 静默渲染 null（「添加文件夹」弹窗消失无任何报错）。
        // 关掉内部导出改名，保证 pick 字符串永远匹配源码导出名。
        minifyInternalExports: false,
      },
    },
  },
});
