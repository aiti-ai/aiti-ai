#!/usr/bin/env node
/**
 * aiti-cpu-meter · 自定打包（esbuild 组合 core + 双壳 → 两个产物）
 *
 *   client/src/internal-client.mjs  → dist/aiti-cpu-meter-client.mjs  (内部版, ESM 单文件)
 *   client/src/standalone.mjs       → dist/aiti-cpu-meter.js          (外部版, IIFE 单文件)
 *
 * 用法：node tools/build.mjs
 * esbuild 复用仓库根 node_modules（无需本扩展 npm install）。
 */
import { build } from "esbuild";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";

const root = resolve(import.meta.dirname, "..");
mkdirSync(resolve(root, "dist"), { recursive: true });

const common = { bundle: true, minify: false, sourcemap: false, target: "es2020", logLevel: "warning" };

// 内部版：pi-web 扩展 client（ESM，export default register）
await build({
  ...common,
  entryPoints: [resolve(root, "client/src/internal-client.mjs")],
  outfile: resolve(root, "dist/aiti-cpu-meter-client.mjs"),
  format: "esm",
});

// 外部版：任意网站注入（IIFE，无导出，加载即自执行）
await build({
  ...common,
  entryPoints: [resolve(root, "client/src/standalone.mjs")],
  outfile: resolve(root, "dist/aiti-cpu-meter.js"),
  format: "iife",
});

console.log("[aiti-cpu-meter] build 完成：");
console.log("  dist/aiti-cpu-meter-client.mjs（内部版 ESM）");
console.log("  dist/aiti-cpu-meter.js（外部版 IIFE）");
