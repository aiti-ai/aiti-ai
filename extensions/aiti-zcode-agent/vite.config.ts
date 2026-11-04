/**
 * 扩展 client 构建配置（Vite lib mode）——aiti-zcode-agent 专属能力卡。
 *
 * 产物 dist/aiti-zcode-cards.mjs（= index.ts 的 client 字段）。
 * 三个必踩的坑与规避同 aiti-recovery 模板（jsx automatic / 正则精确 alias / external []）。
 */
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
  resolve: {
    alias: [
      // vite 字符串 alias 是前缀匹配（find 'react' 会吞掉 'react/jsx-runtime'），必须正则精确匹配。
      { find: /^react\/jsx-dev-runtime$/, replacement: fileURLToPath(new URL("client/src/jsx-runtime.ts", import.meta.url)) },
      { find: /^react\/jsx-runtime$/, replacement: fileURLToPath(new URL("client/src/jsx-runtime.ts", import.meta.url)) },
      { find: /^react$/, replacement: fileURLToPath(new URL("client/src/host-shim.ts", import.meta.url)) },
    ],
  },
  build: {
    lib: {
      entry: fileURLToPath(new URL("client/src/entry.tsx", import.meta.url)),
      formats: ["es"],
      fileName: () => "aiti-zcode-cards.mjs",
    },
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
    minify: false,
    sourcemap: false,
    rollupOptions: {
      external: [],
    },
  },
});
