#!/usr/bin/env node
// inject-vendor-deps.mjs —— 把 package.json 的 @aiti-ai/* 依赖改写为 vendor tgz 的 file: 引用
// （npmjs 无该 scope、CI 私源不可达场景的构建期注入；发布内容须还原，见调用方）。
// 用法：node scripts/inject-vendor-deps.mjs <package.json> <vendorDir>
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const [pjPath, vendorDir] = process.argv.slice(2);
if (!pjPath || !vendorDir) {
  console.error("用法: node inject-vendor-deps.mjs <package.json> <vendorDir>");
  process.exit(1);
}
const p = JSON.parse(readFileSync(pjPath, "utf8"));
const map = {};
for (const t of readdirSync(vendorDir).filter((f) => f.endsWith(".tgz"))) {
  const out = execSync(`tar xzf ${JSON.stringify(join(vendorDir, t))} -O package/package.json`, {
    encoding: "utf8", shell: true,
  });
  map[JSON.parse(out).name] = `file:${join(vendorDir, t)}`;
}
const changed = [];
for (const sec of [p.dependencies, p.devDependencies, p.peerDependencies]) {
  if (!sec) continue;
  for (const name of Object.keys(sec)) {
    if (map[name]) { sec[name] = map[name]; changed.push(name); }
  }
}
// 传递依赖闭环：file: tgz 自身的 @aiti-ai/* deps 仍走 registry——overrides 整体钉住。
// override 值与直接依赖改写值一致 → 无 EOVERRIDE
if (Object.keys(map).length) p.overrides = Object.fromEntries(Object.entries(map));
if (changed.length) writeFileSync(pjPath, JSON.stringify(p, null, 2) + "\n");
console.log(`[inject] ${pjPath}: ${changed.length ? "改写 " + changed.join(", ") : "无 @aiti-ai/* deps"}`);
