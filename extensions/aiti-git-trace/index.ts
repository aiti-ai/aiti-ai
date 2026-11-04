/**
 * aiti-git-trace · 编外 AI 变更追踪扩展（server 端入口）
 *
 * 方案：docs/aiti-git-trace-plan.md（WP-C：M1 骨架/API/回撤 + M2-7 部分回滚 + M3-4 workspace 配置）
 *
 * 职责：features 声明（§9 全表）、ui 装配（§8.2）、API 委托 api.ts（可单测）。
 *
 * 红线：绝不写用户仓 .git；git 写路径只允许 trace store（hermetic 三件套，trace-core.ts）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname as pathDirname, join, join as pathJoin } from "node:path";
import { handleApi } from "./api.ts";
import {
  ensureExcludesFile, readOps, sessionRepoRoots, sanitizeSession,
  repoRootOf, workspaceKey, loadWorkspace, storeOf, storeOk, runGit,
  opsDirFor,
  setAppendListener } from "./trace-core.ts";

let configDir = "";
let extDir = "";
let hostCtx: any = null;

// ── 事件出口（docs/aiti-plan-first-plan.md §3.2 v2）──────────────
// pi 扩展 appendRow 后经 globalThis.__aitiTraceEmit 广播；本扩展装 sink 转 traceBus。
// 消费方：services.trace.onOp（进程内，主通道）+ GET /events（SSE，浏览器）。
// 台账文件仍是唯一事实源；事件丢失由消费方跳号补洞（plan-first §3.4）。
import { EventEmitter } from "node:events";
export type TraceOpEvent = { kind: "op"; sessionId: string; row: any };
const traceBus = new EventEmitter();
traceBus.setMaxListeners(30);
let sinkPrev: ((evt: TraceOpEvent) => void) | undefined;
const traceSink = (evt: TraceOpEvent) => {
  try { sinkPrev?.(evt); } catch { /* 前任消费者错误不阻断 */ }
  traceBus.emit("op", evt);
};
// web 侧 appendOps（plan-record/回撤记账）→ 同一 bus：SSE/面板对 web 侧写入同样实时
setAppendListener((sessionId, row) => {
  try { traceBus.emit("op", { kind: "op", sessionId, row }); } catch { /* 通知失败不影响记账 */ }
});

/** 供 api.ts SSE 端点订阅（onOp 同一 bus） */
export function onTraceOp(listener: (evt: TraceOpEvent) => void) {
  traceBus.on("op", listener);
  return () => traceBus.off("op", listener);
}

// ── 跨扩展服务出口（§16 / docs/aiti-plan-first-plan.md §3.2）────────────
// 其他扩展获取 git-trace 数据的唯一通道：ctx.services.get("aiti-git-trace.trace")（DI 方案 P1；
// 旧通道 __piWebExt.byId("aiti-git-trace").ext.services.trace 为过渡期兜底，生产同步后退役）
// （进程内同步调用；消费方 capability 探测 + version 协商，缺席/老版本 fail-silent 降级）。
// 红线对偶：本出口只读；消费方不得直接读本扩展 configDir。
// 导出 builder 供 node:test 注入临时 configDir（与 def 上的 getter 同一实现）。
export function traceService(dir: string) {
  const storesOf = (sessionId: string): { root: string; role: string }[] => {
    const sid = sanitizeSession(sessionId);
    const out: { root: string; role: string }[] = [];
    const push = (root: unknown, role: unknown) => {
      if (typeof root !== "string" || !root || out.some((s) => s.root === root)) return;
      out.push({ root, role: role === "primary" ? "primary" : "secondary" });
    };
    try {
      const st = JSON.parse(readFileSync(join(pathDirname(dir), "cache", "state", sid + ".json"), "utf8"));
      if (Array.isArray(st?.stores)) for (const s of st.stores) push(s?.root, s?.role);
    } catch { /* 无状态文件（尚未追踪的会话） */ }
    // 台账补全：state 只是运行时快照，引擎重启会丢之前的副仓；台账才是持久记录
    for (const root of sessionRepoRoots(dir, sid)) push(root, "secondary");
    return out;
  };
  return {
    version: 2,
    /** 进程内监听 op 事件（返回退订）。事件 = 台账行实时通知，丢失由消费方跳号补洞。 */
    onOp(listener: (evt: TraceOpEvent) => void) {
      traceBus.on("op", listener);
      return () => traceBus.off("op", listener);
    },
    /** 台账读取：op > sinceOp 的增量（缺省全量）；limit>0 时取最新 N 条。op 单调不回退；
     *  台账清理可致收缩——消费方游标须容忍「最新 op < 游标」并重置。 */
    readOps(sessionId: string, opts?: { sinceOp?: number; limit?: number }) {
      let ops = readOps(dir, sanitizeSession(sessionId));
      const since = Number(opts?.sinceOp);
      if (Number.isFinite(since)) ops = ops.filter((o) => (Number(o?.op) || 0) > since);
      const limit = Number(opts?.limit);
      if (Number.isFinite(limit) && limit > 0) ops = ops.slice(-limit);
      return ops;
    },
    /** 会话识别仓（state stores + 台账补全；主仓在前，角色 primary/secondary） */
    sessionStores(sessionId: string) {
      return storesOf(sessionId);
    },
    /** workspace 关注路径（cwd 定位 workspace key；未配置 → 空数组） */
    watchPaths(cwd: string) {
      if (!cwd) return [];
      const repoRoot = repoRootOf(cwd);
      return loadWorkspace(dir, workspaceKey(repoRoot || cwd)).paths
        .map((p) => ({ path: p.path, repoRoot: p.repoRoot ?? null }));
    },
    /** 仓内 md 清单 v2：tracked + untracked（非 ignore）全列。git 的 ls-files 排除选项单槽互斥
     *  （--exclude-standard 与 --exclude-per-directory、以及两个 per-directory 不能叠加，实测），
     *  故拆 4 次调用做集合运算：A=tracked；B1/B2=untracked 分别排 .gitignore/.aitiignore 后取交集；
     *  I=tracked∩.aitiignore（-ic）剔除。跨仓去重，上限 200 条。（异步化：git 不阻塞事件循环） */
    async listMd(sessionId: string) {
      const sid = sanitizeSession(sessionId);
      const out: { path: string; root: string }[] = [];
      const seen = new Set<string>();
      const spec = ["--", ":(icase)*.md"];
      const lines = async (store: any, args: string[]): Promise<string[]> => {
        try {
          const r = await runGit(store, args, { allowFail: true });
          return r.stdout.split("\0").map((x) => x.trim()).filter(Boolean);
        } catch { return []; }
      };
      for (const { root } of storesOf(sid)) {
        if (!storeOk(root)) continue;
        const store = storeOf(root, sid);
        const tracked = new Set(await lines(store, ["ls-files", "-cz", ...spec]));
        const b1 = new Set(await lines(store, ["ls-files", "-oz", "--exclude-per-directory=.gitignore", ...spec]));
        const b2 = new Set(await lines(store, ["ls-files", "-oz", "--exclude-per-directory=.aitiignore", ...spec]));
        const ignoredTracked = new Set(await lines(store, ["ls-files", "-icz", "--exclude-per-directory=.aitiignore", ...spec]));
        const paths = [...new Set([...tracked, ...[...b1].filter((p) => b2.has(p))])].filter((p) => !ignoredTracked.has(p));
        for (const p of paths) {
          if (seen.has(root + "\0" + p)) continue;
          seen.add(root + "\0" + p);
          out.push({ path: p, root });
          if (out.length >= 200) return out;
        }
      }
      return out;
    },
    /** 会话台账枚举（aiti-doc-center 冷启动回填用；纯列表零解析，按最近改动排序） */
    sessions(): { sid: string; size: number; mtimeMs: number }[] {
      try {
        const opsDir = opsDirFor(dir);
        return readdirSync(opsDir)
          .filter((f) => f.endsWith(".jsonl"))
          .map((f) => {
            try {
              const st = statSync(join(opsDir, f));
              return { sid: f.slice(0, -".jsonl".length), size: st.size, mtimeMs: Math.round(st.mtimeMs) };
            } catch { return null; }
          })
          .filter((x): x is { sid: string; size: number; mtimeMs: number } => !!x)
          .sort((a, b) => b.mtimeMs - a.mtimeMs);
      } catch {
        return [];
      }
    },
  };
}

