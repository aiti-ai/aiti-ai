/**
 * aiti-word-superdoc client 构建配置（Vite lib mode）。
 *
 * entry（薄壳）→ client/aiti-word-superdoc-client.mjs；
 * SuperDoc + vue + yjs 等 npm 全家 → 动态 import chunk（打开 .docx 才拉取）。
 * SuperDoc dist 把 vue/yjs external（裸说明符），必须走打包内联——Univer 同款结论：
 * node_modules 全部收进单一 chunk，防 rollup 碎片化复制模块实例。
 */
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // 相对 base：worker entry（new Worker(new URL(...))）必须相对 chunk 自身解析——
  // 扩展资产挂在 /{basePath}/api/extensions/<id>/assets/ 下，绝对 /assets/ 会打到页面根
  base: "./",
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
    lib: {
      entry: fileURLToPath(new URL("client/src/entry.ts", import.meta.url)),
      formats: ["es"],
      fileName: () => "aiti-word-superdoc-client.mjs",
    },
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
    minify: true,
    sourcemap: false,
    rollupOptions: {
      external: [],
      output: {
        chunkFileNames: "aiti-word-superdoc-chunk-[hash].mjs",
        assetFileNames: "aiti-word-superdoc-[name][extname]",
        // hex hash：默认 hash 字符集含「-」（如 chunk-C-XYOkSV），匹配不上宿主 HASHED_ASSET_RE
        // （/-[A-Za-z0-9_]{8}\.\w+$/，pi-web app/api/extensions/[...path]/route.ts）→ 13.8MB 引擎
        // chunk 进不了 immutable 缓存、每次开页都要 ETag 往返（开页方案 §2.2-5）
        hashCharacters: "hex",
        manualChunks(id) {
          if (id.includes("node_modules")) return "aiti-word-superdoc-vendor";
          return undefined;
        },
      },
    },
  },
});
