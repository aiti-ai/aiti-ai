/**
 * session-manager — server API (dispatched via /api/extensions/session-manager/...).
 *
 * Tag mutations are server-side actions under an optimistic version lock (409 →
 * client re-fetches + retries once). Phase 2 adds search (FTS5 index) and
 * archive (.pwarc brotli containers) endpoints.
 */
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";

// 扩展 server 模块加载时刻（≈ pi-web/扩展 restart）：冷启动窗口基点（见 mergedSessionsEndpoint）。
// 无条件覆盖（非 ??=）：热重载 reload 模块重评时 globalThis 保留旧值，??= 会沿用旧时刻致窗口错位。
(globalThis as { __smBootAt?: number }).__smBootAt = Date.now();
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { readTagData, writeTagData } from "./tags-store.ts";
import { handleWorkspaceUpload, handleCapabilities } from "./workspace-upload.ts";
import { noteAssembledRows } from "./activity-bus.ts";
import { parseSessionFile } from "../lib/session-file.ts";
import {
  deleteTagNode, findOrCreateTagPath, renameTagNode, setSessionTag, setTagColor,
  toggleFavorite, validateTagData, type TagData,
} from "../lib/session-tags.ts";
import {
  archiveStatus, clearArchiveCache, deleteArchived, extractArchived, restoreArchived,
  guardedSessionIds, hideExtSession, loadSettings, releaseIdleFor, runtime, runArchive, runExtArchive, restoreExtArchive, saveSettings, syncIndex,
  unhideExtSession,
  type ExtCoreLike,
  type Settings,
} from "./runtime.ts";
import { computeStats } from "../lib/session-stats.ts";
import { activateSource, activeAgents, autoSyncStaleSources, deactivateSource, discoverSources, enrichExtPlaceholders, ensureProviders, getAdapter, refreshLiveExtTimestamps, registerProvider, resolveExtId, syncSource, unregisterProvider } from "./ext-sources.ts";
import { writePiSession, encodeCwd } from "../lib/agents/to-pi.ts";
import { archiveCapableAgents } from "../lib/agents/registry.ts";
import { extractHotwordsFromDBAsync } from "../lib/hotwords.ts";
import { encodeSessionsV2 } from "./payload.ts";

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

export interface ExtApiCtx {
  configDir: string;
  /** 缓存区（三目录对称：<extRoot>/cache）；旧宿主/测试缺省时由 dirname(configDir) 推导 */
  cacheDir?: string;
  path: string[];
  searchParams: URLSearchParams;
  core: ExtCoreLike;
  /** 跨扩展服务定位器（框架 ExtServerContext.services；宽松类型避免依赖框架包） */
  services?: {
    get?: <T = unknown>(key: string) => T | undefined;
  };
}

/**
 * tag 数据变更广播（event-bus）：写成功（版本 +1）后推一帧 `sm:tags-changed { version }`
 * 给所有已连接页面。客户端收到帧后版本守卫刷新（version 与本地一致 = 本 tab 已本地落地，跳过）。
 * 防御式：aiti-event-bus 未装/未 startup 时 get 返回 undefined，静默跳过——帧只加速跨
 * tab/跨实例同步，缺了也不影响本 tab 的本地落地（POST/PUT 响应直接写 store）。
 */
function publishTagsChanged(ctx: ExtApiCtx, version: number) {
  try {
    const bus = ctx.services?.get?.<{ publish?: (type: string, data?: Record<string, unknown>) => void }>(
      "aiti-event-bus.publish",
    );
    bus?.publish?.("sm:tags-changed", { version });
  } catch { /* 非浏览器/缺席静默 */ }
}

function mutate(ctx: ExtApiCtx, version: unknown, fn: (d: TagData) => TagData | null): Response {
  const current = readTagData(ctx.configDir);
  if (typeof version === "number" && current.version !== version) {
    return json({ error: "version conflict", current }, 409);
  }
  const next = fn(current);
  if (!next) return json({ error: "invalid operation" }, 400);
  next.version = current.version + 1;
  writeTagData(ctx.configDir, next);
  publishTagsChanged(ctx, next.version);
  return json({ ok: true, data: next });
}

/**
 * Move 端点共用的缓存失效：pi-web lib/session-reader 把列表/路径缓存放 globalThis
 * （热重载安全），扩展服务端与它同进程——直接改写（同 __smGcPending 手法）。
 * 列表缓存整体失效；路径缓存原地更新（id→新路径、旧路径反查清除），避免
 * move 之后 resolveSessionPath 还指向旧文件。
 */
function invalidatePiSessionCaches(sessionId: string, oldPath: string, newPath: string): void {
  type Caches = {
    __piSessionListGeneration?: number;
    __piSessionListCache?: unknown;
    __piSessionPathCache?: Map<string, string>;
    __piPathToSessionIdCache?: Map<string, string>;
  };
  const g = globalThis as typeof globalThis & Caches;
  g.__piSessionListGeneration = (g.__piSessionListGeneration ?? 0) + 1;
  g.__piSessionListCache = undefined;
  const norm = (p: string) => p; // posix normalize 等价（Linux 单平台，路径已绝对化）
  const pathCache = g.__piSessionPathCache;
  const revCache = g.__piPathToSessionIdCache;
  if (pathCache) {
    if (revCache) revCache.delete(norm(oldPath));
    pathCache.set(sessionId, newPath);
    if (revCache) revCache.set(norm(newPath), sessionId);
  }
}

/**
 * pi agent 目录：PI_CODING_AGENT_DIR 优先（Docker/Windows 数据根独立于 ~/.pi）；
 * 未设 = <homeDir>/.pi/agent 原行为。homeDir 仅在 env 未设时参与拼接。
 */
function piAgentDir(homeDir: string): string {
  return process.env.PI_CODING_AGENT_DIR || join(homeDir, ".pi", "agent");
}

/**
 * POST /move · 把 live pi 会话搬到另一个 cwd 名下（发错文件夹的会话迁移）。
 * 做法：改写 JSONL header 的 cwd 字段 → 文件移入目标 cwd 对应的 pi 会话目录
 * （<agentDir>/sessions/--home-...-dir--）。sessionId 不变 → 收藏/标签全保留。
 * 运行中会话拒绝（文件被 rpc wrapper 持有）；归档记录/外部 agent 会话不适用。
 */
async function moveEndpoint(ctx: ExtApiCtx, body: Record<string, unknown> | null): Promise<Response> {
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
  const rawCwd = typeof body?.cwd === "string" ? body.cwd.trim() : "";
  if (!sessionId || !rawCwd) return json({ error: "sessionId and cwd required" }, 400);
  const targetCwd = resolve(rawCwd);
  if (!isAbsolute(targetCwd) || !existsSync(targetCwd) || !statSync(targetCwd).isDirectory()) {
    return json({ error: `target directory not found: ${targetCwd}` }, 400);
  }

  const live = await ctx.core.listSessions();
  const s = live.find((x) => x.id === sessionId);
  if (!s?.path || !existsSync(s.path)) return json({ error: "session not found or not a local pi session" }, 404);
  // alive-but-idle handle：对话已结束仅挂载时自动释放（归档同款，core.stopAliveSession），
  // 不再要求用户先关页面；真 running / 释放失败的会话仍被守卫拒绝。
  const guard = await releaseIdleFor([sessionId], ctx.core);
  if (guard.has(sessionId)) return json({ error: "session is open — archive/move it after it finishes" }, 409);

  // 读 header，确认是 pi session 文件并拿到旧 cwd
  const raw = readFileSync(s.path, "utf8");
  const nl = raw.indexOf("\n");
  let header: Record<string, unknown>;
  try { header = JSON.parse(nl === -1 ? raw : raw.slice(0, nl)) as Record<string, unknown>; }
  catch { return json({ error: "not a valid pi session file" }, 400); }
  if (header.type !== "session") return json({ error: "not a valid pi session file" }, 400);

  const homeDir = await ctx.core.getHomeDir().catch(() => process.env.HOME ?? "");
  if (!homeDir && !process.env.PI_CODING_AGENT_DIR) return json({ error: "cannot resolve home dir for sessions path" }, 500);
  const destDir = join(piAgentDir(homeDir), "sessions", encodeCwd(targetCwd));
  const newPath = join(destDir, basename(s.path));
  if (newPath === s.path && header.cwd === targetCwd) return json({ ok: true, alreadyThere: true, path: newPath, cwd: targetCwd });
  // 目标重名保护：rename 会静默覆盖 POSIX 同名文件，绝不能碰别人的会话
  if (newPath !== s.path && existsSync(newPath)) {
    return json({ error: `a session file with the same name already exists in the target project: ${basename(newPath)}` }, 409);
  }

  const tmp = join(destDir, `.${basename(newPath)}.moving`);
  try {
    mkdirSync(destDir, { recursive: true });
    // 先写临时文件再 rename：中途失败原文件不受影响
    header.cwd = targetCwd;
    const content = JSON.stringify(header) + (nl === -1 ? "" : raw.slice(nl));
    writeFileSync(tmp, content, { flag: "wx" });
    renameSync(tmp, newPath);
    // 原地改写（newPath === s.path，如同 slug 不同 header 的别名场景）绝不能 unlink 自己
    if (s.path !== newPath) unlinkSync(s.path);
  } catch (e) {
    // 失败清理：tmp 残留会阻断下一次 wx 写入
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }

  invalidatePiSessionCaches(sessionId, s.path, newPath);
  // 索引里的 path/cwd 行同步更新（sync 走刚失效过的 core 列表）
  try { await syncIndex(ctx.configDir, ctx.core); } catch { /* 下次定时同步兜底 */ }
  return json({ ok: true, path: newPath, cwd: targetCwd, oldPath: s.path });
}

/**
 * POST /move-batch · 把一个 workspace 下全部 live pi 会话搬到另一个 cwd 名下
 * （删除工作区时「全部移动」选项）。逐会话复用 move 的写路径，汇总 moved/skipped
 * （运行中/外部 agent/归档记录不适用，跳过并说明）。
 */
