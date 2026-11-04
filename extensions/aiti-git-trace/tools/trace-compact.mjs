#!/usr/bin/env node
/**
 * aiti-git-trace · 影子仓按时间瘦身 CLI（方案四 §5.2 / M6）
 *
 * 用法：
 *   node tools/trace-compact.mjs <repoRoot>...          # 实跑：删过期会话分支 + gc 回收 + 同批清台账/state
 *   node tools/trace-compact.mjs <repoRoot> --dry-run   # 默认 dry-run 出报告（不删任何数据）
 *   node tools/trace-compact.mjs --all [--ext-config-dir <dir>]   # 遍历已知仓（state cwd + workspace paths）
 *   参数：--days 30（保留窗）· --keep-active-hours 24（活跃保护）· --max-objects-mb 300（水位）
 *
 * 不可逆提示：裁剪丢的是 N 天前的 AI 操作追溯（时间线/回滚能力）；默认 30 天审计窗。
 * 并发安全：compact 全程持 compact.lock（O_EXCL）；trace 写入侧 commit 前探测等待（防撕裂窗口）。
 */
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : dflt;
};
const has = (name) => args.includes("--" + name);
const DRY = has("dry-run");
const DAYS = Number(opt("days", "30")) || 30;
const KEEP_ACTIVE = Number(opt("keep-active-hours", "24")) || 24;
const MAX_MB = Number(opt("max-objects-mb", "300")) || 300;

const { compact, collectTraceRepos, storeOk } = await import(pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), "..", "trace-core.ts")).href); // Windows 盘符路径必须转 file:// URL

// 仓根列表：位置参数优先；--all = 从扩展 configDir 收集已知仓
const extConfigDir = opt("ext-config-dir", join(homedir(), ".pi", "web", "data", "aiti-git-trace", "config"));
let roots = args.filter((a) => !a.startsWith("--") && !/^\d+$/.test(a)).map((r) => resolve(r));
if (!roots.length && (has("all") || !roots.length)) {
  roots = collectTraceRepos(extConfigDir);
  console.log(`[trace-compact] 收集到 ${roots.length} 个已知追踪仓（来源：state cwd + workspace paths）`);
}
if (!roots.length) {
  console.log("未指定仓根且未发现已知仓。用法：node tools/trace-compact.mjs <repoRoot> --dry-run [--days 30]");
  process.exit(0);
}

let totalReclaimed = 0, totalRemoved = 0, failed = 0;
for (const repo of roots) {
  if (!storeOk(repo)) { console.log(`[skip] ${repo}（无 .aiti-trace）`); continue; }
  const r = await compact(repo, { days: DAYS, keepActiveHours: KEEP_ACTIVE, maxObjectsMB: MAX_MB, dryRun: DRY, extConfigDir, log: console.log });
  if (r.error) { console.log(`[✗] ${repo} → ${r.error}`); failed++; continue; }
  if (DRY) {
    console.log(`[dry-run] ${repo}\n  候删 ${r.branchesCandidate ?? 0} 分支（含 ${r.tagsCandidate ?? 0} tag / ${r.indexesCandidate ?? 0} index）：${(r.removedBranches || []).slice(0, 10).join(" ")}${(r.removedBranches || []).length > 10 ? " …" : ""}\n  objects 现 ${((r.objectsMBBefore ?? 0) || 0).toFixed(0)}MB · 无主台账/state 可清 ${r.opsStateCleaned ?? 0} 个`);
  } else {
    totalReclaimed += r.reclaimedMB || 0;
    totalRemoved += r.branchesRemoved || 0;
    console.log(`[✓] ${repo} → 删 ${r.branchesRemoved ?? 0} 分支 · ${r.tagsRemoved ?? 0} tag · ${r.indexesRemoved ?? 0} index · 回收 ${(r.reclaimedMB ?? 0).toFixed(0)}MB（objects ${((r.objectsMBBefore ?? 0) || 0).toFixed(0)}→${((r.objectsMBAfter ?? 0) || 0).toFixed(0)}MB · 台账/state 清 ${r.opsStateCleaned ?? 0}）`);
  }
}
if (!DRY) console.log(`\n完成：共删 ${totalRemoved} 分支 · 回收 ${totalReclaimed.toFixed(0)}MB${failed ? ` · 失败 ${failed} 仓` : ""}`);
else console.log("\n（dry-run 未动数据；确认后去掉 --dry-run 实跑）");
