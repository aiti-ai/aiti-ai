/**
 * aiti-devtools-vscode 构建脚本（esbuild，与仓库其他扩展同一工具链）
 * 产物 dist/extension.js（cjs，external vscode——由 VS Code 扩展宿主提供）
 */
import esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";

await esbuild.build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  external: ["vscode"],
  outfile: "dist/extension.js",
  sourcemap: true,
  minify: false,
  logLevel: "info",
});
console.log("[aiti-devtools-vscode] build ok → dist/extension.js");

// ---- 桥打包（扩展自带 bridge：bin + core bundle + assets——零外部依赖，开箱即用）----
// ① 刷新 core assets（launcher 等源自 inject 源；失败则用仓库现有 assets，兜底不阻塞）
spawnSync("node", ["../packages/aiti-devtools-core/tools/build-assets.mjs"], { stdio: "inherit" });
// ② vendor 布局：bin 的 core 加载器按 ../../aiti-devtools-core/dist/index.js 定位（node_modules 模式）
mkdirSync("dist/bridge/aiti-devtools-core/dist", { recursive: true });
mkdirSync("dist/bridge/aiti-bridge/bin", { recursive: true });
mkdirSync("dist/bridge-assets", { recursive: true });
await esbuild.build({
  entryPoints: ["../packages/aiti-devtools-core/src/index.ts"],
  outfile: "dist/bridge/aiti-devtools-core/dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  sourcemap: false,
  logLevel: "silent",
});
copyFileSync("../packages/aiti-bridge/bin/aiti-bridge.mjs", "dist/bridge/aiti-bridge/bin/aiti-bridge.mjs");
copyFileSync("../packages/aiti-bridge/bin/aiti-mcp-shim.cjs", "dist/bridge/aiti-mcp-shim.cjs");
for (const f of readdirSync("../packages/aiti-devtools-core/assets")) {
  copyFileSync(`../packages/aiti-devtools-core/assets/${f}`, `dist/bridge-assets/${f}`);
}
// Release scrub: internal hosts must not appear in shipped artifacts (examples use example.com;
// the public docs site aiti.pw stays).
// Upstream sources (core assets / bridge bin) stay untouched — replacement happens only in the
// vscode-ext artifact layer.
// Rules come from env AITI_SCRUB_HOSTS (JSON array of [regexSource, replacement] pairs) so no
// internal value is embedded in this source; unset or empty = no-op.
// e.g. AITI_SCRUB_HOSTS='[["([\\\\w-]+)\\\\.pi\\\\.yourhost\\\\.internal\\\\.example","$1.pi.example.com"]]'
const REDACT = process.env.AITI_SCRUB_HOSTS
  ? JSON.parse(process.env.AITI_SCRUB_HOSTS).map(([re, rep]) => [new RegExp(re, "g"), rep])
  : [];
function sweep(dir) {
  let n = 0;
  for (const name of readdirSync(dir)) {
    const p = `${dir}/${name}`;
    if (statSync(p).isDirectory()) { n += sweep(p); continue; }
    if (!/\.(html|js|mjs|cjs|json|css|txt|map)$/.test(name)) continue;
    const raw = readFileSync(p, "utf8");
    const out = REDACT.reduce((acc, [re, rep]) => acc.replace(re, rep), raw);
    if (out !== raw) { writeFileSync(p, out); n++; console.log(`[aiti-devtools-vscode] redacted ${p}`); }
  }
  return n;
}
const redacted = sweep("dist");
console.log(`[aiti-devtools-vscode] bridge vendored -> dist/bridge + dist/bridge-assets (scrubbed ${redacted} file(s))`);
