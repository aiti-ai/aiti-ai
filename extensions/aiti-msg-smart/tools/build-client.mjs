#!/usr/bin/env node
/**
 * aiti-msg-smart · 构建 client bundle（esbuild → client/aiti-msg-smart-client.mjs）
 *
 * 用法：node tools/build-client.mjs
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

function resolveEsbuild() {
  try { const mod = require("esbuild"); if (mod && typeof mod.build === "function") return mod; } catch {}
  throw new Error("esbuild 未找到——请在仓库根 npm i -D esbuild");
}

const { build } = resolveEsbuild();

await resolveEsbuild().build({
  entryPoints: ["client/src/index.js"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2020"],
  outfile: "dist/aiti-msg-smart-client.mjs",
  logLevel: "warning",
  banner: { js: "// aiti-msg-smart client bundle — built by tools/build-client.mjs (esbuild). Do not edit." },
});
console.log("[aiti-msg-smart] client bundle → client/aiti-msg-smart-client.mjs");