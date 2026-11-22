#!/usr/bin/env node
/**
 * aiti-ai 统一一键部署（deploy-all）——把有变更的扩展 / pi 插件一次性部署到位。
 *
 * 覆盖范围：
 *   A. extensions/ 全部扩展（动态扫描有 tools/deploy.mjs 的目录，66+，含 demo）
 *      → 逐个跑 `node extensions/<dir>/tools/deploy.mjs`（各脚本自带构建/拷贝/deploy commit/双实例热重载）
 *   B. 自家 pi 插件 / 服务（本次新增）：
 *      - combo          pi-models-combo → ~/.pi/agent/pi-plugins/（install-plugin.mjs）
 *      - bridge         bridge 全家桶（extensions/aiti-attach-agent/tools/deploy.mjs）：
 *                       TUI pi-web-bridge + pi-web attach 后端 + bridge-core + aiti_* 连接器 bundle；
 *                       packages/aiti-devtools-core 有变更时附带 systemctl restart aiti-bridge（独立桥跑仓库源码）
 *   C. 直连条目（只提示，不部署）：
 *      - pi-git-trace   settings.json 本地路径直连，改源码即生效
 *      - pi-subagents 独立仓（npm:@aiti-ai/pi-subagents），不在本仓
 *
 * 变更检测（增量默认开）：
 *   - 条目路径 git status 未提交改动 → 变更
 *   - 上次部署记录的 HEAD 之后该路径有新 commit → 变更
 *   - 共享依赖变更联动：extensions/_shared → 全部 web-ext 扩展；
 *     packages/aiti-devtools-core → aiti-devtools + bridge；inject → aiti-devtools；agent → bridge
 *   - 状态文件：~/.cache/aiti-ai/deploy-state.json（无记录首次视为变更）
 *
 * 用法（参数风格与现有 deploy.mjs 一致）：
 *   node scripts/deploy-all.mjs                # 增量：只部署有变更的
 *   node scripts/deploy-all.mjs --all          # 全量（忽略变更检测）
 *   node scripts/deploy-all.mjs --only aiti-cmd,combo,bridge
 *   node scripts/deploy-all.mjs --skip demo,demo-lazy
 *   node scripts/deploy-all.mjs --list         # 只列出条目与变更状态
 *   node scripts/deploy-all.mjs --dry-run      # 列出将部署哪些，不执行
 *   node scripts/deploy-all.mjs --prod|--dev   # 透传给 aiti-devtools（唯一支持目标的子脚本），其余仍双写
 *   node scripts/deploy-all.mjs --restart-bridge # 强制重启独立桥 aiti-bridge
 *   node scripts/deploy-all.mjs --allow-conflicts  # 跳过冲突标记防呆（默认检测到 git 冲突标记即中止）
 *
 * 生效：web 扩展 = 各 deploy.mjs 末尾自动 POST /api/extensions/reload（允许失败）；
 *       批量场景下由本脚本统一批次合并（子条目注入 PI_WEB_DEFER_RELOAD=1 各自 defer，
 *       全部完成后收尾统一 reload 一轮——N 条目 × 2 实例 → 2 次 POST，避免 reload 风暴）；
 *       pi 插件 = 重启 pi 会话/进程生效；bridge-core 更新需重启 pi-web 进程（桥单例跨 reload，须用户确认，本脚本不自动做）。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;
const PI_WEB_EXT = join(REPO, "extensions");
const AGENT = homedir();

// ---------- 参数 ----------
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const DRY = has("--dry-run") || has("-n");
const ALL = has("--all");
const LIST = has("--list");
const RESTART_BRIDGE = has("--restart-bridge");
const ONLY = opt("--only") ? opt("--only").split(",").map((s) => s.trim()).filter(Boolean) : null;
const SKIP = opt("--skip") ? opt("--skip").split(",").map((s) => s.trim()).filter(Boolean) : [];
const DEVTOOLS_ARG = has("--prod") ? ["--prod"] : has("--dev") ? ["--dev"] : [];
const ALLOW_CONFLICTS = has("--allow-conflicts");

const STATE_FILE = join(process.env.XDG_CACHE_HOME || join(AGENT, ".cache"), "aiti-ai", "deploy-state.json");

// ---------- git 辅助 ----------
function git(outArgs, { cwd = REPO } = {}) {
  const r = spawnSync("git", outArgs, { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout : null;
}
const headRev = () => (git(["rev-parse", "HEAD"]) || "").trim() || null;

function dirtySig(paths) {
  // Dirty-workspace signature: porcelain (file list) + unstaged diff content hash, combined.
  // Porcelain alone under-reports "the same file edited multiple times within a session" (the file
  // list stays the same while the content changed → same hash → wrongly judged as no-change and not
  // deployed — bit us during the 2026-11-15 i18n batch injection); the diff content hash adds the
  // content dimension.
  const r = git(["status", "--porcelain", "--", ...paths]);
  const s = (r || "").trim();
  if (!s) return null;
  const d = git(["diff", "--", ...paths]);
  return createHash("sha1").update(s + "\n" + (d || "")).digest("hex").slice(0, 12);
}
function diffPaths(from, to, paths) {
  const r = git(["diff", "--name-only", `${from}..${to}`, "--", ...paths]);
  return !!(r && r.trim());
}

// ---------- 防呆：冲突标记检查 ----------
// 部署前扫描将部署路径的已跟踪文件，命中 git 冲突标记（7 字符后跟空格/行尾）即 fail-fast。
// 只扫已提交文件（git grep 忽略 untracked/node_modules/dist），避免把带冲突标记的源码 deploy 成坏产物。
function scanConflicts(paths) {
  const r = spawnSync(
    "git", ["grep", "-nE", "^(<<<<<<<|=======|>>>>>>>)( |$)", "--", ...paths],
    { cwd: REPO, encoding: "utf8" },
  );
  if (r.status === 1) return []; // 无匹配
  if (r.status !== 0) {
    const err = (r.stderr || "").trim();
    if (err) console.warn(`[防呆] git grep 扫描异常（沿用）：${err}`);
    return [];
  }
  return (r.stdout || "").trim().split("\n").filter(Boolean);
}

// ---------- 条目定义 ----------
// A. extensions/ 动态扫描（有 tools/deploy.mjs 的目录）
const extEntries = readdirSync(PI_WEB_EXT, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(PI_WEB_EXT, e.name, "tools", "deploy.mjs")))
  .map((e) => e.name)
  .sort()
  .map((d) => ({
    name: d,
    group: "web-ext",
    title: `扩展 ${d}`,
    cmd: [NODE, join(PI_WEB_EXT, d, "tools", "deploy.mjs"), ...(d === "aiti-devtools" ? DEVTOOLS_ARG : [])],
    paths: [`extensions/${d}`],
  }));

// B. 自家 pi 插件（symlink 直连的归入 directEntries）
const pluginEntries = [
  {
    name: "combo", group: "plugin", title: "pi-models-combo → ~/.pi/agent/pi-plugins/（pi-web 内置插件副本）",
    cmd: [NODE, join(REPO, "pi-plugins", "pi-models-combo", "tools", "install-plugin.mjs")],
    paths: ["pi-plugins/pi-models-combo"],
  },
  {
    name: "bridge", group: "plugin", title: "bridge 全家桶：TUI pi-web-bridge + attach 后端 + bridge-core + aiti_* bundle",
    cmd: [NODE, join(PI_WEB_EXT, "aiti-attach-agent", "tools", "deploy.mjs")],
    paths: ["extensions/aiti-attach-agent", "packages/aiti-devtools-pi", "packages/aiti-devtools-agent", "packages/aiti-devtools-core"],
    restartBridgeIf: ["packages/aiti-devtools-core"],
  },
];

// C. 直连条目（只提示，不部署）
const directEntries = [
  { name: "pi-git-trace", group: "direct", title: "settings.json 本地路径直连——改源码即生效，无需部署", paths: ["pi-plugins/pi-git-trace"] },
];

const ENTRIES = [...extEntries, ...pluginEntries, ...directEntries];

// ---------- 共享依赖联动 ----------
const SHARED_TRIGGERS = [
  { key: "_shared", paths: ["extensions/_shared"], affects: (e) => e.group === "web-ext" },
  { key: "_core", paths: ["packages/aiti-devtools-core"], affects: (e) => e.name === "aiti-devtools" || e.name === "bridge" },
  { key: "_inject", paths: ["packages/aiti-devtools-inject"], affects: (e) => e.name === "aiti-devtools" },
  { key: "_agent", paths: ["packages/aiti-devtools-agent"], affects: (e) => e.name === "bridge" },
];

// ---------- 状态 ----------
function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}
function saveState(s) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + "\n");
}

// ---------- 变更检测 ----------
// 判据：相对「上次部署时记录的 HEAD + 脏状态签名」内容是否变了。
//   - 未提交改动但签名没变（重复跑）→ 不重复部署
//   - 部署后 commit 了同一内容 → diff(st.head..head) 空 → 不重复部署
//   - 新 commit / 新改动 / 无记录 / st.head 失效（rebase）→ 变更
function pathChanged(key, paths, state, head) {
  const st = (state.entries || {})[key];
  const sig = dirtySig(paths);
  if (sig) return !st || st.dirty !== sig || st.head !== head;
  if (!st) return true; // 从未部署过（或历史状态无记录）
  if (st.head && head && st.head !== head) {
    try { return diffPaths(st.head, head, paths); } catch { return true; }
  }
  return false;
}
function computeChanged(state, head) {
  const sharedHit = SHARED_TRIGGERS.filter((t) => pathChanged(t.key, t.paths, state, head));
  const map = new Map();
  for (const e of ENTRIES) {
    if (e.group === "direct") { map.set(e.name, false); continue; }
    if (ALL || (ONLY && ONLY.includes(e.name))) { map.set(e.name, true); continue; }
    let ch = pathChanged(e.name, e.paths, state, head);
    if (!ch && sharedHit.length) ch = sharedHit.some((t) => t.affects(e));
    map.set(e.name, ch);
  }
  return map;
}

// ---------- 执行 ----------
function runEntry(e) {
  console.log(`\n━━━ [${e.name}] ${e.title} ━━━`);
  if (e.fn) { e.fn(); return true; }
  // PI_WEB_DEFER_RELOAD=1：子部署脚本末尾的 reloadInstances 跳过（打印 defer），
  // 由本脚本收尾统一执行一轮——批次合并，避免 N 条目逐个全量热重载。
  const r = spawnSync(e.cmd[0], e.cmd.slice(1), {
    cwd: REPO,
    stdio: "inherit",
    env: { ...process.env, PI_WEB_DEFER_RELOAD: "1" },
  });
  if (r.status !== 0) { console.error(`[${e.name}] deploy 失败（exit ${r.status ?? r.error?.code}）`); return false; }
  return true;
}
function restartBridge() {
  const active = spawnSync("systemctl", ["is-active", "--quiet", "aiti-bridge"]).status === 0;
  if (!active) { console.log("[bridge] 独立桥 aiti-bridge 未在运行，跳过重启"); return; }
  const r = spawnSync("systemctl", ["restart", "aiti-bridge"]);
  if (r.status === 0) console.log("[bridge] ✓ systemctl restart aiti-bridge（独立桥跑仓库源码，重启即新）");
  else console.log("[bridge] ✗ 重启失败——手动执行：systemctl restart aiti-bridge");
}

function main() {
  return mainAsync();
}

async function mainAsync() {
  const state = loadState();
  if (!state.entries) state.entries = {};
  const head = headRev();
  const changed = computeChanged(state, head);

  // 协议声明预检（warn-only，不阻断）：扩展 package.json 的 aitiExtProtocol
  // （扩展协议声明；缺声明/过期不拦部署，但提示走 extman 的 AI 升级）。
  try {
    // Optional external quality gates (a separate policy repo on dev machines); unset → precheck skipped.
    const gatesDir = process.env.AITI_GATES_DIR || "";
    if (!gatesDir || !existsSync(join(gatesDir, "check-ext-protocol.mjs"))) throw new Error("no gates");
    const r = spawnSync(NODE, [join(gatesDir, "check-ext-protocol.mjs"), "--json", "--warn"], { cwd: REPO, encoding: "utf8" });
    const j = JSON.parse(r.stdout || "{}");
    if (j && j.ok === false && j.summary) {
      const s = j.summary;
      console.warn(`⚠ [协议预检] 扩展协议声明异常：missing=${s.missing} invalid=${s.invalid} stale=${s.stale} incompatible=${s.incompatible} too_new=${s.too_new}（不阻断部署）`);
    }
  } catch { /* 预检失败不影响部署 */ }

  // 将被部署的条目（DRY/LIST 也用它做冲突预告）
  const targets = ENTRIES.filter((e) => e.group !== "direct"
    && changed.get(e.name) && !SKIP.includes(e.name) && (!ONLY || ONLY.includes(e.name)));

  // 防呆：冲突标记检查（部署前 fail-fast；--dry-run 只预告不阻断；--list 不扫）
  if (!LIST && targets.length) {
    const hits = scanConflicts([...new Set(targets.flatMap((t) => t.paths))]);
    if (hits.length) {
      const detail = hits.map((h) => "  " + h).join("\n");
      if (DRY) {
        console.warn(`⚠ [防呆] 检测到 ${hits.length} 处 git 冲突标记，正式部署会中止（--dry-run 仅预告）：\n${detail}`);
      } else if (ALLOW_CONFLICTS) {
        console.warn(`⚠ [防呆] 检测到 ${hits.length} 处 git 冲突标记（--allow-conflicts 显式允许，继续）：\n${detail}`);
      } else {
        console.error(`✋ [防呆] 中止部署：工作区存在未解决的 git 冲突标记（${hits.length} 处），会被 deploy 成坏产物。\n${detail}\n请先解决冲突后重试；确需强行部署加 --allow-conflicts。`);
        process.exit(1);
      }
    }
  }

  if (LIST || DRY) {
    console.log(`aiti-ai 部署清单（HEAD ${head ? head.slice(0, 9) : "?"}${ALL ? " · --all 全量" : ""}）：\n`);
    for (const e of ENTRIES) {
      if (e.group === "direct") { console.log(`  ○ ${e.name.padEnd(22)} 直连·无需部署 — ${e.title}`); continue; }
      const ch = changed.get(e.name);
      const mark = ch ? "● 变更" : "  无变更";
      const sel = ONLY && !ONLY.includes(e.name) ? "（--only 未选）" : SKIP.includes(e.name) ? "（--skip）" : "";
      console.log(`  ${mark}  ${e.name.padEnd(22)} ${sel}${e.title}`);
    }
    const n = ENTRIES.filter((e) => e.group !== "direct" && changed.get(e.name) && !SKIP.includes(e.name)).length;
    console.log(`\n共 ${ENTRIES.filter((e) => e.group !== "direct").length} 个部署条目，本次变更 ${n} 个。`);
    if (LIST) return;
    if (!n) { console.log("无变更，无需部署。"); return; }
    if (DRY) { console.log("(--dry-run 未执行)"); return; }
  }

  console.log(`部署 ${targets.length} 个条目：${targets.map((t) => t.name).join(", ") || "（无）"}`);
  const failed = [];
  let restartBridgeNow = RESTART_BRIDGE;
  let done = 0;
  for (const e of targets) {
    done++;
    console.log(`\n【${done}/${targets.length}】`);
    // bridge 重启判定要在写状态前用旧记录判（core 相对上次部署是否变了）
    if (e.restartBridgeIf && pathChanged("_core", e.restartBridgeIf, state, head)) restartBridgeNow = true;
    if (runEntry(e)) {
      state.entries[e.name] = { head, dirty: dirtySig(e.paths), at: new Date().toISOString() };
      // 受影响共享依赖一并记状态，避免下次重复联动部署
      for (const t of SHARED_TRIGGERS) {
        if (t.affects(e)) state.entries[t.key] = { head, dirty: dirtySig(t.paths), at: new Date().toISOString() };
      }
      saveState(state); // 逐条目即时持久化——中断不丢进度，重跑自动续
    } else failed.push(e.name);
  }

  // 直连条目提示（只打一次）
  if (!LIST && !DRY) for (const e of directEntries) console.log(`[直连] ${e.name}：${e.title}`);

  if (restartBridgeNow) { console.log(""); restartBridge(); }

  // ── 批次合并热重载（收尾统一执行）：子条目部署脚本被 PI_WEB_DEFER_RELOAD=1 defer 掉的 reload ──
  // 只发一轮（dev+prod 各 1 次 POST）；允许失败永不影响退出码。无实际部署（list/dry-run）不触发。
  if (!LIST && !DRY && targets.length > 0) {
    try {
      const { reloadInstances } = await import("../extensions/_shared/reload-instances.mjs");
      await reloadInstances("[deploy-all] ");
    } catch (e) {
      console.log("[deploy-all] 统一 reload 未执行（" + String((e && e.message) || e) + "）— 需手动 POST /api/extensions/reload");
    }
  }

  state.lastHead = head; // 兼容旧字段
  state.updatedAt = new Date().toISOString();
  saveState(state);

  console.log(`\n━━━ 汇总：成功 ${targets.length - failed.length} / ${targets.length}${failed.length ? `，失败：${failed.join(", ")}` : ""} ━━━`);
  console.log("提示：bridge-core 更新需重启 pi-web 进程才生效（桥单例跨 reload）——生产重启须用户确认，本脚本不自动做。");
  if (failed.length) process.exit(1);
}

main().catch((e) => { console.error("[deploy-all] 未捕获错误：", e); process.exit(1); });
