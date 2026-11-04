/**
 * aiti-word-docx-preview client 构建配置（Vite lib mode）。
 *
 * entry（薄壳）→ client/aiti-word-docx-preview-client.mjs；
 * docx-preview / jszip 走 vendor UMD 运行时懒加载（体积小，不进 bundle）。
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
      fileName: () => "aiti-word-docx-preview-client.mjs",
    },
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
    minify: true,
    sourcemap: false,
    rollupOptions: {
      external: [],
    },
  },
});
