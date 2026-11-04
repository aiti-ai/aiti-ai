#!/usr/bin/env node
// gen-deps.mjs —— S3 扩展依赖矩阵自动生成（aiti-docker-image-plan §7.2）
// 扫全部扩展 package.json 的 `aiti` 元数据块 → 汇总 full 层系统依赖清单（Dockerfile.full
// 追加层的自动生成源；§2.2 手写清单降级为校验基准）。元数据缺省 = 声明「零系统依赖」。
//
// 用法：node docker/scripts/gen-deps.mjs [pi-web-ext 目录]
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? new URL("../../pi-web-ext/", import.meta.url).pathname;
const entries = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
// 计数口径 = 有 package.json 的目录（_shared/templates 等基建目录天然无 package.json 被排除，
// 对任意自定义扫描目录也正确——原版硬编码 -5 在自定义目录上会变负数）
const candidates = entries.filter((name) => existsSync(join(root, name, "package.json")));

const byPlatform = { "linux-apt": new Map(), windows: new Map(), darwin: new Map() };
const services = [];
const tiers = { core: [], full: [] };
let declared = 0;

for (const name of entries) {
  const pkgPath = join(root, name, "package.json");
  if (!existsSync(pkgPath)) continue;
  let pkg;
  try { pkg = JSON.parse(readFileSync(pkgPath, "utf8")); } catch { continue; }
  const meta = pkg.aiti;
  if (!meta) continue; // 缺省 = 零系统依赖（S3 规则）
  declared++;
  (tiers[meta.tier ?? "core"] ??= []).push(name);
  for (const [platform, deps] of Object.entries(meta.systemDeps ?? {})) {
    const bucket = byPlatform[platform];
    if (!bucket) continue;
    const list = Array.isArray(deps) ? deps : depsList(deps); // windows 档：[{winget,choco}] 或 [str]
    for (const d of list) {
      const key = typeof d === "string" ? d : d.winget ?? d.choco ?? JSON.stringify(d);
      if (!bucket.has(key)) bucket.set(key, []);
      bucket.get(key).push(name);
    }
  }
  for (const s of meta.services ?? []) services.push({ ext: name, ...s });
}

function depsList(deps) {
  if (Array.isArray(deps)) return deps;
  return Object.entries(deps).map(([k, v]) => ({ [k]: v }));
}

console.log(`# 扩展依赖矩阵（gen-deps 自动生成 @ ${new Date().toISOString().slice(0, 10)}）`);
console.log(`# 声明 aiti 元数据的扩展：${declared}/${candidates.length}（缺省=零依赖）`);
for (const [tier, list] of Object.entries(tiers)) {
  console.log(`\n## tier=${tier}（${list.length}）\n${list.sort().map((n) => `- ${n}`).join("\n")}`);
}
for (const [platform, bucket] of Object.entries(byPlatform)) {
  if (bucket.size === 0) continue;
  console.log(`\n## systemDeps.${platform}`);
  for (const [dep, exts] of [...bucket].sort()) console.log(`- ${dep}  ← ${exts.join(", ")}`);
}
if (services.length) {
  console.log("\n## services（S5 phases 声明源）");
  for (const s of services) console.log(`- [${s.ext}] ${s.name} :${s.port ?? "-"} phase=${s.phase} cmd=${s.cmd}`);
}
