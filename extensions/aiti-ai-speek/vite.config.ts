/**
 * aiti-ai-speek client 构建配置（Vite lib mode）——JSX 模板实例。
 * 三个必踩的坑（模板已修好，勿回退）：jsx automatic / 正则 alias / external []。
 */
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// esbuild 自动 JSX 运行时按 NODE_ENV 决定发射 jsx/jsxDEV（读进程 env，不看 vite mode）——
// 本机 shell 未设 NODE_ENV 会走 dev JSX（体积翻倍 + shim 需补 jsxDEV）。这里兜底钉死 production。
process.env.NODE_ENV = "production";

export default defineConfig({
  // 显式 production：防环境变量缺失时 esbuild 走 jsxDEV（dev JSX 体积翻倍）
  mode: "production",
  esbuild: {
    jsxDev: false,
  },
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
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
      fileName: () => "aiti-ai-speek-client.mjs",
    },
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
    // 薄壳拆分（2026-09-14）：chunk 由浏览器按需直接拉取（不再经宿主批量包二次
    // minify），必须自身压缩；entry 共享 chunk 同理。
    minify: true,
    sourcemap: false,
    rollupOptions: {
      external: [],
    },
  },
});