async function moveBatchEndpoint(ctx: ExtApiCtx, body: Record<string, unknown> | null): Promise<Response> {
  const rawIds = Array.isArray(body?.sessionIds) ? body.sessionIds.filter((x): x is string => typeof x === "string") : [];
  const rawCwd = typeof body?.cwd === "string" ? body.cwd.trim() : "";
  if (!rawIds.length || !rawCwd) return json({ error: "sessionIds and cwd required" }, 400);
  const targetCwd = resolve(rawCwd);
  if (!isAbsolute(targetCwd) || !existsSync(targetCwd) || !statSync(targetCwd).isDirectory()) {
    return json({ error: `target directory not found: ${targetCwd}` }, 400);
  }

  const live = await ctx.core.listSessions();
  // 批量释放 alive-but-idle handle（running 不碰；旧核心无 stopAliveSession 则原守卫）
  const guard = await releaseIdleFor(rawIds, ctx.core);
  const homeDir = await ctx.core.getHomeDir().catch(() => process.env.HOME ?? "");
  if (!homeDir && !process.env.PI_CODING_AGENT_DIR) return json({ error: "cannot resolve home dir for sessions path" }, 500);

  const moved: Array<{ sessionId: string; path: string; cwd: string }> = [];
  const skipped: Array<{ sessionId: string; reason: string }> = [];

  for (const sessionId of rawIds) {
    const s = live.find((x) => x.id === sessionId);
    if (!s?.path || !existsSync(s.path)) {
      skipped.push({ sessionId, reason: "session not found or not a local pi session" });
      continue;
    }
    if (guard.has(sessionId)) {
      skipped.push({ sessionId, reason: "session is open — archive/move it after it finishes" });
      continue;
    }
    // 读 header，确认是 pi session 文件
    const raw = readFileSync(s.path, "utf8");
    const nl = raw.indexOf("\n");
    let header: Record<string, unknown>;
    try { header = JSON.parse(nl === -1 ? raw : raw.slice(0, nl)) as Record<string, unknown>; }
    catch { skipped.push({ sessionId, reason: "not a valid pi session file" }); continue; }
    if (header.type !== "session") { skipped.push({ sessionId, reason: "not a valid pi session file" }); continue; }

    const destDir = join(piAgentDir(homeDir), "sessions", encodeCwd(targetCwd));
    const newPath = join(destDir, basename(s.path));
    if (newPath === s.path && header.cwd === targetCwd) {
      moved.push({ sessionId, path: newPath, cwd: targetCwd });
      continue;
    }
    if (newPath !== s.path && existsSync(newPath)) {
      skipped.push({ sessionId, reason: `a session file with the same name already exists in the target project: ${basename(newPath)}` });
      continue;
    }
    const tmp = join(destDir, `.${basename(newPath)}.moving`);
    try {
      mkdirSync(destDir, { recursive: true });
      header.cwd = targetCwd;
      const content = JSON.stringify(header) + (nl === -1 ? "" : raw.slice(nl));
      writeFileSync(tmp, content, { flag: "wx" });
      renameSync(tmp, newPath);
      if (s.path !== newPath) unlinkSync(s.path);
      invalidatePiSessionCaches(sessionId, s.path, newPath);
      moved.push({ sessionId, path: newPath, cwd: targetCwd });
    } catch (e) {
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
      skipped.push({ sessionId, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  // 索引里的 path/cwd 行同步更新（sync 走刚失效过的 core 列表）
  try { await syncIndex(ctx.configDir, ctx.core); } catch { /* 下次定时同步兜底 */ }
  return json({ ok: true, moved, skipped, movedCount: moved.length, skippedCount: skipped.length });
}

/**
 * POST /session-cwd · 识别一个会话的「真实 CWD」——依据它操作过的文件推断最可能的项目目录。
 * 做法：parseSessionFile 拿 files[]（已按修改次数降序）；对每个文件向上找最近的 git 根
 * （自然项目单元），无 git 则退回文件所在目录；按项目根聚合计数（edit 优先加权）。
 * 返回当前 header.cwd（旧值）作对照 + top 候选根（含触达文件数）。
 */
async function detectSessionCwdEndpoint(ctx: ExtApiCtx, body: Record<string, unknown> | null): Promise<Response> {
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
  if (!sessionId) return json({ error: "sessionId required" }, 400);
  const live = await ctx.core.listSessions();
  const s = live.find((x) => x.id === sessionId);
  if (!s?.path || !existsSync(s.path)) return json({ error: "session not found or not a local pi session" }, 404);
  const raw = readFileSync(s.path, "utf8");
  const parsed = parseSessionFile(s.path, raw);
  if (!parsed) return json({ error: "not a valid pi session file" }, 400);

  // 项目根判定：向上找最近的含 .git 的目录（git 仓库=自然项目单元）；无 git 退回文件所在目录
  const projetRootOf = (filePath: string): string => {
    let dir = dirname(filePath);
    let guard = 0;
    while (guard++ < 30) {
      if (existsSync(join(dir, ".git")) || existsSync(join(dir, ".hg"))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return dirname(filePath);
  };

  // 按项目根聚合：根 → { 文件数, 深度和 }。files[] 已按 edit→touches 降序，rank 越靠前修改越重。
  const byRoot = new Map<string, { count: number; weighted: number; depthSum: number }>();
  filesSample: {
    // 只用 files 前 40 个（weighted 权重随 rank 递减：越靠前=修改越重）
    const files = parsed.files.slice(0, 40);
    for (let i = 0; i < files.length; i++) {
      const root = projetRootOf(files[i]);
      const weight = files.length - i; // 靠前的文件权重更高
      const prev = byRoot.get(root);
      if (prev) { prev.count++; prev.weighted += weight; prev.depthSum += files[i].length; }
      else byRoot.set(root, { count: 1, weighted: weight, depthSum: files[i].length });
    }
  }

  const candidates = [...byRoot.entries()]
    .map(([root, st]) => ({ root, count: st.count, weighted: st.weighted }))
    .sort((a, b) => b.weighted - a.weighted || b.count - a.count)
    .slice(0, 5);
  const current = parsed.meta.cwd ?? "";
  const topCandidate = candidates[0]?.root ?? "";
  // suggest = 头部候选（最可能真实项目目录）。若首候选即等于 header cwd，说明会话已在正确
  // 项目下，无需移动（UI 上会显示「当前」，用户可自行判断）。
  return json({
    ok: true,
    current,
    candidates,
    suggest: topCandidate || current,
  });
}

async function bodyJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/* ── 宿主占位注册表兑底标注（2026-09-08）──
 *
 * pi-web core 为外部会话落站位文件时同步写注册表 external-session-placeholders.json
 * （在 dataRoot 根，lib/session/placeholder.ts）。列表富化在索引行缺席时用它
 * 兑底还原 extId/agent —— 与宿主 stampExternalSessions 同源，mtime 懒重读支持
 * dev/prod 双实例共享（另一进程写入后本进程下次访问自动拿新）。
 * 键：站位 uuid（pi 行 id）；值：{ extId, agent }。*/
let phCache: { mtimeMs: number; map: Map<string, { extId: string; agent: string }> } | null = null;

function placeholderIndex(configDir: string): Map<string, { extId: string; agent: string }> {
  // configDir = <dataRoot>/<extId>/config → dataRoot = dirname(dirname(configDir))
  const file = join(dirname(dirname(configDir)), "external-session-placeholders.json");
  let mtimeMs = -1;
  try { mtimeMs = statSync(file).mtimeMs; } catch { return new Map(); }
  if (phCache && phCache.mtimeMs === mtimeMs) return phCache.map;
  const map = new Map<string, { extId: string; agent: string }>();
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { sessions?: Array<{ uuid?: string; extId?: string; agent?: string }> };
    for (const s of raw.sessions ?? []) {
      if (s?.uuid && s.extId && s.agent) map.set(s.uuid, { extId: s.extId, agent: s.agent });
    }
  } catch { /* 损坏 → 空表（索引行为主路径，注册表只是兑底） */ }
  phCache = { mtimeMs, map };
  return map;
}

/* ── 索引 sync 节流自愈（2026-09-08）──
 * mergedSessions 每次 GET 触发；60s 节流 + in-flight 锁。sync 本身增量（mtime
 * watermark 跳过未变文件），稳态开销小。 */
let idxSyncLastAt = 0;
let idxSyncInflight = false;
const IDX_SYNC_MIN_INTERVAL_MS = 60_000;

async function maybeSyncIndex(ctx: ExtApiCtx): Promise<void> {
  const now = Date.now();
  if (idxSyncInflight || now - idxSyncLastAt < IDX_SYNC_MIN_INTERVAL_MS) return;
  idxSyncInflight = true;
  idxSyncLastAt = now; // 失败也推进节流点：防高频 GET 反复重试放大故障
  try {
    await syncIndex(ctx.configDir, ctx.core);
  } catch { /* best-effort：索引滞后由下一轮补 */ }
  finally { idxSyncInflight = false; }
}

/** workspace key 归一化（与客户端 sidebar/pure.ts normalizeWorkspaceKey 同口径）：
 *  Windows 盘符/反斜杠路径 → lowercase + 正斜杠。posix 路径恒等。 */
function normalizeWorkspaceKeyServer(key: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(key) || key.includes("\\")) {
    return key.replace(/\\/g, "/").toLowerCase();
  }
  return key;
}

/**
 * workspace（项目）列表通道（通道拆分方案 §2 B1）。
 *
 * 与 /sessions 同源（core.listSessions + 外部 agent 索引行），但只做**项目级聚合**：
 * 不跑逐行 rowRev/SHA1、不做 1MB 序列化、不做会话标注、不做归档拆分 → 载荷 KB 级、TTFB 快。
 * 项目集合口径 = 全量列表项目口径（同 workspaceKeyOf），保证不丢项目。
 * rev = sha1(key|lastModified|sessionCount|runningCount|unreadCount)；If-None-Match → 304。
 */
async function workspacesEndpoint(ctx: ExtApiCtx, req?: Request): Promise<Response> {
  const live = await ctx.core.listSessions();
  const running = new Set(await ctx.core.getRunningSessionIds());
  const unread = new Set((ctx.searchParams.get("unread") ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const activeExt = activeAgents(ctx.configDir);
  // 与 /sessions 同一行口径：已由 pi 站位行接管（placeholder）的 ext 行从列表剔除、
  // 由 pi 行代表——workspaces 也须排除，否则该 ext 行的 cwd 会多出一个幽灵项目、
  // 且在共享目录下重复计数（实测 aiti-ai sessionCount 1227 虚高到 1085、
  //   /tmp/cbc/e2e 幽灵项目）。placeholder 来源：注册表（external-session-placeholders.json）
  // + pi live 行索引 ext_id（getSessionBatch）。
  const placeholderExtIds = new Set<string>();
  try {
    const idx = runtime(ctx.configDir).index;
    const placeholders = placeholderIndex(ctx.configDir);
    for (const p of placeholders.values()) placeholderExtIds.add(p.extId);
    const rows = idx.getSessionBatch(live.map((s) => (s as { id: string }).id).filter(Boolean));
    for (const r of rows.values()) if (r.extId) placeholderExtIds.add(r.extId);
  } catch { /* 索引/注册表不可用 → 退化为全量 ext 聚合（最差不丢项目） */ }
  const extRowsRaw = activeExt.length ? runtime(ctx.configDir).index.extRows(activeExt) : [];
  const extRows = extRowsRaw.filter((r) => !placeholderExtIds.has(r.id));

  type Agg = { key: string; root: string; name?: string; lastModified: string; sessionCount: number; runningCount: number; unreadCount: number };
  const agg = new Map<string, Agg>();
  const bump = (id: string, root: string, key: string, modified: string) => {
    if (!root || !key) return;
    let a = agg.get(key);
    if (!a) {
      a = { key, root, name: basename(root) || undefined, lastModified: modified, sessionCount: 0, runningCount: 0, unreadCount: 0 };
      agg.set(key, a);
    }
    a.sessionCount += 1;
    if (modified > a.lastModified) a.lastModified = modified;
    if (running.has(id)) a.runningCount += 1;
    if (unread.has(id)) a.unreadCount += 1;
  };
  for (const s of live as Array<{ id: string; cwd: string; projectRoot?: string; projectKey?: string; modified: string }>) {
    const root = s.projectRoot ?? s.cwd;
    bump(s.id, root, normalizeWorkspaceKeyServer(s.projectKey ?? root), s.modified);
  }
  // 外部 agent 会话（zcode/claude/…）行只有 cwd（无 projectRoot/projectKey）——按 cwd 聚合
  for (const r of extRows as Array<{ id: string; cwd: string; modified: string }>) {
    bump(r.id, r.cwd, normalizeWorkspaceKeyServer(r.cwd), r.modified);
  }
  const workspaces = [...agg.values()].sort((a, b) => b.lastModified.localeCompare(a.lastModified));
  const rev = createHash("sha1").update(
    workspaces.map((w) => `${w.key}|${w.lastModified}|${w.sessionCount}|${w.runningCount}|${w.unreadCount}`).join(";"),
  ).digest("hex");
  const etag = `"${rev}"`;
  if (req?.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "no-store" } });
  }
  return json({ rev, workspaces }, 200, { ETag: etag });
}

function searchEndpoint(ctx: ExtApiCtx): Response {
  const q = ctx.searchParams.get("q") ?? "";
  const limit = Number(ctx.searchParams.get("limit") ?? 50);
  // §5.5.4 filters: model / role / archived
  const model = ctx.searchParams.get("model") || undefined;
  const role = ctx.searchParams.get("role") || undefined;
  const archivedParam = ctx.searchParams.get("archived");
  const archived = archivedParam === "1" ? true : archivedParam === "0" ? false : undefined;
  const hits = runtime(ctx.configDir).index.search(q, limit, { model, role, archived });
  return json({ q, model, role, archived, hits });
}

async function mergedSessionsEndpoint(ctx: ExtApiCtx, req?: Request): Promise<Response> {
  const core = ctx.core;
  // 请求驱动自愈（非轮询：没有 GET 就没有动作；内部 in-flight/节流防抖）：
  //   1) 索引 sync（60s 节流）：新站位文件/新 pi 会话尽快入索引（此前只有 startup/
  //      归档/手动 sync 才跑 → 站位行裸奔、徽标时有时无，实测 2026-09-07 zcode 双条目）；
  //   2) active 外部源 stale 补同步：probe watermark 变了才后台 syncSource →
  //      新外部会话的 ext 行自动补齐（zcode 此前停在最后一次手动 sync）。
  // 两者都后台跑不阻塞响应：本轮返回旧数据，sync 完成后 ETag/rowRev 变化由既有
  // 轮询/304 通道自然拉新。
  void maybeSyncIndex(ctx);
  void autoSyncStaleSources(ctx.configDir, runtime(ctx.configDir).index);
  // 运行中 ext 会话时间戳-only 刷新（listFresh 轻量快照 → 只前进 modified）。
  // 后台宏任务跑（setImmediate 让出事件循环，响应先 flush 拿上一轮值）：listFresh
  // 全部是同步 fs/sqlite 扫描，纯 void 化不让出循环、TTFB 照旧背全程；后台写库后
  // rev/ETag 变化由既有 since/If-None-Match 增量通道自然拉新（严格前进才写，无风暴）。
  setImmediate(() => { void refreshLiveExtTimestamps(ctx.configDir, runtime(ctx.configDir).index).catch(() => {}); });
  const forceRefresh = req ? new URL(req.url).searchParams.get("refresh") === "1" : false;
  // ── 通道拆分（方案 §2 B2）：project=<key> 作用域模式 ──
  // 装配前按项目过滤 live 行（key 归一化同客户端 workspaceKeyOf），全链路在小子集上跑；
  // 作用域模式不读写全量装配 memo、不启用 since/patch（scoped 载荷本就小，永远回全量 scoped）。
  const projectParam = ctx.searchParams.get("project");
  const projectFilter = projectParam ? normalizeWorkspaceKeyServer(projectParam) : null;
  const scoped = projectFilter != null;
  const liveAll = await core.listSessions(forceRefresh ? { refresh: true } : undefined);
  const live = scoped
    ? liveAll.filter((s) => normalizeWorkspaceKeyServer((s as { projectKey?: string }).projectKey ?? (s as { projectRoot?: string }).projectRoot ?? s.cwd) === projectFilter)
    : liveAll;
  const idx = runtime(ctx.configDir).index;
  // §10 guarantee: a deleted session's tag assignments are cleaned up lazily.
  // Two-round confirmation: a stale id is only pruned if it stays absent from
  // core's list for a grace period (60s) — core's list can lag a freshly
  // created session by one scan, and a naive GC would wipe its just-assigned tags.
  const liveIds = new Set(live.map((s) => s.id));
  const archIds = new Set(idx.archivedRows().map((r) => r.id));
  // M1: external-source rows count as alive — otherwise the lazy GC would prune
  // tags/favorites just assigned to an external session (~60s later).
  const activeExt = activeAgents(ctx.configDir);
  const extRowsAllRaw = activeExt.length ? idx.extRows(activeExt) : [];
  // 作用域模式：外部 agent 行按 cwd 过滤（与 live 行同 key 口径）
  const extRowsAll = scoped ? extRowsAllRaw.filter((r) => normalizeWorkspaceKeyServer(r.cwd) === projectFilter) : extRowsAllRaw;
  for (const r of extRowsAll) liveIds.add(r.id);

  const pending = (globalThis as { __smGcPending?: Map<string, number> }).__smGcPending ??= new Map();
  const graceMs = (globalThis as { __smGcGraceMs?: number }).__smGcGraceMs ?? 60_000;
  const gc = () => {
    const now = Date.now();
    const stale = Object.keys(readTagData(ctx.configDir).sessionTags ?? {})
      .filter((id) => !liveIds.has(id) && !archIds.has(id));
    // ids that came back into the list stop counting toward confirmation
    for (const id of [...pending.keys()]) if (!stale.includes(id)) pending.delete(id);
    const toPrune = stale.filter((id) => {
      const first = pending.get(id);
      if (first === undefined) { pending.set(id, now); return false; }
      return now - first >= graceMs;
    });
    if (!toPrune.length) return;
    // read-modify-write races with concurrent assigns: re-read right before
    // writing and require an unchanged version, retry a few times.
    for (let attempt = 0; attempt < 3; attempt++) {
      const d = readTagData(ctx.configDir);
      const cur = readTagData(ctx.configDir);
      if (cur.version !== d.version) continue; // concurrent write won — retry with fresh snapshot
      const next = { ...d, sessionTags: { ...d.sessionTags } };
      for (const id of toPrune) delete next.sessionTags[id];
      next.version = d.version + 1;
      writeTagData(ctx.configDir, next);
      publishTagsChanged(ctx, next.version); // 懒 GC 也是 tag 变更，广播保持一致
      return;
    }
  };
  try { gc(); } catch { /* best-effort */ }
  // ── P0-2 装配级 memo（2026-09-12，方案 pi-web-session-list-server-triage-watch-plan.md）──
  // 304/patch 路径此前每请求全量重算（批查询 ~150ms + 富化循环 + dispatch 标注 ≤500ms
  // + 1575 行 SHA1 + 编码；实测 304 全程 1.84s）。key = (liveRef, tagVer, extFp, archFp)：
  //   · liveRef：宿主 listAllSessions TTL 缓存窗口内返回同一数组引用 → 引用比较 O(1)；
  //     重扫 / refresh=1 后新数组 → 自动 miss。依赖宿主「TTL 内同引用」约定（listAllSessions
  //     每次重建 data，现状成立；若未来破坏则退化为每请求重算，不更差）。
  //   · tagVer：gc 后读（gc 可能写 tagData 提升 version）。
  //   · extFp / archFp：extRowsAll / archivedRows 的 (id|modified) 指纹（查询本身 ms 级）。
  // 命中：sessions/archived/rowRevs/etag 全复用，跳过 dispatch 标注——标注设计本就允许
  // 迟到（「缺标行由下一轮拉取经 rev/patch 通道自然补齐」），滞后 ≤ 宿主 5s 重扫窗口。
  // 未命中：正常组装后存 memo。单槽（globalThis），双实例各进程独立。
  type SmAssemblyMemo = {
    liveRef: unknown; tagVer: number; extFp: string; archFp: string;
    assembled: { sessions: Record<string, unknown>[]; archived: Record<string, unknown>[]; rowRevs: Map<string, string>; etag: string; etagBare: string };
  };
  const memoSlot = scoped ? undefined : (globalThis as { __smAssemblyMemo?: SmAssemblyMemo }).__smAssemblyMemo;
  const tagVerNow = (readTagData(ctx.configDir) as { version?: number }).version ?? 0;
  // 指纹含 parentSid：源内父子链回填/变化时 parentSessionId 变但 modified 不变，
  // 漏掉会让 memo 命中旧 payload（同 rowRev 白名单漏 name 的历史事故同型）。
  const extFp = createHash("sha1").update(extRowsAll.map((r) => `${r.id}|${r.modified}|${r.parentSid ?? ""}`).join(";")).digest("hex").slice(0, 16);
  const archRowsNow = idx.archivedRows();
  const archFp = createHash("sha1").update(archRowsNow.map((r) => `${r.id}|${r.modified}`).join(";")).digest("hex").slice(0, 16);
  const memoHit = !!memoSlot && memoSlot.liveRef === live && memoSlot.tagVer === tagVerNow
    && memoSlot.extFp === extFp && memoSlot.archFp === archFp;
  const assembled = memoHit
    ? (memoSlot as SmAssemblyMemo).assembled
    : await (async () => {
  // §14.4: attach lastMessage + lastRole + model (from the index) for row summaries/filters.
  // 批量：一条 SQL 取全部 lastMeta/兜底文本，避免 472 条逐会话 SQL（实测 ~0.5-0.7s → ~ms）。
  // lastMessage/firstMessage 只回预览（~100 字符）：客户端仅展示前 60 字符（L927 slice(0,60)），
  // 全文列表会让响应膨胀到 ~1MB（单条最大 34-125KB）——详情按需单条拉取。
  const PREVIEW_LEN = 60;
  const truncate = (t?: string | null) => (t && t.length > PREVIEW_LEN ? t.slice(0, PREVIEW_LEN) + "…" : t ?? "");
  // 响应白名单：客户端只消费这些字段（逐字段核实过 panel/kanban/entries/topbar）。
  // path 单字段就占响应 18%（~34KB gz，深路径项目），branch/archiveRef/
  // transient 客户端零读取——全量 spread 在 1257 行下响应膨胀到 834KB。
  // 新字段要进列表响应时在这里显式加。
  // relation：fork 子代理可见化（2026-09-07）后 dock 需要区分 subagent/分支图标与
  // 折叠 title——透传宿主行的 relation（仅带 parentSessionId 的行有值，~KB 级）。
  // projectKey：Windows 项目 key 过滤必需（2026-09-08）。服务端 projectIdentityKey
  // 的 win32 语义是 normalize+lowercase（如 d:\workspace\aiti-ai），与 projectRoot/cwd
  // 原始形态不同形——曾因「客户端零读取」被丢弃，dock sessionsForProject 精确 ===
  // 过滤全部不匹配 → 列表闪现后被清空。dock 已加 normalizeWorkspaceKey 兜底，
  // 此处恢复宿主同构（getRecentProjects 也不再因形态差分裂重复项目条目）。
  const pickRow = (s: Record<string, unknown>) => ({
    id: s.id,
    cwd: s.cwd,
    created: s.created,
    modified: s.modified,
    messageCount: s.messageCount,
    firstMessage: s.firstMessage,
    lastMessage: s.lastMessage,
    name: s.name,
    parentSessionId: s.parentSessionId,
    relation: s.relation,
    projectRoot: s.projectRoot,
    projectKey: s.projectKey,
    agent: s.agent,
    lastRole: s.lastRole,
    model: s.model,
    // 会话运行终态（failed/aborted/interrupted + error 摘要）：随行下发供 dock/面板
    // 异常标记；rowRev 整行反射自动纳入（304/patch 通道自动传播）。
    lastRun: s.lastRun,
    archived: s.archived,
    archiveRef: s.archiveRef,
    extId: s.extId,
  });
  const liveWithId = live.filter((s) => s.id);
  const ids = liveWithId.map((s) => s.id as string);
  const metaBatch = idx.lastMetaBatch(ids);
  const rows = idx.getSessionBatch(ids);
  // last_message 文本兜底只查「索引行缺 last_message」的会话（旧索引迁移前入库的行，
  // 现存 ~100/1700）：全量 ids 的 messages JOIN 查询 ~800ms（42 万消息表 role 过滤走不了
  // 覆盖索引），收窄后几十 ms——新索引行都带 last_message，常规稳态此查询为空。
  const missingLastMsg = ids.filter((id) => !rows.get(id)?.lastMessage);
  const textBatch = missingLastMsg.length ? idx.lastMessageTextBatch(missingLastMsg) : new Map<string, string>();
  const withLast = liveWithId.map((s) => {
    const id = s.id as string;
    const row = rows.get(id);
    const meta = metaBatch.get(id);
    return pickRow({
      ...s,
      ...(row?.extId ? { extId: row.extId } : {}),
      ...(row?.agent && row.agent !== "pi" ? { agent: row.agent } : {}),
      lastMessage: truncate(row?.lastMessage || textBatch.get(id) || s.firstMessage),
      firstMessage: truncate(s.firstMessage),
      lastRole: meta?.role,
      model: meta?.model ?? undefined,
    });
  });
  // 站位行富化 + 去重（§站位文件方案）：pi 文件行带 extId = 外部会话已落持久锚点。
  //   1) 站位文件本身不含对话 → 从同会话的 ext 索引行补内容预览/计数/真实时间；
  //   2) 行身份改写为复合 id —— 客户端零改动（徽标/⚡接管/⬇导入/标签全按 ext 行
  //      既有语义工作，无需感知站位 uuid）；
  //   3) 同会话的 ext 索引行从列表剔除（免双行；FTS 搜索仍命中索引，搜索结果
  //      打开仍走复合 id）。
  const extByExtId = new Map(extRowsAll.map((r) => [r.id, r]));
  // 宿主占位注册表兑底（external-session-placeholders.json，与 pi-web core
  // lib/session/placeholder.ts 同源同款数据）：索引行缺席（syncIndex 未跑/双实例
  // 并发写丢行）时，站位 uuid 行也能立即拿到 extId/agent —— 否则裸行无徽标 +
  // 与 ext 行双行（实测 2026-09-07 zcode 双条目无标）。mtime 缓存，零开销热路径。
  const placeholders = placeholderIndex(ctx.configDir);
  // P0-1 断链修复：enrich 写入的索引行在外部源未激活时 extRows(activeExt) 查不到
  // （activeExt 空 → extRowsAll 空 → extByExtId 空）→ missingExt 永不消退 → 每请求
  // 60s 节流触发 enrich → adapter.parse 全为同步 readFileSync+逐行 JSON.parse
  // （3.4–3.5s 事件循环阻塞）。按站位 extId 集合用 getSessionBatch 直查补全
  // （不受 agent 过滤/激活限制）：enrich 写入后下轮请求即命中 → missing 收敛，
  // enrich 不再重复触发。
  const extIdsFromPlaceholders = new Set<string>();
  for (const r of withLast) {
    const rec = r as Record<string, unknown>;
    const extId = (rec.extId as string) ?? placeholders.get(String(rec.id))?.extId;
    if (extId) extIdsFromPlaceholders.add(extId);
  }
  const recheckIds = [...extIdsFromPlaceholders].filter((id) => !extByExtId.has(id));
  if (recheckIds.length) {
    for (const [id, row] of idx.getSessionBatch(recheckIds)) {
      if (!extByExtId.has(id)) extByExtId.set(id, { ...row, agent: row.agent ?? "pi" });
    }
  }
  // 站位行查不到 ext 索引行（全量补同步被 2min 静置门控饿死时的空窗）→ 收集起来
  // 后台按需单会话富化（enrichExtPlaceholders，有界）；本次响应仍走站位兜底。
  const missingExt: string[] = [];
  for (const r of withLast) {
    const rec = r as Record<string, unknown>;
    if (!rec.extId) {
      const ph = placeholders.get(String(rec.id));
      if (ph) {
        rec.extId = ph.extId;
        if (!rec.agent) rec.agent = ph.agent;
      }
    }
    const extId = rec.extId as string | undefined;
    if (!extId) continue;
    const ext = extByExtId.get(extId);
    if (ext) {
      const EMPTY = new Set(["", "(no messages)"]);
      if (EMPTY.has(rec.firstMessage as string)) rec.firstMessage = truncate(ext.firstMessage);
      if (EMPTY.has(rec.lastMessage as string)) rec.lastMessage = truncate(ext.lastMessage);
      if (!rec.messageCount && ext.messageCount) rec.messageCount = ext.messageCount;
      if (ext.name) rec.name = ext.name;
      rec.created = ext.created;
      rec.modified = ext.modified; // 真实活动时间（站位 mtime 只在换绑/改名时变）
      // 源内父子链随富化透传（zcode subagent_child 等）：站位行替 ext 行出面时，
      // parentSessionId 不能丢——否则 🤖 徽标/父子树嵌套在该行上失效。
      if (!rec.parentSessionId && ext.parentSid) rec.parentSessionId = `${ext.agent}:${ext.parentSid}`;
    } else {
      missingExt.push(extId);
    }
    rec.id = extId;
  }
  if (missingExt.length > 0) void enrichExtPlaceholders(ctx.configDir, idx as never, missingExt);
  const archIdsList = scoped ? archRowsNow.filter((r) => normalizeWorkspaceKeyServer(r.projectRoot ?? r.cwd) === projectFilter) : archRowsNow; // P0-2：archivedRows 已在 memo 判定处查询（archFp），此处复用不重查
  const archMeta = idx.lastMetaBatch(archIdsList.map((r) => r.id));
  const archText = idx.lastMessageTextBatch(archIdsList.map((r) => r.id));
  const archived = archIdsList.map((r) => pickRow({
    ...r,
    // §14.4: same fallback as live rows (rows indexed before the last_message migration)
    lastMessage: truncate(r.lastMessage || archText.get(r.id) || ""),
    firstMessage: truncate(r.firstMessage),
    lastRole: archMeta.get(r.id)?.role,
    model: archMeta.get(r.id)?.model ?? undefined,
  }));
  // M1: activated external sources append as live rows (composite ids, agent field set).
  // 外部子代理链接（piweb-job-provider 落 <dataRoot>/external-subagent-links.json）：
  // 真实复合 id → 父会话。给对应行补 parentSessionId —— 🤖 徽标 + 父子树嵌套原生生效；
  // 打开仍走原会话，历史消息原样（用户反馈：打开要看真实历史）。
  const extLinks = (() => {
    try {
      return JSON.parse(readFileSync(join(dirname(ctx.configDir), "external-subagent-links.json"), "utf8")) as Record<string, { parentSessionId?: string; parentSessionFile?: string }>;
    } catch { return {} as Record<string, { parentSessionId?: string; parentSessionFile?: string }>; }
  })();
  const parentPathToId = new Map(liveWithId.map((s) => [String((s as { path?: string }).path ?? ""), String(s.id)]));
  // 站位已接管的 extId 从列表剔除（同会话已由上面的富化 pi 行代表，免双行）。
  const placeholderExtIds = new Set(withLast.map((r) => (r as { extId?: string }).extId).filter((x): x is string => !!x));
  const extRows = extRowsAll.filter((r) => !placeholderExtIds.has(r.id)).map((r) => {
    const link = extLinks[r.id];
    // 优先 piweb-job-provider 显式链接；否则用源内父子链（zcode session.parent_id
    // 的 subagent_child，index 存原生 sid）组合成复合 id——与列表行 id 同形，
    // 前端父子树嵌套 / 🤖 徽标 / collectSubtreeIds 原生生效。父行缺席（跨项目父
    // 会话 / 未激活源）时子行由 buildSessionTree.resolveAncestor 降级为根节点。
    const linkedParent = link ? (parentPathToId.get(link.parentSessionFile ?? "") ?? link.parentSessionId) : undefined;
    const parentSessionId = linkedParent ?? (r.parentSid ? `${r.agent}:${r.parentSid}` : undefined);
    return pickRow({
    id: r.id,
    path: "",
    cwd: r.cwd,
    name: r.name ?? undefined,
    created: r.created,
    modified: r.modified,
    messageCount: r.messageCount,
    firstMessage: truncate(r.firstMessage),
    lastMessage: truncate(r.lastMessage),
    agent: r.agent,
    lastRole: undefined as string | undefined,
    model: undefined as string | undefined,
    parentSessionId: parentSessionId || undefined,
  });
  });
  // 归档拆分（dock 归档残留修复，2026-09-07）：sessions 只装 live+外部行，归档行
  // 独立 archived 数组返回——消费方（dock/看板/回灌宿主）拿 sessions 即纯在册列表，
  // 归档视图由面板按需合并，不再依赖各消费方自行过滤 archived 字段。
  // 同 id 不跨桶共存（归档=live 桶移出、archived 桶移入）。归档权威优先：宿主
  // core.listSessions() 有 5s 扫描缓存，归档后缓存未过期仍会报该会话——必须按
  // archivedRows 剔除，否则双桶共存 → 客户端全量应用后 dock 残留归档行（实测复现）。
  const archIdSet = new Set(archived.map((r) => String(r.id)));
  const sessions = [...withLast, ...extRows].filter((s) => !archIdSet.has(String(s.id)));
  // 会话标注（ExtSessionAnnotatorSlot；aiti-plan-first 绑定方案的 planFirst 标等）：
  // 合并进响应行（同进程注册表分发；单标注器异常不阻断）。标注覆盖两桶
  // （归档行的 planFirst 标在归档查看器里仍要显示）。
  // 深审 §5.5：注册方变慢直接加进 TTFB——500ms 超时先放行响应（标注仅展示徽标，
  // 迟到合并对已序列化响应无害；缺标行由下一轮拉取经 rev/patch 通道自然补齐）。
  try {
    let annTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      (globalThis as { __piWebExt?: { dispatchSessionAnnotations?: (rows: unknown[]) => Promise<void> } })
        .__piWebExt?.dispatchSessionAnnotations?.([...sessions, ...archived]),
      new Promise<void>((res) => { annTimer = setTimeout(res, 500); }),
    ]);
    clearTimeout(annTimer);
  } catch { /* 标注失败不阻断列表 */ }
  // ETag：内容指纹（id + modified + messageCount + lastMessage 截断 + firstMessage 截断）。
  // 覆盖所有会影响渲染的字段——仅 id+modified 可能漏掉内容变但 modified 未同步更新的情况。
  // 用 sha1（64 hex）替代自写 32 位 hash：碰撞概率可忽略。轮询端带 If-None-Match → 304。
  // ── 增量同步协议 v1（aiti-web-sessions-payload-plan §9）──
  // per-row rev：对整行内容做指纹——凡影响渲染的字段变化都必须推进 rowRev，
  // 否则该行对增量协议不可见：rev 不变 → 304、rowRev 不变 → 不进 patch.up，
  // 客户端该行永远停在旧值。已知事故：宿主 PATCH 重命名 = append session_info——
  // 只改 name，modified/messageCount/消息预览全不变；旧字段白名单漏 name → 重命名
  // 后 304/patch 均不带新名，直到该会话其他字段变化才刷新（用户实测「重命名很久
  // 才刷新」，2026-09-12 根因）。改用整行反射（key 排序）：pickRow 新增字段自动
  // 纳入，不再靠人工同步白名单；值 undefined 序列化为 null，同内容 → 同指纹。
  // 序列化失败（循环引用/BigInt 等理论上不该出现的行值——annotations 会就地注入
  // 扩展字段）退化为顶层字符串拼接，保指纹推进能力、绝不让整个 /sessions 500
  //（旧模板串实现静默强转无此风险，整行反射需自带兜底）。
  const rowRevOf = (s: Record<string, unknown>) => {
    let payload: string;
    try {
      payload = JSON.stringify(Object.keys(s).sort().map((k) => [k, s[k]]));
    } catch {
      payload = Object.keys(s).sort().map((k) => `${k}=${String(s[k])}`).join("|");
    }
    return createHash("sha1").update(payload).digest("hex").slice(0, 16);
  };
  const rowRevs = new Map<string, string>();
  for (const s of [...sessions, ...archived]) {
    const rec = s as Record<string, unknown>;
    rowRevs.set(String(rec.id), rowRevOf(rec));
  }
  const etag = `"${createHash("sha1").update([...rowRevs.values()].join("|")).digest("hex")}"`;
  // 冷启动窗口（restart 后 60s）：扫描/sqlite 索引/外部源未达稳态，首轮可能残缺；
  // 禁用 patch 一律全量，避免把冷启动残缺差量当删除传播给未刷新的旧页面。
  const etagBare = etag.replace(/"/g, "");
      return { sessions, archived, rowRevs, etag, etagBare };
    })();
  if (!memoHit && !scoped) {
    (globalThis as { __smAssemblyMemo?: SmAssemblyMemo }).__smAssemblyMemo = { liveRef: live, tagVer: tagVerNow, extFp, archFp, assembled };
  }
  const { sessions, archived, rowRevs, etag, etagBare } = assembled;
  // 行缓存登记（活动数据帧通道，server/activity-bus.ts）：message_end 广播随帧带行数据。
  // 每次调用（引用去重 O(1)）：memo 命中同一组装不重复登记；扩展 reload 后宿主持有
  // 旧 memo、本模块缓存已清 → 同引用重入此处仍会重新登记（不留空窗）。
  noteAssembledRows(sessions, archived);
  // 冷启动窗口 + since 凭据：IIFE 外定义（出口段 304/patch 判定使用；IIFE 内只负责
  // 行组装与指纹，不碰请求参数）。
  const coldStart = Date.now() - (globalThis as { __smBootAt?: number }).__smBootAt! < 60_000;
  const sinceHeader = req?.headers.get("x-sm-since");
  const since = (sinceHeader ? sinceHeader.replace(/"/g, "") : null)
    || (req?.url ? new URL(req.url, "http://x").searchParams.get("since") : null);
  const revSnapshots = ((globalThis as { __smRevSnapshots?: Map<string, Map<string, string>> }).__smRevSnapshots ??= new Map());
  revSnapshots.set(etagBare, rowRevs);
  // 环形裁剪（最新 10 个）；当前 rev 永不裁
  while (revSnapshots.size > 10) {
    const oldest = revSnapshots.keys().next().value;
    if (oldest === undefined || oldest === etagBare) break;
    revSnapshots.delete(oldest);
  }
  // 304：If-None-Match 或 since 命中当前 rev
  if (req?.headers.get("if-none-match") === etag || (since && since === etagBare)) {
    return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "no-store" } });
  }
  // patch 形态：since 在缓冲内且 ≠ 当前 rev；抖动保护（rm>30%）时置空降级到全量出口
  //（与冷启动/缓冲过期同一出口，fmt=2 形态全路径一致）。作用域模式不启用 patch
  //（scoped 载荷小、永远回全量 scoped；且 revSnapshots 是按内容键的全局表，跨作用域
  //  混用 since 会把 A 项目快照的 rm 应用到 B 项目 → 误删行）。
  const sinceSnap = since && !coldStart && !scoped && since !== etagBare ? revSnapshots.get(since) : undefined;
  if (sinceSnap) {
    const up: Record<string, unknown>[] = [];
    for (const s of [...sessions, ...archived]) {
      const rec = s as Record<string, unknown>;
      const id = String(rec.id);
      if (sinceSnap.get(id) !== rowRevs.get(id)) up.push(rec);
    }
    const rm: string[] = [];
    for (const id of sinceSnap.keys()) if (!rowRevs.has(id)) rm.push(id);
    // 扫描抖动保护：rm 异常大（>当前行数 30%，正常稳态 0-数行）说明某一轮扫描
    // 返回过残缺行集（索引重建/ext-sources 激活窗口）——拒绝 patch 降级全量出口，
    // 客户端以全量重置，避免把残缺差量当删除传播。分母=两桶合并行数
    //（批量归档是正常操作：行只在桶间移动不消失，rm 不涨）。
    if (rm.length <= (sessions.length + archived.length) * 0.3) {
      // fmt=2 紧凑传输编码（payload 方案 §9.4；映射约定见 payload.ts）——只发生在
      // 响应出口，rev/rowRev 指纹与行语义不变；无 fmt 参数走旧形态（旧消费方零改动）。
      // 注意：只放 patch.up 一份行（不可 ...enc 展开——会把 sessions 顶层多带一份致响应翻倍）。
      if (ctx.searchParams.get("fmt") === "2") {
        const enc = encodeSessionsV2(up);
        return json({ rev: etagBare, fmt: enc.fmt, cwds: enc.cwds, patch: { up: enc.sessions, rm } }, 200, { ETag: etag });
      }
      return json({ rev: etagBare, patch: { up, rm } }, 200, { ETag: etag });
    }
  }
  if (ctx.searchParams.get("fmt") === "2") {
    const enc = encodeSessionsV2(sessions as Record<string, unknown>[], archived as Record<string, unknown>[]);
    return json({ ...enc, rev: etagBare, archiveAgents: archiveCapableAgents() }, 200, { ETag: etag });
  }
  return json({ sessions, archived, rev: etagBare, archiveAgents: archiveCapableAgents() }, 200, { ETag: etag });
}

function statsEndpoint(ctx: ExtApiCtx): Promise<Response> {
  return ctx.core.getRunningSessionIds().then((running) =>
    json(runtime(ctx.configDir).index.stats(running)));
}

/**
 * 相关文档：某会话触达过的 md 文档（aiti-git-trace 采集 → aiti-doc-center 回填
 * doc_sessions）。跨扩展数据只走进程内 services（同 msg-smart 红线：客户端不直连
 * 兄弟扩展 HTTP）；aiti-doc-center 缺席时 available:false 降级，不报错。
 */
function relatedDocsEndpoint(ctx: ExtApiCtx): Response {
  const sid = ctx.searchParams.get("sessionId") ?? "";
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(sid)) return json({ error: "bad sessionId" }, 400);
  try {
    // 双轨（DI 方案 P1）：ctx.services 优先，__piWebExt.byId 穿透兜底（生产旧 core 过渡期）
    const s = (ctx as any)?.services?.get?.("aiti-doc-center.docs")
      ?? (() => { const reg = (globalThis as any).__piWebExt; const loaded = reg && typeof reg.byId === "function" ? reg.byId("aiti-doc-center") : null; return loaded?.ext?.services?.docs ?? null; })();
    if (!s || typeof s.docsOfSession !== "function") {
      return json({ ok: true, sessionId: sid, available: false, docs: [] });
    }
    const docs = (s.docsOfSession(sid) as any[]) ?? [];
    return json({ ok: true, sessionId: sid, available: true, docs });
  } catch (e: any) {
    return json({ ok: true, sessionId: sid, available: false, docs: [], error: String(e?.message ?? e) });
  }
}

