#!/usr/bin/env node
/**
 * aiti-editor · vendored 库版本一致性检查（防漂移）
 *
 * 运行时用自托管 vendor 产物（`<script>` 全局对象），而 node_modules 里同名包可能被
 * monaco-editor 等 transitively 钉在别的版本上——二者漂移会让「声明版本 ≠ 运行时版本」，
 * 埋隐患。本检查逐项读 vendor 产物版本，与 package.json devDependencies 声明比对；
 * 不一致即 FAIL（部署前拦截）：
 *   - vendor/marked.min.js   ← devDependencies.marked   （头注释 marked vX.Y.Z）
 *   - vendor/mermaid.min.js  ← devDependencies.mermaid  （esbuild 产物内 version:"X.Y.Z"）
 *
 * 用法：node tools/check-vendor-version.mjs   （或 npm run check:vendor）
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

// 归一化声明版本（可能带 ^/~/范围），取精确段
const normalize = (v) => String(v || "").replace(/[\^~>=<| ]+/g, "").split(",")[0].trim();

const CHECKS = [
  {
    name: "marked",
    file: "vendor/marked.min.js",
    declared: pkg.devDependencies?.marked,
    // 版本头形如：  * marked v15.0.12 - a markdown parser
    rx: /marked v(\d+\.\d+\.\d+)/,
  },
  {
    name: "mermaid",
    file: "vendor/mermaid.min.js",
    declared: pkg.devDependencies?.mermaid,
    // esbuild UMD 产物无头注释，但内部有 version:"11.16.1" 字段
    rx: /version:"(\d+\.\d+\.\d+)"/,
  },
];

let failed = false;
for (const c of CHECKS) {
  let vendorText = "";
  try {
    vendorText = readFileSync(resolve(root, c.file), "utf8");
  } catch {
    console.error(`[check-vendor] FAIL：${c.file} 不存在`);
    failed = true;
    continue;
  }
  const m = vendorText.match(c.rx);
  if (!m) {
    console.error(`[check-vendor] FAIL：${c.file} 解析不出版本号（匹配模式 ${c.rx} 落空？）`);
    failed = true;
    continue;
  }
  const vendor = m[1];
  const declaredNorm = normalize(c.declared);
  if (!declaredNorm) {
    console.error(`[check-vendor] FAIL：package.json 未声明 devDependencies.${c.name}（请显式钉到 vendored 版本）`);
    failed = true;
    continue;
  }
  if (vendor !== declaredNorm) {
    console.error(`[check-vendor] FAIL：版本漂移（${c.name}）\n  ${c.file} = ${vendor}\n  package.json ${c.name} = ${declaredNorm}`);
    console.error(`  处理：要么把 package.json 的 ${c.name} 钉到 '${vendor}'，要么同步 ${c.file}（npm install 后从 node_modules/${c.name}/dist 拷贝）`);
    failed = true;
    continue;
  }
  console.log(`[check-vendor] OK：${c.file} v${vendor} === package.json ${c.name} ${declaredNorm}`);
}

if (failed) process.exit(1);
