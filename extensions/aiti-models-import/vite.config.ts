/**
 * aiti-models-import · client 构建配置（Vite lib mode，模板 ext-jsx-client 同款）
 *
 * 产物 dist/aiti-models-import.mjs（= index.ts 的 client 字段）。
 * 坑见模板 vite.config.ts（jsx automatic / 正则 alias / external 清空），此处不赘。
 */
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
    // Production lib bundle: never let the JSX runtime follow the build shell's NODE_ENV.
    // Vite infers jsxDev from NODE_ENV; a build from a dev-instance shell inherits
    // NODE_ENV=development -> jsxDEV(), but jsx-runtime.ts only exports jsx/jsxs/Fragment.
    jsxDev: false,
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
      fileName: () => "aiti-models-import.mjs",
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