/**
 * 文档 → 触达 session 反查（related-docs 的镜像方向，todo-sm-sidebar-search-doc-condition §2/§4-P1）。
 * 进程内消费 services.docs.sessionsOfDoc（红线：不直连兄弟扩展 HTTP）；缺席降级 available:false。
 * 附：从 dock 列表（/api/sessions/search 结果）反填会话展示信息由客户端完成——本端点只出 sid/时间/次数。
 */
function docSessionsEndpoint(ctx: ExtApiCtx): Response {
  const docId = Number(ctx.searchParams.get("docId") ?? "");
  if (!Number.isInteger(docId) || docId <= 0) return json({ error: "bad docId" }, 400);
  // A02 P2：q 非空 = 文本条件改道文档检索——只在该文档内容命中 q 时才返回其会话（不回退会话全文搜索）
  const q = (ctx.searchParams.get("q") ?? "").trim();
  try {
    // 双轨（DI 方案 P1）：ctx.services 优先，__piWebExt.byId 穿透兜底（生产旧 core 过渡期）——relatedDocs 同款
    const s = (ctx as any)?.services?.get?.("aiti-doc-center.docs")
      ?? (() => { const reg = (globalThis as any).__piWebExt; const loaded = reg && typeof reg.byId === "function" ? reg.byId("aiti-doc-center") : null; return loaded?.ext?.services?.docs ?? null; })();
    if (!s || typeof s.sessionsOfDoc !== "function") {
      return json({ ok: true, docId, available: false, sessions: [] });
    }
    let matched = true;
    let snippet = "";
    if (q && typeof s.searchFull === "function") {
      const r = (s.searchFull(q, undefined, 50) as { items?: Array<{ id?: number; snippet?: string }> }) || { items: [] };
      const hit = (r.items ?? []).find((it) => it.id === docId);
      matched = !!hit;
      snippet = String(hit?.snippet ?? "");
    }
    const sessions = matched ? ((s.sessionsOfDoc(docId) as any[]) ?? []) : [];
    return json({ ok: true, docId, available: true, matched, snippet, sessions });
  } catch (e: any) {
    return json({ ok: true, docId, available: false, sessions: [], error: String(e?.message ?? e) });
  }
}

