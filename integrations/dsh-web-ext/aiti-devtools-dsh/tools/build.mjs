#!/usr/bin/env node
/**
 * 构建 @aiti-ai/aiti-devtools-dsh 双面产物：
 *   lib/index.js   —— host 面（node；桥 + 工具注册，进 Loader）—— 由 dist/aiti-devtools-dsh.js 拷贝（内嵌 @aiti-ai/*）
 *   lib/client.js  —— browser 面（dsh.client；被 client-modules serve 给浏览器）—— 外部 @deepseek-ai/dsh-client-*
 * 用法：node tools/build.mjs
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const _req = createRequire(import.meta.url);
function loadEsbuild() {
  try { return _req("esbuild"); } catch {}
  console.error("[build-dsh] 找不到 esbuild——请先在仓库根 npm i -D esbuild");
  process.exit(1);
}
const esbuild = loadEsbuild();
// 确保 lib/ 存在（双面产物目录）
mkdirSync(resolve(root, "lib"), { recursive: true });

// host 面：bundle dist/aiti-devtools-dsh.js（inlined @aiti-ai/*）→ lib/index.js
await esbuild.build({
  entryPoints: [resolve(root, "src/index.ts")],
  bundle: true, format: "esm", outfile: resolve(root, "dist/aiti-devtools-dsh.js"),
  charset: "utf8", platform: "node", target: "node22", logLevel: "info",
  external: ["@deepseek-ai/*"],
  banner: { js: "/* @aiti-ai/aiti-devtools-dsh · host 面（内嵌 @aiti-ai/*，@deepseek-ai/* 外部）· 勿手改 */" },
});
copyFileSync(resolve(root, "dist/aiti-devtools-dsh.js"), resolve(root, "lib/index.js"));
console.log("[build-dsh] → lib/index.js (host)");

// client 面：lib/client.js（DSH client bundle 格式：__ModuleLoader__.load({id, factory:(require)=>{CJS}})，外部 @deepseek-ai/dsh-client-* 由 factory 的 require 解析）
const cjs = await esbuild.build({
  entryPoints: [resolve(root, "src/client/index.ts")],
  bundle: true, format: "cjs", write: false,
  external: ["react", "react-dom", "@deepseek-ai/*"],
  platform: "browser", target: "es2022",
})
const body = cjs.outputFiles[0].text
const wrapped = `window.__ModuleLoader__.load({\n  id: \"@aiti-ai/aiti-devtools-dsh\",\n  factory: (require) => {\nvar module = { exports: {} };\nvar exports = module.exports;\n${body}\nreturn module.exports;\n  },\n});\n`
writeFileSync(resolve(root, "lib/client.js"), wrapped)
console.log("[build-dsh] → lib/client.js (client)");
