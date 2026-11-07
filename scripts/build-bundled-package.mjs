#!/usr/bin/env node
// build-bundled-package.mjs —— 主包 bundled 稳定打包（隔离构建，解决共享工作树竞态）。
//
// 问题：aiti-ai 工作树被多会话共享，并行会话的 git 操作（checkout/clean）会清除
// gitignored 的 dist/node_modules，打包时 dist 缺失、内容漂移。
//
// 方案：从 git HEAD 快照（git archive）建立隔离 staging 目录，在 staging 内完成
// 全部构建（主包 deps + .next + 49 扩展 dist），npm pack。并行会话对工作树的任何
// 操作都不影响 staging——HEAD 内容固定，构建可复现。
//
// 用法：
//   node scripts/build-bundled-package.mjs                    # 打包 HEAD → tgz 输出到仓根
//   node scripts/build-bundled-package.mjs --out /tmp/x.tgz   # 指定输出路径
//   node scripts/build-bundled-package.mjs --keep             # 保留 staging 目录（调试）
//   AITI_PACK_REGISTRY=https://registry.npmjs.org/ ...               # 构建装依赖用的 registry
//
// 耗时：~10-15 分钟（主包 install ~2min + next build ~3min + 49 扩展 install+build ~8min，
// npm cache 热时显著加速）。产物 = 完整 bundled npm 包（63+ 扩展 dist 随包）。

import { execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, rmSync, cpSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { tmpdir, homedir } from "node:os";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const opt = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : null;
};
const OUT = opt("--out") || null;
const KEEP = has("--keep");
const REGISTRY = process.env.AITI_PACK_REGISTRY || "";
const NODE_OPTIONS = process.env.NODE_OPTIONS || "--max-old-space-size=8192";
const NODE_OPTS = process.env.NODE_OPTIONS || "--max-old-space-size=8192";

const stage = (name) => {
  const dir = join(tmpdir(), `aiti-pack-${name}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const run = (cmd, cwd, label) => {
  console.log(`\n[pack] ${label || cmd}`);
  const r = spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_OPTIONS } });
  if (r.status !== 0) {
    console.error((r.stderr || "").slice(-1500));
    throw new Error(`${label || cmd} 失败 (exit ${r.status})`);
  }
  return r.stdout;
};

// 1) HEAD 快照 → 隔离 staging（git archive：固定内容，无 .git，无 gitignored 垃圾）
const t0 = Date.now();
const stageDir = stage("root");
console.log(`[pack] staging: ${stageDir}`);
run(`git archive HEAD | tar -x -C ${stageDir}`, REPO, "git archive HEAD → staging");

// 2) 主包依赖 + .next 构建
run("npm install --no-audit --no-fund --loglevel=error", stageDir, "npm install（主包依赖）");
run("npm run build", stageDir, "next build（.next）");

// 3) 扩展 dist：有真实 build:client 的逐个 install + build（跳过 "true" 占位）
const extRoot = join(stageDir, "extensions");
const exts = readdirSync(extRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);
let built = 0, skipped = 0, failed = [];
for (const ext of exts) {
  const pjPath = join(extRoot, ext, "package.json");
  if (!existsSync(pjPath)) continue;
  let p;
  try { p = JSON.parse(readFileSync(pjPath, "utf8")); } catch { continue; }
  const bc = p.scripts?.["build:client"];
  if (!bc || bc.trim() === "true") { skipped++; continue; }
  try {
    run("npm install --no-audit --no-fund --loglevel=error", join(extRoot, ext), `install ${ext}`);
    run("npm run build:client", join(extRoot, ext), `build ${ext}`);
    built++;
    console.log(`[pack] ✓ ${ext} dist`);
  } catch (e) {
    failed.push(ext);
    console.error(`[pack] ✗ ${ext} 构建失败: ${e.message.slice(0, 120)}`);
  }
}
if (failed.length) throw new Error(`扩展构建失败: ${failed.join(", ")}`);
console.log(`[pack] 扩展 dist: built ${built} / skipped ${skipped}`);

// 4) npm pack（files 白名单过滤在 staging 树上生效）
const pj = JSON.parse(readFileSync(join(stageDir, "package.json"), "utf8"));
run("npm pack --pack-destination " + JSON.stringify(stageDir), stageDir, "npm pack");
const tgzName = `aiti-ai-pi-web-${pj.version}.tgz`;
const tgzStage = join(stageDir, tgzName);
if (!existsSync(tgzStage)) throw new Error(`pack 产物缺失: ${tgzStage}`);

// 5) 产物落位 + 内容自检（dist/部署拷贝文件/无 node_modules 残留/_shared 排除）
const outPath = OUT || join(REPO, tgzName);
cpSync(tgzStage, outPath);
const listing = execSync(`tar tzf ${JSON.stringify(outPath)}`, { encoding: "utf8" });
const count = (re) => (listing.match(new RegExp(re, "gm")) || []).length;
const checks = {
  "扩展 dist 目录": count("^package/extensions/[^/]+/dist/[^/]+$"),
  "quickstart dist": count("^package/extensions/aiti-quickstart/dist/"),
  "bridge-core.ts（部署拷贝）": count("^package/extensions/aiti-devtools/bridge-core"),
  "convert-saveas.ts（部署拷贝）": count("^package/extensions/aiti-editor/convert-saveas"),
  "check-client.mjs（部署拷贝）": count("^package/extensions/aiti-extman/check-client"),
  "onlyoffice token（部署拷贝）": count("^package/extensions/aiti-onlyoffice/token"),
  "_shared 残留（应 0）": count("^package/extensions/_shared/"),
  "extensions/node_modules 残留（应 0）": count("^package/extensions/node_modules/"),
  ".next 条目": count("^package/\\.next/"),
};
console.log(`\n[pack] 自检:`);
for (const [k, v] of Object.entries(checks)) {
  const bad = (k.includes("残留") ) ? v !== 0 : v === 0;
  console.log(`  ${bad ? "✗" : "✓"} ${k}: ${v}`);
  if (bad) process.exitCode = 1;
}

if (!KEEP) {
  rmSync(stageDir, { recursive: true, force: true });
  console.log(`[pack] staging 已清理`);
} else {
  console.log(`[pack] staging 保留: ${stageDir}`);
}
console.log(`\n[pack] 完成: ${outPath}（总耗时 ${((Date.now() - t0) / 60000).toFixed(1)} min）`);