/**
 * 文档清单代理（dock 文档选择器数据源，§3）：进程内消费 services.docs.query，
 * 只透传选择器需要的白名单字段；doc-center 缺席降级 available:false。
 */
function docListEndpoint(ctx: ExtApiCtx): Response {
  const q = (ctx.searchParams.get("q") ?? "").trim();
  const under = ctx.searchParams.get("under") ?? undefined;
  // A16① 联合 tag 视图：tag=逗号分隔 key（doc-center 语义含子树前缀匹配），逐 key 查询按 id 合并
  const tagParam = (ctx.searchParams.get("tag") ?? "").trim();
  const tagKeys = tagParam ? tagParam.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 5) : [];
  const limitRaw = Number(ctx.searchParams.get("limit") ?? "200");
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 200, 1), 200);
  try {
    // 双轨（DI 方案 P1）：ctx.services 优先，__piWebExt.byId 穿透兜底（生产旧 core 过渡期）——relatedDocs 同款
    const s = (ctx as any)?.services?.get?.("aiti-doc-center.docs")
      ?? (() => { const reg = (globalThis as any).__piWebExt; const loaded = reg && typeof reg.byId === "function" ? reg.byId("aiti-doc-center") : null; return loaded?.ext?.services?.docs ?? null; })();
    if (!s || typeof s.query !== "function") {
      return json({ ok: true, available: false, docs: [] });
    }
    const seen = new Set<any>();
    const raw: any[] = [];
    for (const k of tagKeys.length ? tagKeys : [""]) {
      for (const d of (s.query({ q: q || undefined, tag: k || undefined, under, limit }) as any[]) ?? []) {
        if (!seen.has(d.id)) { seen.add(d.id); raw.push(d); }
      }
    }
    const docs = raw.map((d: any) => ({
      id: d.id,
      root: d.root,
      relpath: d.relpath,
      title: d.title || (String(d.relpath ?? "").split("/").pop() ?? d.relpath),
      mtimeMs: d.mtimeMs,
    }));
    return json({ ok: true, available: true, docs });
  } catch (e: any) {
    return json({ ok: true, available: false, docs: [], error: String(e?.message ?? e) });
  }
}

