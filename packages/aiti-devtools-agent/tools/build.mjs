#!/usr/bin/env node
/**
 * 构建 @aiti-ai/aiti-devtools-agent（多 agent 接线层）→ dist/index.js（ESM bundle）。
 *   主入口 AgentBridgeClient + AgentHost + mapBridgeTools/wrapToolResult 全内联；node 环境（fetch 为全局）。
 *   可选子路径 ./schema（jsonSchemaToTypeBox）依赖 typebox（宿主提供），单独从 src/schema.ts 导出，不并入主 bundle。
 * 用法：node tools/build.mjs [outfile]
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const _req = createRequire(import.meta.url);
function loadEsbuild() {
  try { return _req("esbuild"); } catch {}
  console.error("[build-agent] 找不到 esbuild——请先在仓库根 npm i -D esbuild");
  process.exit(1);
}
const esbuild = loadEsbuild();
const outfile = process.argv[2] ? resolve(process.argv[2]) : resolve(root, "dist/index.js");

await esbuild.build({
  entryPoints: [resolve(root, "src/index.ts")],
  bundle: true,
  format: "esm",
  outfile,
  charset: "utf8",
  platform: "node",
  target: "node18",
  logLevel: "info",
  banner: { js: "/* @aiti-ai/aiti-devtools-agent · 多 agent 接线层 · 构建产物，勿手改 */" },
});
console.log("[build-agent] → " + outfile);
