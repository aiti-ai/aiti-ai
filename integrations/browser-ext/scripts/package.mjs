#!/usr/bin/env node
/**
 * package.mjs —— 把 dist/{chrome,edge,firefox} 打包为 zip（无依赖，用系统 zip）。
 * 用法：node scripts/package.mjs [targets...]（缺省全部）
 */
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const dist = join(root, "dist");
const targets = process.argv.slice(2).filter((t) => !t.startsWith("-"));
const all = targets.length ? targets : ["chrome", "edge", "firefox"];

for (const t of all) {
  const dir = join(dist, t);
  if (!existsSync(dir)) { console.error("✗ 未找到 dist/" + t + "（先跑 npm run build）"); continue; }
  const zip = join(dist, "aiti-devtools-" + t + ".zip");
  rmSync(zip, { force: true });
  try {
    // zip 内容需不含外层 dist/<t>/ 目录（解压即 manifest.json）
    execFileSync("zip", ["-r", "-q", zip, "."], { cwd: dir });
    console.log("✓ " + zip);
  } catch (e) {
    console.error("✗ zip 打包失败（需要系统 zip）：" + (e && e.message));
  }
}