function archivedSessionEndpoint(ctx: ExtApiCtx, sessionId: string): Promise<Response> {  return (async () => {
  const idx = runtime(ctx.configDir).index;
  const row = idx.getSession(sessionId);
  if (!row || !row.archived) return json({ error: "not found" }, 404);
  // ext 视图层归档行（无 .pwarc 包）：经 adapter 现读源数据（源库仍在则可看）
  if (row.archiveRef === "__ext__") {
    await ensureProviders(ctx.configDir);
    const resolved = resolveExtId(ctx.configDir, sessionId);
    if (!resolved) return json({ error: "unknown agent" }, 400);
    let refs: Awaited<ReturnType<typeof resolved.adapter.list>>;
    try { refs = await resolved.adapter.list(); } catch (e) { return json({ error: `source list failed: ${String(e)}` }, 503); }
    const ref = refs.find((r) => r.sid === resolved.sid);
    if (!ref) return json({ error: "not found" }, 404);
    const parsed = await resolved.adapter.parse(ref);
    if (!parsed) return json({ error: "parse failed" }, 500);
    return json({ session: row, messages: parsed.messages, meta: parsed.meta, files: [] });
  }
  const cached = extractArchived(ctx.configDir, sessionId);
  if (!cached) return json({ error: "extract failed" }, 500);
  const raw = readFileSync(cached, "utf8");
  const parsed = parseSessionFile(cached, raw);
  if (!parsed) return json({ error: "parse failed" }, 500);
  return json({ session: row, messages: parsed.messages, meta: parsed.meta, files: parsed.files });
  })();
}

