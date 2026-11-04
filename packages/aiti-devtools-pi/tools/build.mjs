#!/usr/bin/env node
/**
 * 构建 aiti-devtools-pi.js（pi 扩展单文件 bundle）：
 *   入口 src/index.ts；内联 aiti-devtools-core/aiti-devtools-agent（本仓库 packages/）
 *   外部：@earendil-works/pi-coding-agent（pi SDK）+ typebox（宿主提供）
 *
 * 用法：node tools/build.mjs [outfile]
 * 产物：dist/aiti-devtools-pi.js（独立 pi：settings.json extensions/packages 指向它，或发布为 pi package）
 * 说明：pi 扩展不内联 launcher/cockpit 资产（由独立桥 serve），故不依赖 launcher 构建产物。
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const _req = createRequire(import.meta.url);
// esbuild 由仓库根 node_modules 提供（npm i -D esbuild）；包 npm 化后各包自带 esbuild。
function loadEsbuild() {
  try { return _req("esbuild"); } catch {}
  console.error("[build-pi] 找不到 esbuild——请先在仓库根 npm i -D esbuild");
  process.exit(1);
}
const esbuild = loadEsbuild();
const outfile = process.argv[2] ? resolve(process.argv[2]) : resolve(root, "dist/aiti-devtools-pi.js");

await esbuild.build({
  entryPoints: [resolve(root, "src/index.ts")],
  bundle: true,
  format: "esm",
  outfile,
  charset: "utf8",
  platform: "node",
  target: "node20",
  logLevel: "info",
  banner: { js: "/* aiti-devtools-pi · pi 扩展（内嵌桥 + 工具直连）· 构建产物，勿手改 */" },
  external: ["@earendil-works/pi-coding-agent", "typebox"],
});
console.log("[build-pi] → " + outfile);
console.log("[build-pi] 独立 pi 安装：settings.json → \"extensions\": [\"" + outfile + "\"] 或发布为 pi package");