// ---- 影子仓瘦身（方案四 §5.2）：schedule 定时任务 + 启动自检（24h 限流），配置 compact.{enabled,days,maxObjectsMB} ----
function compactConfig(): { enabled: boolean; days: number; maxObjectsMB: number } {
  let c: any = {};
  try { c = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8")); } catch { /* 缺省开 */ }
  const cp = c.compact || {};
  return {
    enabled: cp.enabled !== false,
    days: Number(cp.days) || 30,
    maxObjectsMB: Number(cp.maxObjectsMB) || 300,
  };
}

function compactRepos(dryRun: boolean): void {
  const cc = compactConfig();
  if (!cc.enabled && !dryRun) return;
  // gc 是同步重活（大仓数十秒）——spawn 独立子进程跑 CLI，不占 pi-web 主进程事件循环（§2.4 服务端红线）
  const cli = join(extDir || configDir, "tools", "trace-compact.mjs");
  const fallbackCli = join(configDir, "trace-compact.mjs");
  const script = existsSync(cli) ? cli : existsSync(fallbackCli) ? fallbackCli : "";
  if (!script) { console.warn("[aiti-git-trace·compact] 未找到 trace-compact CLI，跳过本轮"); return; }
  const args = [script, "--all", "--ext-config-dir", configDir,
    "--days", String(cc.days), "--max-objects-mb", String(cc.maxObjectsMB)];
  if (dryRun) args.push("--dry-run");
  try {
    const { spawn } = require("node:child_process") as typeof import("node:child_process");
    const child = spawn(process.execPath, args, { detached: true, stdio: "ignore" });
    child.on("error", (e) => console.warn("[aiti-git-trace·compact] 子进程失败:", e.message));
    child.unref();
    console.log("[aiti-git-trace·compact] 已派发子进程" + (dryRun ? "（dry-run）" : "") + "：" + script);
  } catch (e: any) { console.warn("[aiti-git-trace·compact] 派发失败:", e?.message || e); }
  // 限流标记（.last-compact）：写失败要可见（曾静默失败 → 每次扩展重启都多跑一轮 compact）
  const markRoot = configDir ? pathDirname(configDir) : extDir; // 数据分层：cache 在 <extRoot> 下（configDir = <extRoot>/config）
  try {
    if (!markRoot) throw new Error("configDir/extDir 均为空");
    mkdirSync(join(markRoot, "cache"), { recursive: true });
    writeFileSync(join(markRoot, "cache", ".last-compact"), String(Date.now()));
  } catch (e: any) {
    console.warn("[aiti-git-trace·compact] 限流标记写入失败:", e?.message || e);
  }
}

/** schedule 任务（每日一次；aiti-ai-schedule 聚合执行——不自造轮询 timer） */
function compactTaskRun(ctx: any): void {
  if (ctx?.configDir) configDir = ctx.configDir;
  compactRepos(false);
}

// 启动自检：距上次成功 compact > 24h 才跑（限流防频繁）；延迟 60s 让 startup 先回，失败不影响加载
function startupCompactSelfCheck(): void {
  try {
    const cc = compactConfig();
    if (!cc.enabled) return;
    if (process.env.AITI_TRACE_COMPACT_OFF) return;
    let last = 0;
    try { last = Number(readFileSync(join(pathDirname(configDir), "cache", ".last-compact"), "utf8")) || 0; } catch {}
    if (Date.now() - last < 24 * 3600 * 1000) return;
    const t = setTimeout(() => { try { compactRepos(false); } catch {} }, 60 * 1000);
    (t as unknown as { unref?: () => void }).unref?.();
  } catch { /* 尽力 */ }
}

export default {
  id: "aiti-git-trace",
  name: "AI 变更追踪",
  version: "0.2.0",
  // 能力声明（依赖与能力模型 P1）：本扩展提供「变更追踪」能力（多实现占位——未来
  // 其他追踪实现可同声明 cap.git-trace，消费方 dependsOn 指向能力名由平台解析）。
  // 消费方经 services.trace 出口（ctx.services.get("aiti-git-trace.trace")）使用。
  provides: ["cap.git-trace"],
  ai: {
    manage: true,
    intro: "编外 AI 变更追踪：.aiti-trace 追踪仓按 op 编号记录 AI 会话的文件变更；支持查询操作台账、回滚文件变更、管理 cwd 之外的关注路径（多仓追踪）。",
    skills: "skills",
  },
  icon: "icon.svg",
  client: "dist/aiti-git-trace-client.mjs",

  // 影子仓瘦身定时任务（注册给 aiti-ai-schedule 聚合执行；compact.enabled=false 可关）
  schedules: [
    { id: "trace-compact", name: "影子仓按时间瘦身（默认保 30 天，删旧分支+回收对象+清无主台账）", intervalSec: 86400, enabled: true, run: compactTaskRun },
  ],

  // §9 features 全表（7 项；关注路径/autoDiscover 是 workspace 级配置，不经 extman）
  features: [
    { id: "trace.enabled", label: "追踪总开关", type: "boolean", default: true, description: "开启后 AI 会话文件变更写入 .aiti-trace 追踪仓（默认关）" },
    { id: "trace.excludeExtra", label: "追加排除", type: "string", default: "", placeholder: "gitignore 语法，一行一条", description: "在内置排除清单之上追加排除（叠加项目 .gitignore）" },
    { id: "trace.includeExtra", label: "否定豁免", type: "string", default: "", placeholder: "!pattern", description: "用 ! 模式救回被内置排除误伤的路径（父目录整目录排除时受 gitignore 否定规则限制）" },
    { id: "trace.builtinExcludes", label: "内置排除清单", type: "boolean", default: true, description: "关掉后仅剩项目 gitignore + 用户追加排除" },
    { id: "trace.maxFileKB", label: "单文件上限 KB", type: "string", default: "2048", placeholder: "2048", description: "超过该大小的文件不入追踪仓，台账记 skipped" },
    { id: "trace.scope", label: "追踪范围", type: "string", default: "repo", placeholder: "repo / cwd", description: "repo=work-tree 为仓根（含同仓越界）；cwd=巨型仓下缩小到会话目录" },
    { id: "trace.autoInit", label: "无 git 自动建仓", type: "boolean", default: true, description: "无 git 目录在文件数预算内自动创建 .aiti-trace 简易追踪（§13.4；系统目录除外）" },
    { id: "trace.autoInitMaxFiles", label: "自动建仓文件数预算", type: "string", default: "2000", placeholder: "2000", description: "超过该文件数的不自动建仓（防生成物目录误建）" },
    { id: "trace.autoInitSeedIgnores", label: "简易追踪补常见 gitignore", type: "boolean", default: false, description: "loose 建仓时顺带补 node_modules/ 等常见条目（默认只写 .aiti-trace/ 一行）" },
    { id: "trace.watchUI", label: "关注路径独立入口", type: "boolean", default: false, description: "在工具条单独显示「⎇ 关注路径」按钮（默认关——入口在时间线面板顶部；切换后刷新页面生效）" },
    { id: "trace.timelineUI", label: "时间线独立入口", type: "boolean", default: true, description: "在工具条单独显示「⎇ 时间线」按钮（默认开——主入口在输入框下方控制行，与压缩/导入同排；关闭后刷新页面生效）" },
  ],

  ui: {
    toolbar: [
      { id: "aiti-git-trace-watch", label: "关注路径", title: "aiti-git-trace：关注路径管理（workspace 持久 + 本会话识别；只追 git 仓）", icon: "icons/git-branch.svg" },
      { id: "aiti-git-trace-timeline", label: "时间线", title: "aiti-git-trace：本会话 ops 时间线（回滚/看 diff）", icon: "icons/git-commit-horizontal.svg" },
    ],
    dialogs: [
      { id: "aiti-git-trace-watch-dialog", label: "aiti-git-trace · 关注路径" },
      { id: "aiti-git-trace-timeline-dialog", label: "aiti-git-trace · 时间线" },
      { id: "aiti-git-trace-fork-dialog", label: "aiti-git-trace · 回撤" },
    ],
    banners: [{ id: "aiti-git-trace-banner", label: "aiti-git-trace" }],
    // aiti-float dock 静态声明（id 与 client 注册一致）：时间线（左栏/右栏双位）+ 关注路径
    sidebarExplorerDock: [
      { id: "timeline", label: "时间线" },
      { id: "watch", label: "关注路径" },
    ],
    rightFileDock: [
      { id: "timeline", label: "时间线" },
      { id: "watch", label: "关注路径" },
    ],
    i18n: {
      en: {
        "gt.watch.short": "Watch",
        "gt.watch.traceEnabled": "File change tracking (this workspace)",
        "gt.watch.traceOff": "Tracking fully disabled for this workspace (stops before the next op).",
        "gt.watch.traceOffHint": "Disable for very large repos if tracking overhead hurts AI responsiveness. Re-enable anytime.",
        "gt.watch.experimental": "Experimental: tracking records file changes on a best-effort basis and does NOT guarantee every file is captured (exclude rules, size limits, permissions, etc. are skipped).",
        "gt.watch.title": "Watch paths",
        "gt.watch.auto": "Auto-discover",
        "gt.watch.add": "Add path",
        "gt.watch.placeholder": "/abs/path or repo root…",
        "gt.watch.persist": "Save to workspace",
        "gt.watch.origin": "Origin",
        "gt.watch.repo": "Repo",
        "gt.watch.nongit": "non-git (listed only)",
        "gt.watch.nogit": "No git repo and auto-init is off (or system dir / over budget) — NOT tracked. Watch paths pointing at git repos still work.",
        "gt.watch.loose": "No git repo here — will auto-create .aiti-trace lightweight tracking (small dir).",
        "gt.watch.oversize": "No git repo, and this dir exceeds the file budget — lightweight tracking skipped (trace.autoInitMaxFiles).",
        "gt.watch.denied": "No git repo, and this is a system/home dir — lightweight tracking skipped.",
        "gt.watch.empty": "No watch paths yet.",
        "gt.watch.del": "Remove",
        "gt.watch.saved": "Saved",
        "gt.timeline.title": "Ops timeline",
        "gt.timeline.session": "Session id",
        "gt.timeline.load": "Load",
        "gt.timeline.showAll": "Show no-change ops",
        "gt.timeline.viewTree": "Lineage",
        "gt.timeline.treeSummary": "Lineage: {n} sessions",
        "gt.timeline.treeCurrent": "current",
        "gt.timeline.treeEmpty": "No fork lineage (this session is not a fork and has no children).",
        "gt.timeline.treeOpen": "Open",
        "gt.timeline.treeTip": "Click a session to view its timeline.",
        "gt.tl.cleanAll": "This will DELETE the entire session ledger (irreversible).",
        "gt.tl.cleanBefore": "This will DELETE ledger entries before op #{n} (op #{n} onwards is kept).",
        "gt.tl.cleanAllTip": "Clean this session's ledger",
        "gt.tl.cleanBeforeTip": "Clean ledger entries before this op (keep this one onwards)",
        "gt.common.confirm": "Confirm",
        "gt.common.cancel": "Cancel",
        "gt.watch.sessionRepos": "Git repos recognized in this session",
        "gt.watch.rolePrimary": "primary",
        "gt.watch.roleSecondary": "secondary",
        "gt.watch.pinned": "watched",
        "gt.watch.pin": "watch",
        "gt.watch.pinTip": "Add to workspace watch paths (persists across sessions)",
        "gt.watch.needCwd": "No workspace context on this page — type a cwd and resolve.",
        "gt.watch.cleanup": "Clean workspace tracking history",
        "gt.watch.cleanupConfirm": "Delete ALL session ledgers + reset the trace store for this workspace?",
        "gt.watch.cleanupTip": "Clears tracking data only: deletes all session ledgers under this workspace and resets the trace store (running sessions auto-rebuild an empty store). Cleared trace history can't be recovered. Files and code in your working path are completely unaffected.",
        "gt.watch.cleanupDone": "Cleaned",
        "gt.watch.cleanupSessions": "sessions",
        "gt.watch.cleanupStore": "store reset",
        "gt.timeline.review": "Review",
        "gt.timeline.reviewSel": "Review selected prompts",
        "gt.timeline.reviewGroup": "Review this prompt (all ops in the group)",
        "gt.timeline.reviewSelTip": "Range = first to last selected group (consecutive groups in between included)",
        "gt.timeline.selGroup": "Select this prompt for range review",
        "gt.timeline.empty": "No ops recorded for this session.",
        "gt.timeline.rollback": "Rollback",
        "gt.timeline.viewdiff": "Diff",
        "gt.timeline.openFile": "Open",
        "gt.timeline.openFileTip": "Open in right dock",
        "gt.timeline.atRef": "Mention",
        "gt.timeline.atRefTip": "Mention in current session input (@ path, not sent)",
        "gt.timeline.atNew": "New session",
        "gt.timeline.atNewTip": "New session with pre-filled mention (cwd aligned to file repo)",
        "gt.timeline.copyPath": "Path",
        "gt.timeline.copyPathTip": "Copy absolute path",
        "gt.timeline.copied": "Copied",
        "gt.tl.rowMention": "@ this line to new session (with version)",
        "gt.timeline.confirm": "Rollback worktree to the state before this op?",
        "gt.timeline.group": "prompt",
        "gt.timeline.partialHint": "This op is a first-touch (no before baseline) and cannot be reverse-applied; its after commit is the earliest restorable point.",
        "gt.timeline.cross": "cross-repo",
        "gt.timeline.leak": "external",
        "gt.timeline.partial": "partial",
        "gt.timeline.viewMsg": "By message",
        "gt.timeline.viewFile": "By file",
        "gt.timeline.viewTip": "Switch grouping: by user message / by file",
        "gt.timeline.fileTouch": "ops",
        "gt.timeline.fileExpand": "Show the ops that touched this file",
        "gt.timeline.fileDiffTip": "Review this file across the whole session range (earliest baseline → latest)",
        "gt.timeline.fileEmpty": "No file-level changes (baseline-only snapshots are not counted)",
        "gt.timeline.truncTip": "Only the first 50 changed paths per op are listed (the ±N count is complete)",
        "gt.fork.title": "AI changes — what to do?",
        "gt.fork.desc": "Operations belonging to the retracted prompt:",
        "gt.fork.rollback": "Rollback file changes",
        "gt.fork.keep": "Keep intermediate changes",
        "gt.fork.cancel": "Cancel retract",
        "gt.fork.done": "File changes rolled back",
        "gt.fork.aiTakeover": "Let AI handle",
        "gt.fork.ignore": "Ignore, keep as-is",
        "gt.fork.skippedHint": "Rolled back; {n} op(s) without baseline were skipped and kept.",
        "gt.fork.failTitle": "Rollback failed midway; some changes not reverted",
        "gt.fork.failDetail": "Applied {applied}; skipped (no baseline) {skipped}; failed at #{op}: {err}",
        "gt.fork.failHint": "\"Let AI handle\" pastes the full scene into the AI input; \"Ignore\" keeps current state.",
        "gt.fork.gap": "no baseline",
        "gt.fork.gapTip": "First tracked op in this repo (no before baseline) — its changes cannot be auto-reverted and will be kept.",
        "gt.banner.text": "This retract involved {n} tracked operations.",
        "gt.common.close": "Close",
        // ── 变更总览（overview 方案 §4，2026-09-08；append-only）──
        "gt.timeline.viewOverview": "Overview",
        "gt.timeline.viewTip2": "Switch view: overview / by operation / lineage",
        "gt.timeline.turnFilter": "Turn filter (overview)",
        "gt.timeline.allTurns": "All turns",
        "gt.ov.ops": "ops",
        "gt.ov.files": "files",
        "gt.ov.rollbacks": "rollbacks",
        "gt.ov.binary": "binary",
        "gt.ov.netNote": "Line counts are net range diffs and may include other edits to the same files.",
        "gt.ov.loading": "Loading…",
        "gt.ov.noFiles": "No file changes in this range.",
        "gt.ov.storeMissing": "Trace store missing for this session's repos — nothing to summarize.",
        "gt.ov.filesTruncated": "More than 2000 changed files; showing the first 2000.",
        "gt.ov.more": "Show more",
        "gt.ov.diffTruncated": "Diff truncated ({n} lines total).",
        "gt.ov.openReview": "Open full diff in review",
        "gt.fork.turnFiles": "{n} files",
        "gt.footer.title": "File changes traced by git-trace beyond the write/edit list ({n} traced ops). Click a file to view its diff in the timeline.",
        "gt.footer.more": "+{n} more",
        "gt.footer.collapse": "Collapse",
        "gt.footer.truncated": "Some changed files are not listed (ledger path cap).",
      },
      "zh-CN": {
        "gt.watch.short": "关注路径",
        "gt.watch.traceEnabled": "文件变更追踪（本工作区）",
        "gt.watch.traceOff": "已彻底关闭本工作区的文件变更追踪（当前会话下一个操作前即停止）。",
        "gt.watch.traceOffHint": "特大项目若追踪影响 AI 流畅度，建议关闭；随时可重新开启。",
        "gt.watch.experimental": "实验性功能：文件追踪尽力记录 AI 会话的文件变更，不保证追踪到所有文件（排除规则、大小上限、权限等均会跳过）。",
        "gt.watch.title": "关注路径",
        "gt.watch.auto": "自动识别（识别 tool/bash 写路径）",
        "gt.watch.add": "添加路径",
        "gt.watch.placeholder": "/绝对路径 或 仓根…",
        "gt.watch.persist": "保存到 workspace",
        "gt.watch.origin": "来源",
        "gt.watch.repo": "归属仓",
        "gt.watch.nongit": "非 git（仅列示不入库）",
        "gt.watch.nogit": "此处没有 git 仓库，且自动建仓已关闭（或系统目录/超预算）——不会追踪。关注路径指向 git 仓的仍会追踪。",
        "gt.watch.loose": "此处没有 git 仓库——目录较小，将自动创建 .aiti-trace 简易追踪。",
        "gt.watch.oversize": "此处没有 git 仓库，且目录超过文件数预算——未建简易追踪（可调 trace.autoInitMaxFiles）。",
        "gt.watch.denied": "此处没有 git 仓库，且属于系统/家目录——不建简易追踪。",
        "gt.watch.empty": "暂无关注路径。",
        "gt.watch.del": "移除",
        "gt.watch.saved": "已保存",
        "gt.timeline.title": "操作时间线",
        "gt.timeline.session": "会话 id",
        "gt.timeline.load": "加载",
        "gt.timeline.showAll": "显示无变更操作",
        "gt.timeline.viewTree": "家谱",
        "gt.timeline.treeSummary": "家谱：{n} 个会话",
        "gt.timeline.treeCurrent": "当前",
        "gt.timeline.treeEmpty": "本会话无 fork 亲缘（非 fork 产生、也无子会话）。",
        "gt.timeline.treeOpen": "打开",
        "gt.timeline.treeTip": "点击任意会话 → 查看其时间线。",
        "gt.tl.cleanAll": "将删除本会话全部台账（不可恢复）。",
        "gt.tl.cleanBefore": "将删除 op #{n} 之前的台账（保留 #{n} 起的记录）。",
        "gt.tl.cleanAllTip": "清空本会话台账",
        "gt.tl.cleanBeforeTip": "清理此操作之前的台账（保留本条起）",
        "gt.common.confirm": "确认",
        "gt.common.cancel": "取消",
        "gt.watch.sessionRepos": "本会话识别的 git 仓",
        "gt.watch.rolePrimary": "主仓",
        "gt.watch.roleSecondary": "副仓",
        "gt.watch.pinned": "已关注",
        "gt.watch.pin": "关注",
        "gt.watch.pinTip": "加入工作区关注路径（跨会话持久）",
        "gt.watch.needCwd": "本页没有工作区上下文——请手动填写 cwd 后 resolve。",
        "gt.watch.cleanup": "清理本工作区追踪历史",
        "gt.watch.cleanupConfirm": "删除本工作区全部会话台账并重置追踪仓？",
        "gt.watch.cleanupTip": "只清除追踪记录：删除本工作区全部会话台账并重置追踪仓（运行中的会话自动重建空仓继续）。追踪历史一经清除无法找回。工作路径里的文件与代码完全不受影响。",
        "gt.watch.cleanupDone": "已清理",
        "gt.watch.cleanupSessions": "个会话",
        "gt.watch.cleanupStore": "追踪仓已重置",
        "gt.timeline.review": "评审",
        "gt.timeline.reviewSel": "评审所选 prompt",
        "gt.timeline.reviewGroup": "评审此 prompt（组内全部操作）",
        "gt.timeline.reviewSelTip": "范围 = 首个~最后选中的组（中间连续组一并包含）",
        "gt.timeline.selGroup": "勾选此 prompt 参与跨组评审",
        "gt.timeline.empty": "该会话暂无操作记录。",
        "gt.timeline.rollback": "回滚",
        "gt.timeline.viewdiff": "看 diff",
        "gt.timeline.openFile": "打开",
        "gt.timeline.openFileTip": "在右侧文件标签页打开",
        "gt.timeline.atRef": "引用",
        "gt.timeline.atRefTip": "引用到当前会话输入框（@ 路径，不发送）",
        "gt.timeline.atNew": "新会话",
        "gt.timeline.atNewTip": "新建会话并预填引用（cwd 对齐文件所在仓）",
        "gt.timeline.copyPath": "路径",
        "gt.timeline.copyPathTip": "复制绝对路径",
        "gt.timeline.copied": "已复制",
        "gt.tl.rowMention": "@ 此行到新会话（带版本）",
        "gt.timeline.confirm": "把工作区回滚到此操作之前的状态？",
        "gt.timeline.group": "用户消息",
        "gt.timeline.partialHint": "该操作为首触（无 before 基线），无法逆向回滚；最早可恢复点为其 after 提交。",
        "gt.timeline.cross": "跨仓",
        "gt.timeline.leak": "外溢",
        "gt.timeline.partial": "部分",
        "gt.timeline.viewMsg": "按消息",
        "gt.timeline.viewFile": "按文件",
        "gt.timeline.viewTip": "切换分组：按用户消息 / 按文件",
        "gt.timeline.fileTouch": "次操作",
        "gt.timeline.fileExpand": "展开触达此文件的操作",
        "gt.timeline.fileDiffTip": "评审此文件的整个会话区间（最早基线 → 最新）",
        "gt.timeline.fileEmpty": "没有文件级变更（首触基线快照不计入）",
        "gt.timeline.truncTip": "单 op 变更路径仅记录前 50 条（±N 计数为全量）",
        "gt.fork.title": "AI 变更处置",
        "gt.fork.desc": "被回撤 prompt 涉及以下操作：",
        "gt.fork.rollback": "回撤文件变更",
        "gt.fork.keep": "保留中间变更",
        "gt.fork.cancel": "取消回撤",
        "gt.fork.done": "已回撤文件变更",
        "gt.fork.aiTakeover": "让 AI 处理",
        "gt.fork.ignore": "忽略，保留现状",
        "gt.fork.skippedHint": "已回撤；{n} 个无基线操作被跳过、其变更保留。",
        "gt.fork.failTitle": "回撤中途失败，部分变更未撤销",
        "gt.fork.failDetail": "已撤 {applied}；跳过（无基线）{skipped}；失败 @#{op}：{err}",
        "gt.fork.failHint": "选「让 AI 处理」会把完整现场细节注入 AI 输入框；「忽略」则保留现状（已撤的生效，剩余变更保留）。",
        "gt.fork.gap": "无基线",
        "gt.fork.gapTip": "该仓首次被追踪，无 before 基线，此变更无法自动撤销（将保留）。",
        "gt.banner.text": "本次回撤涉及 {n} 个被追踪操作。",
        "gt.common.close": "关闭",
        // ── 变更总览（overview 方案 §4，2026-09-08；append-only）──
        "gt.timeline.viewOverview": "变更总览",
        "gt.timeline.viewTip2": "切换视图：变更总览 / 按操作 / 家谱",
        "gt.timeline.turnFilter": "轮次过滤（总览）",
        "gt.timeline.allTurns": "全部轮次",
        "gt.ov.ops": "次操作",
        "gt.ov.files": "个文件",
        "gt.ov.rollbacks": "次回撤",
        "gt.ov.binary": "二进制",
        "gt.ov.netNote": "行数按区间净变更，可能含对同一文件的其他改动。",
        "gt.ov.loading": "加载中…",
        "gt.ov.noFiles": "该范围内没有文件级变更。",
        "gt.ov.storeMissing": "本会话涉及的仓没有 trace store——无变更可汇总。",
        "gt.ov.filesTruncated": "变更文件超过 2000，仅显示前 2000。",
        "gt.ov.more": "显示更多",
        "gt.ov.diffTruncated": "Diff 已截断（共 {n} 行）。",
        "gt.ov.openReview": "在评审中打开完整 diff",
        "gt.fork.turnFiles": "{n} 个文件",
        "gt.footer.title": "git-trace 追踪到、「改动的文件」之外的变更（{n} 个被追踪操作）；点文件在时间线中查看 diff。",
        "gt.footer.more": "+{n}",
        "gt.footer.collapse": "收起",
        "gt.footer.truncated": "部分变更文件未列出（台账路径数截断）。",
      },
      "zh-TW": {
        "gt.watch.short": "關注路徑",
        "gt.watch.traceEnabled": "檔案變更追蹤（本工作區）",
        "gt.watch.traceOff": "已徹底關閉本工作區的檔案變更追蹤（當前會話下一個操作前即停止）。",
        "gt.watch.traceOffHint": "特大專案若追蹤影響 AI 流暢度，建議關閉；隨時可重新開啟。",
        "gt.watch.experimental": "實驗性功能：檔案追蹤盡力記錄 AI 會話的檔案變更，不保證追蹤到所有檔案（排除規則、大小上限、權限等均會跳過）。",
        "gt.watch.title": "關注路徑",
        "gt.watch.auto": "自動識別（識別 tool/bash 寫路徑）",
        "gt.watch.add": "新增路徑",
        "gt.watch.placeholder": "/絕對路徑 或 倉根…",
        "gt.watch.persist": "儲存到 workspace",
        "gt.watch.origin": "來源",
        "gt.watch.repo": "歸屬倉",
        "gt.watch.nongit": "非 git（僅列示不入庫）",
        "gt.watch.nogit": "此處沒有 git 倉庫，且自動建倉已關閉（或系統目錄/超預算）——不會追蹤。關注路徑指向 git 倉的仍會追蹤。",
        "gt.watch.loose": "此處沒有 git 倉庫——目錄較小，將自動建立 .aiti-trace 簡易追蹤。",
        "gt.watch.oversize": "此處沒有 git 倉庫，且目錄超過檔案數預算——未建簡易追蹤（可調 trace.autoInitMaxFiles）。",
        "gt.watch.denied": "此處沒有 git 倉庫，且屬於系統/家目錄——不建簡易追蹤。",
        "gt.watch.empty": "暫無關注路徑。",
        "gt.watch.del": "移除",
        "gt.watch.saved": "已儲存",
        "gt.timeline.title": "操作時間線",
        "gt.timeline.session": "會話 id",
        "gt.timeline.load": "載入",
        "gt.timeline.showAll": "顯示無變更操作",
        "gt.timeline.viewTree": "家譜",
        "gt.timeline.treeSummary": "家譜：{n} 個會話",
        "gt.timeline.treeCurrent": "當前",
        "gt.timeline.treeEmpty": "本會話無 fork 親緣（非 fork 產生、也無子會話）。",
        "gt.timeline.treeOpen": "打開",
        "gt.timeline.treeTip": "點擊任意會話 → 查看其時間線。",
        "gt.tl.cleanAll": "將刪除本會話全部台帳（不可恢復）。",
        "gt.tl.cleanBefore": "將刪除 op #{n} 之前的台帳（保留 #{n} 起的記錄）。",
        "gt.tl.cleanAllTip": "清空本會話台帳",
        "gt.tl.cleanBeforeTip": "清理此操作之前的台帳（保留本條起）",
        "gt.common.confirm": "確認",
        "gt.common.cancel": "取消",
        "gt.watch.sessionRepos": "本會話識別的 git 倉",
        "gt.watch.rolePrimary": "主倉",
        "gt.watch.roleSecondary": "副倉",
        "gt.watch.pinned": "已關注",
        "gt.watch.pin": "關注",
        "gt.watch.pinTip": "加入工作區關注路徑（跨會話持久）",
        "gt.watch.needCwd": "本頁沒有工作區上下文——請手動填寫 cwd 後 resolve。",
        "gt.watch.cleanup": "清理本工作區追蹤歷史",
        "gt.watch.cleanupConfirm": "刪除本工作區全部會話台帳並重置追蹤倉？",
        "gt.watch.cleanupTip": "只清除追蹤記錄：刪除本工作區全部會話台帳並重置追蹤倉（執行中的會話自動重建空倉繼續）。追蹤歷史一經清除無法找回。工作路徑裡的檔案與程式碼完全不受影響。",
        "gt.watch.cleanupDone": "已清理",
        "gt.watch.cleanupSessions": "個會話",
        "gt.watch.cleanupStore": "追蹤倉已重置",
        "gt.timeline.review": "評審",
        "gt.timeline.reviewSel": "評審所選 prompt",
        "gt.timeline.reviewGroup": "評審此 prompt（組內全部操作）",
        "gt.timeline.reviewSelTip": "範圍 = 首個~最後選中的組（中間連續組一併包含）",
        "gt.timeline.selGroup": "勾選此 prompt 參與跨組評審",
        "gt.timeline.empty": "該會話暫無操作記錄。",
        "gt.timeline.rollback": "回滾",
        "gt.timeline.viewdiff": "看 diff",
        "gt.timeline.openFile": "打開",
        "gt.timeline.openFileTip": "在右側檔案分頁開啟",
        "gt.timeline.atRef": "引用",
        "gt.timeline.atRefTip": "引用到當前會話輸入框（@ 路徑，不發送）",
        "gt.timeline.atNew": "新會話",
        "gt.timeline.atNewTip": "新建會話並預填引用（cwd 對齊檔案所在倉）",
        "gt.timeline.copyPath": "路徑",
        "gt.timeline.copyPathTip": "複製絕對路徑",
        "gt.timeline.copied": "已複製",
        "gt.tl.rowMention": "@ 此行到新會話（帶版本）",
        "gt.timeline.confirm": "把工作區回滾到此操作之前的狀態？",
        "gt.timeline.group": "用戶訊息",
        "gt.timeline.partialHint": "該操作為首觸（無 before 基線），無法逆向回滾；最早可恢復點為其 after 提交。",
        "gt.timeline.cross": "跨倉",
        "gt.timeline.leak": "外溢",
        "gt.timeline.partial": "部分",
        "gt.timeline.viewMsg": "按訊息",
        "gt.timeline.viewFile": "按檔案",
        "gt.timeline.viewTip": "切換分組：按用戶訊息 / 按檔案",
        "gt.timeline.fileTouch": "次操作",
        "gt.timeline.fileExpand": "展開觸達此檔案的操作",
        "gt.timeline.fileDiffTip": "評審此檔案的整個會話區間（最早基線 → 最新）",
        "gt.timeline.fileEmpty": "沒有檔案級變更（首觸基線快照不計入）",
        "gt.timeline.truncTip": "單 op 變更路徑僅記錄前 50 條（±N 計數為全量）",
        "gt.fork.title": "AI 變更處置",
        "gt.fork.desc": "被回撤 prompt 涉及以下操作：",
        "gt.fork.rollback": "回撤檔案變更",
        "gt.fork.keep": "保留中間變更",
        "gt.fork.cancel": "取消回撤",
        "gt.fork.done": "已回撤檔案變更",
        "gt.fork.aiTakeover": "讓 AI 處理",
        "gt.fork.ignore": "忽略，保留現狀",
        "gt.fork.skippedHint": "已回撤；{n} 個無基線操作被跳過、其變更保留。",
        "gt.fork.failTitle": "回撤中途失敗，部分變更未撤銷",
        "gt.fork.failDetail": "已撤 {applied}；跳過（無基線）{skipped}；失敗 @#{op}：{err}",
        "gt.fork.failHint": "選「讓 AI 處理」會把完整現場細節注入 AI 輸入框；「忽略」則保留現狀（已撤的生效，剩餘變更保留）。",
        "gt.fork.gap": "無基線",
        "gt.fork.gapTip": "該倉首次被追蹤，無 before 基線，此變更無法自動撤銷（將保留）。",
        "gt.banner.text": "本次回撤涉及 {n} 個被追蹤操作。",
        "gt.common.close": "關閉",
        // ── 變更總覽（overview 方案 §4，2026-09-08；append-only）──
        "gt.timeline.viewOverview": "變更總覽",
        "gt.timeline.viewTip2": "切換視圖：變更總覽 / 按操作 / 家譜",
        "gt.timeline.turnFilter": "輪次過濾（總覽）",
        "gt.timeline.allTurns": "全部輪次",
        "gt.ov.ops": "次操作",
        "gt.ov.files": "個檔案",
        "gt.ov.rollbacks": "次回撤",
        "gt.ov.binary": "二進位",
        "gt.ov.netNote": "行數按區間淨變更，可能含對同一檔案的其他改動。",
        "gt.ov.loading": "載入中…",
        "gt.ov.noFiles": "該範圍內沒有檔案級變更。",
        "gt.ov.storeMissing": "本會話涉及的倉沒有 trace store——無變更可彙總。",
        "gt.ov.filesTruncated": "變更檔案超過 2000，僅顯示前 2000。",
        "gt.ov.more": "顯示更多",
        "gt.ov.diffTruncated": "Diff 已截斷（共 {n} 行）。",
        "gt.ov.openReview": "在評審中開啟完整 diff",
        "gt.fork.turnFiles": "{n} 個檔案",
        "gt.footer.title": "git-trace 追蹤到、「改動的檔案」之外的變更（{n} 個被追蹤操作）；點檔案在時間線中查看 diff。",
        "gt.footer.more": "+{n}",
        "gt.footer.collapse": "收起",
        "gt.footer.truncated": "部分變更檔案未列出（台帳路徑數截斷）。",
      },
    },
  },

  // 跨扩展服务出口（惰性 getter：startup 后 configDir 才就绪；消费方每次访问现取，热重载/重装不悬空）
  services: {
    get trace() { return traceService(configDir); },
  },

  server: {
    startup(ctx: any) {
      hostCtx = ctx;
      configDir = ctx.configDir || "";
      extDir = ctx.dir || "";
      try { ensureExcludesFile(configDir); } catch {}
      // 数据分层（state 层）：台账落 state/ops（opsFile）；存量迁移由部署流程的一次性脚本负责
      // （scripts/migrate-state-tier.mjs），扩展不带运行时迁移。
      // 跨扩展服务出口（DI 方案 P1）：ctx.services 通道。traceService 方法全部惰性读盘，
      // provide 时固化实例安全；旧通道（__piWebExt.byId 穿透）双轨保留至消费方迁完。
      ctx.services?.provide?.("aiti-git-trace.trace", traceService(configDir));
      // 事件 sink：链式安装（保留前任），shutdown 时恢复——防热重载逐层堆旧 wrapper
      sinkPrev = (globalThis as any).__aitiTraceEmit;
      (globalThis as any).__aitiTraceEmit = traceSink;
      // 特性值落成 config.json（pi 扩展引擎创建时读一次；切换后需 reload 生效）
      try {
        // features.json 在 <dataRoot> 根级（configDir = <dataRoot>/<extId>/config → 上溯两级）
        const feats = JSON.parse(readFileSync(join(pathDirname(pathDirname(configDir)), "features.json"), "utf8"));
        const mine = feats["aiti-git-trace"] ?? {};
        const parseLines = (v: unknown) => String(v ?? "").split("\n").map((x: string) => x.trim()).filter(Boolean);
        const cfg = {
          enabled: mine["trace.enabled"] !== false,
          leakPolicy: "warn", // 已定调只记录不拦截（feature 项已移除；字段保留兼容旧 config.json）
          autoInit: mine["trace.autoInit"] !== false,
          autoInitMaxFiles: parseInt(String(mine["trace.autoInitMaxFiles"] || "2000"), 10) || 2000,
          seedCommonIgnores: mine["trace.autoInitSeedIgnores"] === true,
          // [P2-3] 以下 5 个此前为死开关——现已接通（引擎 opts 有对应消费方）
          excludeExtra: parseLines(mine["trace.excludeExtra"]),
          includeExtra: parseLines(mine["trace.includeExtra"]),
          builtinExcludes: mine["trace.builtinExcludes"] !== false,
          maxFileKB: parseInt(String(mine["trace.maxFileKB"] || "2048"), 10) || 2048,
          scope: mine["trace.scope"] === "cwd" ? "cwd" : "repo",
        };
        writeFileSync(join(configDir, "config.json"), JSON.stringify(cfg), "utf8");
      } catch { /* features.json 缺失/坏行：保持缺省（开） */ }
      startupCompactSelfCheck(); // 影子仓瘦身启动自检（24h 限流；异步延迟执行）
      console.log("[aiti-git-trace] 就绪 · configDir=" + configDir);
    },

    shutdown() {
      // 卸载 sink：仅当全局槽位仍是自己（后来者未覆盖时才安全恢复前任）
      try {
        if ((globalThis as any).__aitiTraceEmit === traceSink) {
          (globalThis as any).__aitiTraceEmit = sinkPrev;
        }
      } catch {}
      sinkPrev = undefined;
      traceBus.removeAllListeners("op");
    },

    async api(req: Request, ctx: any) {
      return handleApi(req, { path: ctx.path, searchParams: ctx.searchParams }, {
        configDir, dir: extDir,
        services: hostCtx?.services, // [P1-3] 意图维 join：services.plans（plan-first）进程内消费
        onTraceOp,
        // 宿主 allowed-roots 安全边界（缺失时放行——本地单测环境）
        allowRoot: async (p: string) => {
          try {
            const fa = hostCtx?.core?.fileAccess;
            if (!fa?.isAllowed) return true;
            return await fa.isAllowed(p);
          } catch { return true; }
        },
      });
    },
  },
} as any;