function exportEndpoint(ctx: ExtApiCtx, sessionId: string): Response {
  const format = ctx.searchParams.get("format") ?? "jsonl";
  const idx = runtime(ctx.configDir).index;
  const row = idx.getSession(sessionId);
  if (!row) return json({ error: "not found" }, 404);
  const cached = row.archived ? extractArchived(ctx.configDir, sessionId) : row.path;
  if (!cached) return json({ error: "extract failed" }, 500);
  const raw = readFileSync(cached, "utf8");
  if (format === "jsonl") {
    return new Response(raw, {
      headers: {
        "content-type": "application/x-jsonlines",
        "content-disposition": `attachment; filename="${sessionId}.jsonl"`,
        "cache-control": "no-store",
      },
    });
  }
  // markdown export
  const parsed = parseSessionFile(cached, raw);
  const lines = [`# Session ${sessionId}`, "", `cwd: \`${parsed?.meta.cwd ?? ""}\``, ""];
  for (const m of parsed?.messages ?? []) {
    const role = m.role === "toolResult" ? "🛠 tool" : m.role === "user" ? "🧑 user" : "🤖 assistant";
    lines.push(`## ${role}${m.model ? ` (${m.model})` : ""}`, "", m.text, "");
  }
  return new Response(lines.join("\n"), {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${sessionId}.md"`,
      "cache-control": "no-store",
    },
  });
}

