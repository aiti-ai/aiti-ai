/**
 * aiti-onlyoffice client 构建配置（Vite lib mode）。
 *
 * entry（薄壳）→ client/aiti-onlyoffice-client.mjs；
 * DS api.js 由浏览器侧 <script> 从 DocumentServer 动态加载（不进 bundle）。
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
      fileName: () => "aiti-onlyoffice-client.mjs",
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
