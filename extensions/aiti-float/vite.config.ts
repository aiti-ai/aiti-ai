/**
 * aiti-float client 构建配置（Vite lib mode）——TS 模板实例。
 *
 * client/src/entry.ts → 单个 ESM bundle：client/aiti-float-client.mjs
 * （与 index.ts 的 client 字段一致；产物覆盖原手写版，源码在 git 历史可回溯）。
 * 本扩展无 JSX/React 组件，无需 react alias；其余与 templates/ext-jsx-client 同构。
 */
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  build: {
    lib: {
      entry: fileURLToPath(new URL("client/src/entry.ts", import.meta.url)),
      formats: ["es"],
      fileName: () => "aiti-float-client.mjs",
    },
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
    minify: false,
    sourcemap: false,
    rollupOptions: {
      external: [], // npm 包全部内联进单个 .mjs
    },
  },
});