async function archiveEndpoint(req: Request, ctx: ExtApiCtx, sub: string | undefined, rest: string[], body: Record<string, unknown> | null): Promise<Response> {
  switch (sub) {
    case "status": {
      const st = await archiveStatus(ctx.configDir, ctx.core);
      return json({
        candidates: st.candidates.map((c) => ({ sessionId: c.sessionId, cwd: c.cwd, modified: c.modified, sizeBytes: c.sizeBytes, ageDays: Math.round(c.ageDays) })),
        cacheBytes: st.cacheBytes,
        settings: st.settings,
      });
    }
    case "run": {
      const overrides = body?.ageDays !== undefined || body?.maxLiveSizeMb !== undefined
        ? { archiveAgeDays: typeof body.ageDays === "number" ? body.ageDays : undefined, maxLiveSizeMb: typeof body.maxLiveSizeMb === "number" ? body.maxLiveSizeMb : undefined } as Partial<{ archiveAgeDays: number; maxLiveSizeMb: number }>
        : undefined;
      const ids = Array.isArray(body?.ids) ? body.ids.filter((x): x is string => typeof x === "string") : undefined;
      const result = await runArchive(ctx.configDir, ctx.core, overrides, ids);
      return json(result);
    }
    case "extract": {
      if (!body || typeof body.sessionId !== "string") return json({ error: "sessionId required" }, 400);
      const cached = extractArchived(ctx.configDir, body.sessionId);
      return cached ? json({ ok: true, cachedPath: cached }) : json({ error: "not found" }, 404);
    }
    case "restore": {
      // put an archived session back to its original live path
      if (!body || typeof body.sessionId !== "string") return json({ error: "sessionId required" }, 400);
      const ok = restoreArchived(ctx.configDir, body.sessionId);
      return ok ? json({ ok: true }) : json({ error: "not found or not archived" }, 404);
    }
    case "ext-run": {
      // A03 真归档：外部源会话 → .pwarc 快照 → 删源（adapter 需 remove 能力）
      if (!body || typeof body.sessionId !== "string") return json({ error: "sessionId required" }, 400);
      await ensureProviders(ctx.configDir);
      const resolved = resolveExtId(ctx.configDir, body.sessionId);
      if (!resolved) return json({ ok: false, error: "unknown external session id" }, 404);
      const result = await runExtArchive(ctx.configDir, ctx.core, resolved.adapter, resolved.sid);
      return json(result, result.ok ? 200 : 422);
    }
    case "ext-restore": {
      // A03 真恢复：.pwarc 解出 → putBack 写回源 → 源列表确认 → 撤包条目
      if (!body || typeof body.sessionId !== "string") return json({ error: "sessionId required" }, 400);
      await ensureProviders(ctx.configDir);
      const resolved = resolveExtId(ctx.configDir, body.sessionId);
      if (!resolved) return json({ ok: false, error: "unknown external session id" }, 404);
      const result = await restoreExtArchive(ctx.configDir, ctx.core, resolved.adapter, resolved.sid);
      return json(result, result.ok ? 200 : 422);
    }
    case "delete": {
      // permanent delete — archive records only (live files must be archived first)
      if (!body || typeof body.sessionId !== "string") return json({ error: "sessionId required" }, 400);
      const ok = deleteArchived(ctx.configDir, body.sessionId);
      return ok ? json({ ok: true }) : json({ error: "not found or not archived" }, 404);
    }
    case "ext": {
      // ext 源行「从列表移除」/恢复（视图层归档，无 .pwarc 包；ZCode 等源数据不动）
      if (!body || typeof body.sessionId !== "string") return json({ error: "sessionId required" }, 400);
      const hidden = body.hidden !== false;
      const ok = hidden
        ? hideExtSession(ctx.configDir, body.sessionId)
        : unhideExtSession(ctx.configDir, body.sessionId);
      return ok ? json({ ok: true }) : json({ error: "not found or not an ext row" }, 404);
    }
    case "session": {
      const id = rest[0];
      if (!id) return json({ error: "sessionId required" }, 400);
      return archivedSessionEndpoint(ctx, id);
    }
    case "export": {
      const id = rest[0];
      if (!id) return json({ error: "sessionId required" }, 400);
      return exportEndpoint(ctx, id);
    }
    case "cache": {
      if (ctx.searchParams.get("clear") === "1") {
        return json({ cleared: clearArchiveCache(ctx.configDir) });
      }
      return json({ cacheBytes: 0 });
    }
    default:
      return json({ error: "unknown archive action" }, 404);
  }
}

