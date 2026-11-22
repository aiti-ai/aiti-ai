#!/usr/bin/env node
/**
 * 构建 aiti-devtools 浏览器注入产物（单文件 iife 注入脚本）：
 *   - aiti-launcher.js  入口 src/standalone.js（自动 boot + aiUrl 推断）
 *   - bridge-client.js  通用桥客户端（src/mcp/bridge-client.js）
 *   - cdp-core.js       self-exec 执行核心（src/client/cdp-core.js）
 *
 * client 经 virtual:dbg-client 打包注入（与 vite dbgClientPlugin 同逻辑）。
 * 产物 dist/ 供 core/assets（packages/aiti-devtools-core/tools/build-assets.mjs 拷贝）与独立桥 serve。
 *
 * 用法：node tools/build.mjs [outfile]
 */
import { resolve, dirname } from "node:path";
import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const _req = createRequire(import.meta.url);
// esbuild 由仓库根 node_modules 提供（npm i -D esbuild）；包 npm 化后各包自带 esbuild。
function loadEsbuild() {
  try { return _req("esbuild"); } catch {}
  console.error("[build-inject] 找不到 esbuild——请先在仓库根 npm i -D esbuild");
  process.exit(1);
}
const esbuild = loadEsbuild();
const outfile = process.argv[2] ? resolve(process.argv[2]) : resolve(root, "dist/aiti-launcher.js");

// 与 vite dbgClientPlugin 相同的 client 打包（iife 单文件字符串）
const clientResult = esbuild.buildSync({
  entryPoints: [resolve(root, "src/client/index.js")],
  bundle: true,
  format: "iife",
  write: false,
  minify: false,
  charset: "utf8",
  target: "es2017",
  logLevel: "error",
});
const clientCode = clientResult.outputFiles[0].text;

await esbuild.build({
  entryPoints: [resolve(root, "src/standalone.js")],
  bundle: true,
  format: "iife",
  outfile,
  charset: "utf8",
  target: "es2017",
  logLevel: "info",
  banner: { js: "/* aiti-devtools launcher · 单文件注入版（构建产物，勿手改）*/" },
  plugins: [{
    name: "dbg-client-virtual",
    setup(b) {
      b.onResolve({ filter: /^virtual:dbg-client$/ }, () => ({ path: "dbg-client", namespace: "dbg" }));
      b.onLoad({ filter: /.*/, namespace: "dbg" }, () => ({
        contents: `export const MINI_DBG_CLIENT = ${JSON.stringify(clientCode)};`,
        loader: "js",
      }));
    },
  }],
});
console.log("[build-inject] → " + outfile);

// 拷贝 bridge-client.js（通用桥客户端）+ cdp-core.js（self-exec 执行核心）到产物目录
const outDir = resolve(outfile, "..");
for (const [f, name] of [["src/mcp/bridge-client.js", "bridge-client.js"], ["src/client/cdp-core.js", "cdp-core.js"]]) {
  try {
    copyFileSync(resolve(root, f), resolve(outDir, name));
    console.log("[build-inject] 拷贝 → " + resolve(outDir, name));
  } catch (e) { console.error("[build-inject] ⚠ 拷贝失败 " + f + ": " + e.message); }
}
