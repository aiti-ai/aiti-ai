#!/usr/bin/env node
/**
 * aiti-cmd · 构建 client bundle（esbuild 打包 xterm.js + fit addon → dist/aiti-cmd-client.mjs）
 *
 * 用法：node tools/build-client.mjs
 */
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { build } = require("esbuild");

// esbuild 从仓库根 node_modules 解析（node 向上查找）
function resolveEsbuild() {
  try { return require("esbuild"); } catch {}
  throw new Error("esbuild 未找到——请在仓库根 npm i -D esbuild");
}

await resolveEsbuild().build({
  entryPoints: ["client/src/index.js"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2020"],
  loader: { ".css": "text" },
  outfile: "dist/aiti-cmd-client.mjs",
  logLevel: "warning",
  banner: { js: "// aiti-cmd client bundle — built by tools/build-client.mjs (esbuild). Do not edit." },
});
console.log("[aiti-cmd] client bundle → dist/aiti-cmd-client.mjs");

// post-build patch：xterm 6.0.0 RenderService.dimensions getter 对 _renderer.value（Optional）
// 无空值防护——terminal dispose 后（renderer 已清）排在 RenderDebouncer 里的 rAF 回调
// 仍会执行 Viewport._sync → 读 _renderService.dimensions → 崩
// 「Cannot read properties of undefined (reading 'dimensions')」（上游 master 仍未修，无补丁版）。
// 修法：getter 加 ?.；Viewport _sync/_handleScroll 的 !this._renderService 守卫追加 .dimensions 判空。
// 属性名不被 esbuild 混淆，匹配对压缩产物稳定；替换次数断言保证上游变化时 fail loudly 不静默失效。
{
  const outfile = "dist/aiti-cmd-client.mjs";
  let s = readFileSync(outfile, "utf8");
  const A = "return this._renderer.value.dimensions;";
  const A2 = "return this._renderer.value?.dimensions;";
  const B = "!this._renderService ||";
  const B2 = "!this._renderService?.dimensions ||";
  const cA = s.split(A).length - 1, cB = s.split(B).length - 1;
  if (cA !== 1 || cB !== 2) {
    console.error(`[aiti-cmd][patch] 匹配数不符：getter×${cA}（期望1） guard×${cB}（期望2）——xterm 上游形态变了，人工核对后调整 patch，产物保持未写`);
    process.exit(1);
  }
  s = s.split(A).join(A2).split(B).join(B2);
  writeFileSync(outfile, s);
  console.log("[aiti-cmd][patch] xterm dimensions 空值防护已应用（getter×1, guard×2）");
}