export async function api(req: Request, ctx: ExtApiCtx): Promise<Response | null> {
  const [action, sub, ...rest] = ctx.path;
  // workspace 上传（方案 docs/session-manager-workspace-upload-plan.md）：POST body 是
  // 二进制流（服务端流式落盘），必须在通用 bodyJson 之前拦截——Request body 单次流。
  if (action === "workspace") {
    if (req.method === "POST" && sub === "upload") return handleWorkspaceUpload(req, ctx);
    if (req.method === "GET" && sub === "capabilities") return handleCapabilities();
    return json({ error: "unknown workspace action" }, 404);
  }
  // Parse the body exactly once — archiveEndpoint consumes it too, and a
  // Request body is a single-use stream (a second read yields null).
  const body = (req.method === "POST" || req.method === "PUT") ? await bodyJson(req) : null;
  const v = body?.version;

  switch (action) {
    case "ping":
      return json({ pong: true, ts: Date.now() });

    case "git-info": {
      // 左栏项目分组头用：读 cwd 的当前分支（惰性、短超时；失败返回空串不阻断）
      const cwd = ctx.searchParams.get("cwd") ?? "";
      if (!cwd || !isAbsolute(cwd)) return json({ error: "cwd required" }, 400);
      let branch = "";
      try {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        branch = await promisify(execFile)("git", ["-C", cwd, "branch", "--show-current"], { timeout: 3000 })
          .then((r) => String(r.stdout || "").trim())
          .catch(() => "");
      } catch { branch = ""; }
      return json({ branch });
    }

    case "git-ops-capabilities": {
      // 分支面板「块级 -p」按钮门控：aiti-cmd runner 服务在位才可用（缺席按钮隐藏，git-ops 方案 §2）
      return json({ stashInteractive: !!ctx.services?.get?.("aiti-cmd.runner") });
    }

    case "git-ops-stash-interactive": {
      // git stash -p 交互必须 PTY（逐 hunk y/n/d）——中继 aiti-cmd runner 建会话，
      // 用户在该终端内交互。命令为固定白名单两形态，仅 index 数值化，无自由命令面。
      if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
      const cwd = typeof body?.cwd === "string" && isAbsolute(body.cwd) ? body.cwd : "";
      if (!cwd) return json({ error: "cwd required" }, 400);
      const mode = body?.mode === "apply" ? "apply" : "push";
      let index = 0;
      if (mode === "apply") {
        index = Number(body?.index);
        if (!Number.isInteger(index) || index < 0) return json({ error: "index required" }, 400);
      }
      const runner = ctx.services?.get?.("aiti-cmd.runner") as
        | { run?: (opts: Record<string, unknown>) => { ok?: boolean; sessionId?: string; error?: string; message?: string } }
        | undefined;
      if (!runner?.run) return json({ error: "aiti-cmd runner unavailable" }, 503);
      const command = mode === "push" ? "git stash push -p" : `git stash apply -p stash@{${index}}`;
      const r = runner.run({ command, cwd, name: command, source: "session-manager" });
      if (!r?.ok) return json({ ok: false, error: r?.error || r?.message || "runner rejected" }, 500);
      return json({ ok: true, sessionId: r.sessionId });
    }

    case "core": {
      const sessions = await ctx.core.listSessions();
      const running = await ctx.core.getRunningSessionIds();
      return json({ sessionCount: sessions.length, runningCount: running.length });
    }

    case "session-tags": {
      if (req.method === "GET") return json(readTagData(ctx.configDir));
      if (req.method === "PUT") {
        const data = validateTagData(body);
        if (!data) return json({ error: "invalid data" }, 400);
        const current = readTagData(ctx.configDir);
        if (current.version !== data.version) return json({ error: "version conflict", current }, 409);
        data.version = current.version + 1;
        writeTagData(ctx.configDir, data);
        publishTagsChanged(ctx, data.version);
        return json({ ok: true, data });
      }
      return json({ error: "method not allowed" }, 405);
    }

    case "assign":
      return mutate(ctx, v, (d) => {
        if (typeof body?.sessionId !== "string" || typeof body?.path !== "string") return null;
        const r = findOrCreateTagPath(d, body.path);
        if (!r) return null;
        return setSessionTag(r.data, body.sessionId, r.leafId, true);
      });
    case "assignTag":
      // pick-by-existing-tag (TagPicker): add a known tag id directly
      return mutate(ctx, v, (d) => {
        if (typeof body?.sessionId !== "string" || typeof body?.tagId !== "string") return null;
        return setSessionTag(d, body.sessionId, body.tagId, true);
      });
    case "unassign":
      return mutate(ctx, v, (d) => {
        if (typeof body?.sessionId !== "string" || typeof body?.tagId !== "string") return null;
        return setSessionTag(d, body.sessionId, body.tagId, false);
      });
    case "favorite":
      return mutate(ctx, v, (d) =>
        typeof body?.sessionId === "string" ? toggleFavorite(d, body.sessionId, true) : null);
    case "unfavorite":
      return mutate(ctx, v, (d) =>
        typeof body?.sessionId === "string" ? toggleFavorite(d, body.sessionId, false) : null);
    case "recolor":
      return mutate(ctx, v, (d) =>
        typeof body?.tagId === "string" && typeof body?.color === "string"
          ? setTagColor(d, body.tagId, body.color) : null);
    case "rename":
      return mutate(ctx, v, (d) =>
        typeof body?.tagId === "string" && typeof body?.name === "string"
          ? renameTagNode(d, body.tagId, body.name) : null);
    case "delete":
      return mutate(ctx, v, (d) =>
        typeof body?.tagId === "string" ? deleteTagNode(d, body.tagId, body.subtree === true) : null);

    case "search":
      return searchEndpoint(ctx);
    case "hotwords":
      return hotwordsEndpoint(ctx, req, body);
    case "stats":
      return statsEndpoint(ctx);
    case "related-docs":
      return relatedDocsEndpoint(ctx);
    case "doc-sessions":
      return docSessionsEndpoint(ctx);
    case "doc-list":
      return docListEndpoint(ctx);
    case "sessions":
      return mergedSessionsEndpoint(ctx, req);
    case "workspaces":
      return workspacesEndpoint(ctx, req);
    case "archive":
      return archiveEndpoint(req, ctx, sub, rest, body);
    case "move":
      return moveEndpoint(ctx, body);
    case "move-batch":
      return moveBatchEndpoint(ctx, body);
    case "session-cwd":
      return detectSessionCwdEndpoint(ctx, body);
    case "sync": {
      const result = await syncIndex(ctx.configDir, ctx.core);
      return json(result);
    }

    /* ── M1: multi-agent sources ── */
    case "sources": {
      if (req.method === "POST") {
        const op = sub;
        // §4.8 fallback: explicit provider registration (no per-agent target)
        if (op === "register" || op === "unregister") {
          const extensionId = typeof body?.extensionId === "string" ? body.extensionId : null;
          if (!extensionId) return json({ error: "extensionId required" }, 400);
          if (op === "register") registerProvider(ctx.configDir, extensionId);
          else unregisterProvider(ctx.configDir, extensionId);
          await ensureProviders(ctx.configDir);
          return json({ ok: true, sources: await discoverSources(ctx.configDir) });
        }
        const agent = typeof body?.agent === "string" ? body.agent : null;
        if (!agent) return json({ error: "agent required" }, 400);
        await ensureProviders(ctx.configDir);
        const idx = runtime(ctx.configDir).index;
        if (op === "activate") return json(await activateSource(ctx.configDir, idx as never, agent));
        if (op === "sync") return json(await syncSource(ctx.configDir, idx as never, agent));
        if (op === "deactivate") return json(await deactivateSource(ctx.configDir, idx as never, agent));
        return json({ error: "unknown source action" }, 404);
      }
      return json({ sources: await discoverSources(ctx.configDir) });
    }
    case "session-ext": {
      // read-only viewer payload for one external session (?id=claude:<uuid>)
      const id = ctx.searchParams.get("id") ?? "";
      await ensureProviders(ctx.configDir);
      const resolved = resolveExtId(ctx.configDir, id);
      if (!resolved) return json({ error: "unknown agent" }, 400);
      let refs: Awaited<ReturnType<typeof resolved.adapter.list>>;
      try { refs = await resolved.adapter.list(); } catch (e) { return json({ error: `source list failed: ${String(e)}` }, 503); }
      const ref = refs.find((r) => r.sid === resolved.sid);
      if (!ref) return json({ error: "not found" }, 404);
      const parsed = await resolved.adapter.parse(ref);
      if (!parsed) return json({ error: "parse failed" }, 500);
      const imported = runtime(ctx.configDir).settings.extImports?.[id] ?? null;
      return json({ id, agent: resolved.adapter.id, label: resolved.adapter.label, meta: parsed.meta, messages: parsed.messages, importedSessionId: imported?.sessionId ?? null });
    }
    case "open-live": {
      // attach-from-history: open an external session as a LIVE driving session
      // through the host's session-provider slot (§0 of the multi-agent plan).
      // Requires a backend extension for that agent (e.g. aiti-claude-code-agent).
      if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
      const id = typeof body?.id === "string" ? body.id : "";
      const resolved = resolveExtId(ctx.configDir, id);
      if (!resolved) return json({ ok: false, reason: "unknown_agent" }, 400);
      const cwd = typeof body?.cwd === "string" && body.cwd ? body.cwd : "";
      if (!cwd) {
        // 尊重会话原 cwd：调用方未带时从适配器元数据取（避免后端回退到
        // pi-web 进程 cwd —— 对 cursor 这类按工作区隔离历史的 CLI 会造成分叉）
        try {
          const refs = await resolved.adapter.list();
          const ref = refs.find((r) => r.sid === resolved.sid);
          if (ref) cwd = (await resolved.adapter.parse(ref))?.meta.cwd ?? "";
        } catch { /* 兑底由后端处理 */ }
      }
      // 站位文件真实标题：适配器 meta.name（zcode/claude/codex 的 title）> 调用方。
      // 缺失时由 core 回退到 handle 首条 user 消息。
      let name = typeof body?.name === "string" && body.name ? body.name : "";
      if (!name) {
        try {
          const refs = await resolved.adapter.list();
          const ref = refs.find((r) => r.sid === resolved.sid);
          if (ref) name = (await resolved.adapter.parse(ref))?.meta.name ?? "";
        } catch { /* fallback 命名由 core 兑底 */ }
      }
      try {
        const result = await ctx.sessionProviders.open(id, {
          ...(cwd ? { cwd } : {}),
          ...(name ? { name } : {}),
        });
        return json(result);
      } catch (e) {
        return json({ ok: false, reason: "open_failed", error: e instanceof Error ? e.message : String(e) }, 500);
      }
    }

    case "import": {
      // release an external session into a native pi session (§4.5)
      if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
      const id = typeof body?.id === "string" ? body.id : "";
      await ensureProviders(ctx.configDir);
      const resolved = resolveExtId(ctx.configDir, id);
      if (!resolved) return json({ error: "unknown agent" }, 400);
      const refs = await resolved.adapter.list();
      const ref = refs.find((r) => r.sid === resolved.sid);
      if (!ref) return json({ error: "not found" }, 404);
      const parsed = await resolved.adapter.parse(ref);
      if (!parsed) return json({ error: "parse failed" }, 500);
      // §4.5 idempotency: re-importing the same source returns the original pi session
      const rt = runtime(ctx.configDir);
      const imports = rt.settings.extImports ??= {};
      const prior = imports[id];
      if (prior?.sessionId && existsSync(prior.path)) {
        return json({ ...prior, alreadyImported: true });
      }
      let homeDir = "";
      try { homeDir = await ctx.core.getHomeDir(); } catch { /* fallback below */ }
      homeDir ||= process.env.HOME ?? "";
      const result = writePiSession(parsed, {
        homeDir,
        agentId: resolved.adapter.id,
        sourceSid: resolved.sid,
        sourcePath: ref.path,
        fallbackCwd: join(homeDir, "imported-" + resolved.adapter.id),
      });
      if (!result) return json({ error: "import failed (missing cwd or unwritable sessions dir)" }, 500);
      imports[id] = { sessionId: result.sessionId, path: result.path };
      // rt.settings 是进程级缓存快照：extSources 水位/extRegisteredProviders 由
      // ext-sources 直接写盘，若整体回写会把同步后推进的水位冲回旧值（表现为
      // 源区"有更新"复活）。写回前以磁盘现状覆盖这两个外部所有字段。
      const disk = loadSettings(ctx.configDir);
      saveSettings(ctx.configDir, {
        ...rt.settings,
        extSources: disk.extSources,
        extRegisteredProviders: (disk as unknown as { extRegisteredProviders?: string[] }).extRegisteredProviders,
      } as Settings);
      // index the new pi session right away so it opens without waiting for a sync
      try { await syncIndex(ctx.configDir, ctx.core); } catch { /* next sync catches it */ }
      return json(result);
    }


    default:
      return null;
  }
}

async function hotwordsEndpoint(ctx: ExtApiCtx, req: Request, body: Record<string, unknown> | null): Promise<Response> {
  const cnCount = typeof body?.cnCount === "number" && body.cnCount > 0 ? Math.floor(body.cnCount) : Number(ctx.searchParams.get("cnCount") ?? 20);
  const enCount = typeof body?.enCount === "number" && body.enCount > 0 ? Math.floor(body.enCount) : Number(ctx.searchParams.get("enCount") ?? 20);
  const timeWeight = typeof body?.timeWeight === "string" ? body.timeWeight : ctx.searchParams.get("timeWeight") ?? "none";

  const dbPath = join(ctx.cacheDir || join(dirname(ctx.configDir), "cache"), "index.sqlite");
  if (!existsSync(dbPath)) {
    return json({ ok: false, error: "db_missing", message: "session index db not found" }, 500);
  }

  try {
    const result = await extractHotwordsFromDBAsync(dbPath, {
      cnCount, enCount, timeWeight,
      includeUser: typeof body?.includeUser === "boolean" ? body.includeUser : undefined,
      includeAi: typeof body?.includeAi === "boolean" ? body.includeAi : undefined,
      cwd: typeof body?.cwd === "string" && body.cwd ? body.cwd : undefined,
      paths: Array.isArray(body?.paths) ? body.paths.filter((x: unknown) => typeof x === "string" && x) : undefined,
    });
    return json({
      ok: true,
      cacheKey: `hotwords_${Date.now()}`,
      cacheTtlMs: 600000,
      ...result,
    });
  } catch (e) {
    console.error("[session-manager] hotwords failed:", e);
    return json({ ok: false, error: "hotword_extract_failed", message: e instanceof Error ? e.message : String(e) }, 500);
  }
}
