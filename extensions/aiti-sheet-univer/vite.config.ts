/**
 * aiti-sheet-univer client 构建配置（Vite lib mode）。
 *
 * entry（薄壳）→ client/aiti-sheet-univer-client.mjs；
 * Univer + react + react-dom（真实 npm ESM，单实例）→ 动态 import chunk（打开表格才拉）。
 * 不做 react→host-shim alias：本扩展视图为纯 DOM，Univer 内部 React 树自包含。
 */
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
    lib: {
      entry: fileURLToPath(new URL("client/src/entry.ts", import.meta.url)),
      formats: ["es"],
      fileName: () => "aiti-sheet-univer-client.mjs",
    },
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
    minify: true,
    sourcemap: false,
    rollupOptions: {
      external: [],
      output: {
        chunkFileNames: "aiti-sheet-univer-chunk-[hash].mjs",
        assetFileNames: "aiti-sheet-univer-[name][extname]",
        // node_modules 全部收进单一 chunk：rollup 碎片化会把同一模块复制进多份，
        // Univer/redi 的 DI 标识符（createIdentifier）随模块实例分裂 → 解析失败
        manualChunks(id) {
          if (id.includes("node_modules")) return "aiti-sheet-univer-vendor";
          return undefined;
        },
      },
    },
  },
});
