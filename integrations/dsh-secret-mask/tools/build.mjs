#!/usr/bin/env node
/**
 * 构建 @aiti-ai/dsh-secret-mask：src/index.ts → lib/index.js（host 面，esbuild
 * bundle；@deepseek-ai/* 外部由 DSH 运行时解析，core/ 内嵌）。纯 host 插件，
 * 无 client 面。用法：node tools/build.mjs
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const _req = createRequire(import.meta.url);
function loadEsbuild() {
  try { return _req("esbuild"); } catch {}
  console.error("[build] esbuild not found — run `npm i -D esbuild` at the repo root first");
  process.exit(1);
}
const esbuild = loadEsbuild();
mkdirSync(resolve(root, "lib"), { recursive: true });

await esbuild.build({
  entryPoints: [resolve(root, "src/index.ts")],
  bundle: true,
  format: "esm",
  outfile: resolve(root, "lib/index.js"),
  charset: "utf8",
  platform: "node",
  target: "node22",
  logLevel: "info",
  external: ["@deepseek-ai/*"],
  banner: { js: "/* @aiti-ai/dsh-secret-mask · host bundle (core inlined, @deepseek-ai/* external) · do not edit */" },
});
console.log("[build] → lib/index.js (host)");
