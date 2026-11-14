/**
 * aiti-doc-center · 文档中心扩展（server 端入口，v0.3 真 Worker 后台版）
 *
 * 方案：docs/aiti-doc-center-plan.md（§10.2 迭代）
 *
 * 线程模型（v0.3 关键变更）：
 *   - 主线程：HTTP API 查询（node:sqlite 读）+ SSE + watch/onOp 转发 + 回填编排（services.trace 拉取）
 *   - Worker 线程（dist/doc-worker.mjs）：全部索引写库（扫描/单文件/引用图/排名/回填落库）——
 *     node:sqlite 同步 API 在主线程会饿死事件循环（v0.2 实测整个 pi-web 失去响应）
 *   - dev/prod 共享数据根：WAL + synchronous=NORMAL + busy_timeout + meta.scan_lock 跨进程锁
 *
 * 红线：不读兄弟扩展 configDir（trace 台账只走 services.trace；session-manager/plan-first 只走 services 出口）；
 *       无轮询（定期=aiti-ai-schedule 钩子；实时=onOp/fs.watch 事件）。
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, watch as fsWatch } from "node:fs";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import {
  initSchema, countDirs, countDirsAsync, normalizeRoots, queryDocs, searchSnippets, tagsAll, tagTree, docDetail,
  writeFmTags,
  DEFAULT_EXCLUDES,
  findDocByAbsPath, registerFileDoc, addDbTag, removeDbTag, normalizeTag,
} from "./doc-core.ts";

let configDir = "";
let cacheDir = "";
let hostCtx: any = null;
let db: DatabaseSync | null = null;
let cfg = {
  roots: [] as string[],
  excludes: [] as string[],
  maxFileKB: 512,
  watch: true,
  planTag: "方案",
  // smart 综合排序权重（docs/aiti-doc-center-smart-ranking-plan.md §3.3，features.json rank.* 可覆盖）
  rank: { halfLifeDays: 45, wFresh: 0.45, wRank: 0.35, wPlan: 0.2, wRel: 0.7 } as any,
};
// scan 状态 = Worker 进度镜像（消息驱动，非轮询）
const scan = { running: false, done: 0, total: 0, current: "", changed: 0, lastAt: 0, lastError: "", watchDegraded: false, watchReason: "" };
const sseClients = new Set<any>();
let watchers: any[] = [];
let worker: Worker | null = null;
const backfillState = { running: false };
let lastApiAt = 0; // backfill 让路依据：15s 内有 API 请求 → 延迟回填（防大台账解析卡顿影响交互）

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// ───────────────────────── 配置（features.json → cfg） ─────────────────────────

function loadFeatures(): void {
  try {
    const feats = JSON.parse(readFileSync(join(dirname(dirname(configDir)), "features.json"), "utf8")); // <dataRoot>/features.json（configDir = <dataRoot>/<extId>/config）
    const mine = feats["aiti-doc-center"] ?? {};
    const val = (k: string, dflt: string) => (mine[k] === undefined || mine[k] === null ? dflt : String(mine[k]));
    cfg.roots = normalizeRoots(val("scan.roots", "~/workspace").split(/[;,\n]/));
    cfg.excludes = val("scan.excludes", DEFAULT_EXCLUDES.join(",")).split(/[;,\n]/).map((s: string) => s.trim()).filter(Boolean);
    cfg.maxFileKB = parseInt(val("scan.maxFileKB", "512"), 10) || 512;
    cfg.watch = !(mine["watch.enabled"] === false || val("watch.enabled", "true") === "false");
    cfg.planTag = val("tags.planTag", "方案") || "方案";
    cfg.rank = {
      halfLifeDays: parseFloat(val("rank.halfLifeDays", "45")) || 45,
      wFresh: parseFloat(val("rank.wFresh", "0.45")),
      wRank: parseFloat(val("rank.wRank", "0.35")),
      wPlan: parseFloat(val("rank.wPlan", "0.2")),
      wRel: parseFloat(val("rank.wRel", "0.7")),
    };
  } catch { /* features.json 缺失/坏行：保持默认 */ }
}

// ───────────────────────── Worker 桥 ─────────────────────────

function postWorker(msg: any): void {
  if (!worker) spawnWorker();
  try { worker?.postMessage(msg); } catch (e: any) { console.log("[aiti-doc-center] postWorker 失败: " + String(e?.message ?? e)); }
}

function spawnWorker(): void {
  if (worker) return;
  // ctx.dir = 本扩展部署目录（实例无关，dev/prod 各自正确）
  const workerPath = join((hostCtx as any)?.dir || ".", "dist", "doc-worker.mjs");
  if (!existsSync(workerPath)) {
    console.log("[aiti-doc-center] worker bundle 缺失（" + workerPath + "），索引不可用——请重新 deploy");
    return;
  }
  console.log("[aiti-doc-center] spawn cfg=" + JSON.stringify(cfg));
  const w = new Worker(workerPath, {
    workerData: { dbPath: join(cacheDir, "aiti-doc-center", "index.db"), cfg: JSON.parse(JSON.stringify(cfg)) },
  });
  w.unref(); // 不阻止进程退出（shutdown 仍显式 terminate）
  w.on("message", onWorkerMessage);
  w.on("error", (e) => { console.log("[aiti-doc-center] worker error: " + String(e)); worker = null; });
  w.on("exit", () => { if (worker === w) worker = null; });
  worker = w;
}

function onWorkerMessage(m: any): void {
  try {
    switch (m?.type) {
      case "ready":
        console.log("[aiti-doc-center] worker ready（索引真后台）");
        break;
      case "scan-start":
        scan.running = true; scan.done = 0; scan.total = m.total || 0; scan.changed = 0; scan.current = "";
        emit("scan-start", { total: m.total, full: m.full });
        break;
      case "scan-progress":
        scan.running = true; scan.done = m.done || 0; scan.total = m.total || 0; scan.current = m.current || "";
        emit("scan-progress", { done: m.done, total: m.total, current: m.current });
        break;
      case "scan-done":
        scan.running = false; scan.done = m.total || 0; scan.total = m.total || 0; scan.changed = m.changed || 0; scan.lastAt = Date.now();
        emit("scan-done", { total: m.total, changed: m.changed, deleted: m.deleted, edges: m.edges, dangling: m.dangling, ms: m.ms });
        void backfillTick().catch(() => {});
        break;
      case "doc-updated":
        emit("doc-updated", { root: m.root, rel: m.rel });
        break;
      case "graph-updated":
        emit("graph-updated", { edges: m.edges });
        break;
      case "session-ops-done":
        emit("sessions-backfilled", { sid: m.sid, docs: m.docs });
        break;
      case "scan-aborted":
        scan.running = false;
        break;
      case "log":
        scan.lastError = String(m.msg || "");
        console.log("[aiti-doc-center] " + scan.lastError);
        break;
    }
  } catch { /* 消息处理失败不影响 worker */ }
}

// ───────────────────────── git-trace onOp + 回填编排（main 侧） ─────────────────────────

let offOp: (() => void) | null = null;

function traceService(): any | null {
  // 双轨（DI 方案 P1）：ctx.services 优先，__piWebExt.byId 穿透兜底（生产旧 core 过渡期）
  const viaSvc = hostCtx?.services?.get?.("aiti-git-trace.trace");
  if (viaSvc && typeof viaSvc.readOps === "function" && typeof viaSvc.onOp === "function") return viaSvc;
  const reg = (globalThis as any).__piWebExt;
  const loaded = reg && typeof reg.byId === "function" ? reg.byId("aiti-git-trace") : null;
  const s = loaded?.ext?.services?.trace;
  return s && typeof s.readOps === "function" && typeof s.onOp === "function" ? s : null;
}

/** 惰性订阅 + 自愈重订（照 aiti-plan-first §3.3；git-trace 缺席则降级）。 */
function ensureTraceListening(): void {
  if (offOp) return;
  const s = traceService();
  if (!s) return;
  try {
    offOp = s.onOp((evt: any) => {
      const row = evt?.row;
      if (!row?.stores) return;
      for (const st of row.stores) {
        const storeRoot = normalizeRoots([String(st?.root ?? "")])[0]?.replace(/\/+$/, "");
        if (!storeRoot) continue;
        for (const rel of st?.paths ?? []) {
          if (!/\.(md|markdown)$/i.test(String(rel))) continue;
          // ops 的 root 是 git 仓根；docs 表键是扫描根+相对路径 → 平移映射
          // （P2-4：与回填 applySessionOps 同款——嵌套仓 root 深于扫描根时映射前缀。
          //   此前实时路径只认 root 相等，嵌套仓场景近实时索引静默丢失、只剩回填兜底）
          let mapped: { root: string; rel: string } | null = null;
          for (const sr0 of cfg.roots) {
            const sr = sr0.replace(/\/+$/, "");
            if (storeRoot === sr) { mapped = { root: sr, rel: String(rel) }; break; }
            if (storeRoot.startsWith(sr + "/")) { mapped = { root: sr, rel: storeRoot.slice(sr.length + 1) + "/" + String(rel) }; break; }
          }
          if (mapped) postWorker({ cmd: "reindex", root: mapped.root, rel: mapped.rel });
        }
      }
    });
    console.log("[aiti-doc-center] git-trace onOp 已订阅（AI 写 md 近实时索引）");
  } catch { offOp = null; }
}

let traceRetries = 0;
/** 启动时 git-trace 可能尚未加载（扩展按字母序启动）——有界退避重试（12×10s），成功即停，非常态轮询。 */
function ensureTraceWithRetry(): void {
  ensureTraceListening();
  if (offOp) { void backfillTick().catch(() => {}); return; }
  if (traceRetries++ < 12) setTimeout(ensureTraceWithRetry, 10_000);
}

/** 冷启动回填编排（有界：每轮 ≤3 session——readOps 全量解析大台账是主线程同步大块，必须小步+让路）。
 *  空闲检测：15s 内有 API 请求 → 15s 后重试（最多等 5min 仍执行，防永久饿死）。 */
async function backfillTick(force = false): Promise<void> {
  if (!db || backfillState.running) return;
  ensureTraceListening(); // 自愈订阅（git-trace 晚于本扩展装载的场景）
  const s = traceService();
  if (!s || typeof s.sessions !== "function" || typeof s.readOps !== "function") return;
  if (!force && lastApiAt && Date.now() - lastApiAt < 15_000) {
    setTimeout(() => { void backfillTick(true).catch(() => {}); }, 15_000);
    return;
  }
  backfillState.running = true;
  try {
    let done: string[] = [];
    try {
      const row = db.prepare("SELECT value FROM meta WHERE key='backfilled_sids'").get() as any;
      done = JSON.parse(row?.value ?? "[]");
    } catch { done = []; }
    const all = (s.sessions() as any[]) ?? [];
    const todo = all.filter((x) => !done.includes(x.sid)).slice(0, 3);
    for (const item of todo) {
      let rows: any[] = [];
      try { rows = (s.readOps(item.sid, { limit: 2000 }) as any[]) ?? []; } catch { done.push(item.sid); continue; }
      postWorker({ cmd: "session-ops", sid: item.sid, rows });
      done.push(item.sid);
      await new Promise((r) => setTimeout(r, 50)); // 逐会话让路
    }
    if (todo.length) {
      db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('backfilled_sids', ?)").run(JSON.stringify(done));
      emit("sessions-backfilled", { sessions: todo.length, remaining: Math.max(0, all.length - done.length) });
    }
  } finally { backfillState.running = false; }
}

/** 全量重放回填（POST /scan {replay:true}）：清 backfilled_sids 后自驱循环重补全部会话。
 *  修复存量「回填早于文档索引」的丢失关联；逐会话让路 50ms，SSE sessions-backfilled 报进度（零轮询）。
 *  调用方（/scan handler）已同步检查并置 backfillState.running——本函数不再重复检查（同同步段无竞态）。 */
async function replayBackfill(): Promise<boolean> {
  if (!db) return false;
  backfillState.running = true;
  try {
    const s = traceService();
    if (!s || typeof s.sessions !== "function" || typeof s.readOps !== "function") return false; // 先探 services，再清标记（缺席不清）
    db.prepare("DELETE FROM meta WHERE key='backfilled_sids'").run();
    const all = (s.sessions() as any[]) ?? [];
    const done: string[] = [];
    for (const item of all) {
      let rows: any[] = [];
      try { rows = (s.readOps(item.sid, { limit: 2000 }) as any[]) ?? []; } catch { done.push(item.sid); continue; }
      postWorker({ cmd: "session-ops", sid: item.sid, rows });
      done.push(item.sid);
      if (done.length % 10 === 0) emit("sessions-backfilled", { sessions: done.length, remaining: Math.max(0, all.length - done.length), replay: true });
      await new Promise((r) => setTimeout(r, 50));
    }
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('backfilled_sids', ?)").run(JSON.stringify(done));
    emit("sessions-backfilled", { sessions: done.length, remaining: 0, replay: true });
    return true;
  } finally { backfillState.running = false; }
}

// ───────────────────────── fs.watch（事件驱动） ─────────────────────────

function closeWatchers(): void {
  for (const w of watchers) { try { w.close(); } catch { /* ignore */ } }
  watchers = [];
}

// ── watch 初始化后台化（2026-09-11）────────────────────────────────────────
// 原状：startup 同步跑 countDirs（同步递归大 roots 秒级，实测 startup hook 2.1-3.2s，
// 每次 reload 全局停顿）。现在：startup 立即返回；探测走分片异步（countDirsAsync 批间
// 让路）+ 结果缓存（10min TTL，reload 间复用），watch 注册在探测完成后进行。
// 竞态防护：shutdown/重入使 watchInitGen++，in-flight 初始化自检代次后自行放弃。

const WATCH_DIRCOUNT_TTL_MS = 10 * 60_000;
const watchDirCounts = new Map<string, { dirs: number; at: number }>(); // 进程内缓存（跨 reload 复用）
let watchInitGen = 0;

function watchCountKey(root: string): string {
  return root + "\u0000" + [...cfg.excludes].sort().join(",");
}

function persistDirCounts(): void {
  if (!configDir) return;
  try {
    const dir = join(cacheDir, "aiti-doc-center");
    mkdirSync(dir, { recursive: true });
    const obj: Record<string, { dirs: number; at: number }> = {};
    for (const [k, v] of watchDirCounts) obj[k] = v;
    writeFileSync(join(dir, "dircount.json"), JSON.stringify(obj));
  } catch { /* best-effort */ }
}

function loadDirCounts(): void {
  if (!configDir) return;
  try {
    const raw = JSON.parse(readFileSync(join(cacheDir, "aiti-doc-center", "dircount.json"), "utf8")) as Record<string, { dirs: number; at: number }>;
    const now = Date.now();
    for (const [k, v] of Object.entries(raw ?? {})) {
      if (v && typeof v.dirs === "number" && typeof v.at === "number" && now - v.at < WATCH_DIRCOUNT_TTL_MS) watchDirCounts.set(k, v);
    }
  } catch { /* 无缓存/损坏 → 现探 */ }
}

async function initWatchers(): Promise<void> {
  const gen = ++watchInitGen;
  closeWatchers();
  if (!cfg.watch) return;
  loadDirCounts();
  for (const root of cfg.roots) {
    if (gen !== watchInitGen) return; // shutdown/重入：放弃本轮
    const key = watchCountKey(root);
    const cached = watchDirCounts.get(key);
    let dirs: number;
    if (cached && Date.now() - cached.at < WATCH_DIRCOUNT_TTL_MS) {
      dirs = cached.dirs;
    } else {
      dirs = await countDirsAsync(root, new Set(cfg.excludes), 50_000);
      if (gen !== watchInitGen) return;
      watchDirCounts.set(key, { dirs, at: Date.now() });
      persistDirCounts();
    }
    if (dirs > 50_000) {
      scan.watchDegraded = true;
      scan.watchReason = root + " 目录数 " + dirs + " > 50000（inotify 上限），已降级：外部编辑改动靠定期扫描（AI 写文件走 onOp 近实时）";
      console.log("[aiti-doc-center] " + scan.watchReason);
      continue;
    }
    setupWatchersForRoot(root);
  }
}

function setupWatchersForRoot(root: string): void {
  const pending = new Map<string, any>();
  const arm = (r: string, rel: string) => {
    const k = r + "\u0000" + rel;
    clearTimeout(pending.get(k));
    pending.set(k, setTimeout(() => { pending.delete(k); postWorker({ cmd: "reindex", root: r, rel }); }, 500));
  };
  try {
    const w = fsWatch(root, { recursive: true }, (_ev, fname) => {
      if (!fname) return;
      const rel = String(fname).replace(/\\/g, "/");
      if (!/\.(md|markdown)$/i.test(rel)) return;
      if (rel.split("/").some((seg) => cfg.excludes.includes(seg))) return;
      arm(root, rel);
    });
    w.on("error", () => {
      scan.watchDegraded = true;
      scan.watchReason = root + " fs.watch 错误（inotify 超限等），已降级";
      console.log("[aiti-doc-center] " + scan.watchReason);
      try { w.close(); } catch { /* ignore */ }
    });
    watchers.push(w);
  } catch { /* 单根失败不影响其余 */ }
}

// ───────────────────────── SSE ─────────────────────────

function emit(type: string, payload: any): void {
  if (!sseClients.size) return;
  const msg = `event: message\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
  const enc = new TextEncoder();
  for (const c of [...sseClients]) {
    try { c.enqueue(enc.encode(msg)); } catch { sseClients.delete(c); }
  }
}

function sseResponse(): Response {
  const enc = new TextEncoder();
  let ref: any = null;
  const stream = new ReadableStream({
    start(ctrl) { ref = ctrl; sseClients.add(ctrl); ctrl.enqueue(enc.encode(": connected\n\n")); },
    cancel() { sseClients.delete(ref); },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
}

// ───────────────────────── 动态 tag 层（§4.7：方案绑定 ⑤ + 会话标签继承 ⑥） ─────────────────────────

interface SmCache { version: number; sidPaths: Map<string, string[]>; display: Map<string, string>; allLower: Set<string>; favs: Set<string> }
let smCache: SmCache | null = null;

function smSnapshot(): SmCache | null {
  try {
    // 双轨（DI 方案 P1）：ctx.services 优先，__piWebExt.byId 穿透兜底
    const s = hostCtx?.services?.get?.("session-manager.tags")
      ?? (() => { const reg = (globalThis as any).__piWebExt; const loaded = reg && typeof reg.byId === "function" ? reg.byId("session-manager") : null; return loaded?.ext?.services?.tags ?? null; })();
    if (!s || typeof s.snapshot !== "function") return null;
    const snap = s.snapshot();
    if (!snap || !Array.isArray(snap.tags)) return null;
    if (smCache && smCache.version === snap.version) return smCache;
    const byId = new Map<string, { name: string; parent: string | null }>();
    for (const tg of snap.tags) byId.set(tg.id, { name: String(tg.name ?? ""), parent: tg.parentId ?? null });
    const pathOf = (id: string): string => {
      const parts: string[] = [];
      let cur = byId.get(id);
      const seen = new Set<string>();
      while (cur && cur.name && !seen.has(cur.name)) {
        seen.add(cur.name);
        parts.unshift(cur.name);
        cur = cur.parent ? byId.get(cur.parent) : undefined;
      }
      return parts.join("/");
    };
    const sidPaths = new Map<string, string[]>();
    const display = new Map<string, string>();
    for (const [sid, ids] of Object.entries(snap.sessionTags ?? {}) as [string, string[]][]) {
      const paths = (ids ?? []).map(pathOf).filter(Boolean);
      if (paths.length) {
        sidPaths.set(sid, paths);
        for (const p of paths) display.set(p.toLowerCase(), p);
      }
    }
    smCache = { version: Number(snap.version) || Date.now(), sidPaths, display, allLower: new Set(display.keys()), favs: new Set(((snap.favoriteIds ?? []) as any[]).map(String)) };
    return smCache;
  } catch { return null; }
}

/** 已归档 session id 集合（session-manager services.sessions.archivedIds 出口；
 *  归档会话的 jsonl 已进 .pwarc 容器，宿主 /api/sessions 扫不到，消息区打开会静默失败。
 *  缺席/异常返回空 Set —— 前端无 📦 标、不走归档通道，退化为现状）。 */
function smArchivedSet(): Set<string> {
  try {
    // 双轨（DI 方案 P1）：ctx.services 优先，__piWebExt.byId 穿透兜底
    const s = hostCtx?.services?.get?.("session-manager.sessions")
      ?? (() => { const reg = (globalThis as any).__piWebExt; const loaded = reg && typeof reg.byId === "function" ? reg.byId("session-manager") : null; return loaded?.ext?.services?.sessions ?? null; })();
    const ids = s?.archivedIds?.();
    return new Set(Array.isArray(ids) ? ids.map(String) : []);
  } catch { return new Set(); }
}

/** 收藏图标是否显示（统一 feature：session-manager 的 behavior.favorite-icons）。
 *  单点开关：extman 里 session-manager 的功能管理控制 All Sessions 与文档中心两处收藏图标。
 *  读取宿主 registry（featureEnabled）；宿主缺席/异常时缺省显示（与老行为一致，安全降级）。 */
function favIconVisible(): boolean {
  try {
    const reg = (globalThis as any).__piWebExt;
    if (reg && typeof reg.featureEnabled === "function") {
      return reg.featureEnabled("session-manager", "behavior.favorite-icons");
    }
  } catch { /* 宿主缺席：按缺省处理 */ }
  return true;
}

function planDocsSet(): Map<string, number> {
  try {
    // 双轨（DI 方案 P1）：ctx.services 优先，__piWebExt.byId 穿透兜底
    const s = hostCtx?.services?.get?.("aiti-plan-first.plans")
      ?? (() => { const reg = (globalThis as any).__piWebExt; const loaded = reg && typeof reg.byId === "function" ? reg.byId("aiti-plan-first") : null; return loaded?.ext?.services?.plans ?? null; })();
    if (!s || typeof s.planDocs !== "function") return new Map();
    const out = new Map<string, number>();
    for (const p of s.planDocs()) {
      if (p?.path) out.set(String(p.path).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase(), Number(p.boundAt) || 0);
    }
    return out;
  } catch { return new Map(); }
}

function docAbs(root: string, rel: string): string {
  return root.replace(/\/+$/, "") + "/" + rel;
}

function dynTagsForDoc(root: string, rel: string, sids: string[], plan: Map<string, number>, sm: SmCache | null): { key: string; display: string; source: string }[] {
  const out: { key: string; display: string; source: string }[] = [];
  if (plan.size && plan.has(docAbs(root, rel).toLowerCase())) {
    out.push({ key: cfg.planTag.toLowerCase(), display: cfg.planTag, source: "plan" });
  }
  if (sm) {
    const seen = new Set<string>(out.map((o) => o.key));
    for (const sid of sids) {
      for (const p of sm.sidPaths.get(sid) ?? []) {
        const k = p.toLowerCase();
        if (!seen.has(k)) { seen.add(k); out.push({ key: k, display: p, source: "session" }); }
      }
    }
  }
  return out;
}

function mergeDynTagsInto(result: any, plan: Map<string, number>, sm: SmCache | null): void {
  if (!db) return;
  const ids = result.items.map((i: any) => i.id);
  if (!ids.length || (!plan.size && !sm)) return;
  const inQ = ids.map(() => "?").join(",");
  const sessById = new Map<number, string[]>();
  for (const r of db.prepare(`SELECT doc_id, session_id FROM doc_sessions WHERE doc_id IN (${inQ})`).all(...ids) as any[]) {
    const arr = sessById.get(r.doc_id) ?? [];
    arr.push(r.session_id);
    sessById.set(r.doc_id, arr);
  }
  for (const it of result.items) {
    const sids = sessById.get(it.id) ?? [];
    const dyn = dynTagsForDoc(it.root, it.relpath, sids, plan, sm);
    if (dyn.length) {
      const seen = new Set((it.tags ?? []).map((x: any) => x.key));
      for (const d of dyn) if (!seen.has(d.key)) (it.tags ??= []).push(d);
    }
  }
}

function staticTagIds(key: string): number[] {
  if (!db) return [];
  return (db.prepare(
    `SELECT dt.doc_id FROM doc_tags dt JOIN tags tg ON tg.id = dt.tag_id
     WHERE tg.key=? OR substr(tg.key, 1, length(?)+1) = ? || '/'`).all(key, key, key) as any[]).map((r) => r.doc_id);
}

function dynTagDocIds(key: string): number[] | undefined {
  if (!db) return undefined;
  const ids = new Set<number>();
  const plan = planDocsSet();
  const sm = smSnapshot();
  const planKey = cfg.planTag.toLowerCase();
  if (key === planKey && plan.size) {
    for (const d of db.prepare("SELECT id, root, relpath FROM docs WHERE deleted=0").all() as any[]) {
      if (plan.has(docAbs(d.root, d.relpath).toLowerCase())) ids.add(d.id);
    }
  }
  if (sm && sm.allLower.has(key)) {
    const sids = [...sm.sidPaths.entries()].filter(([, ps]) => ps.some((p) => p.toLowerCase() === key)).map(([sid]) => sid);
    if (sids.length) {
      const inQ = sids.map(() => "?").join(",");
      for (const r of db.prepare(`SELECT DISTINCT doc_id FROM doc_sessions WHERE session_id IN (${inQ})`).all(...sids) as any[]) {
        ids.add(r.doc_id);
      }
    }
  }
  return ids.size ? [...ids] : undefined;
}

function tagsAllMerged(under?: string): any[] {
  if (!db) return [];
  const u = under ? under.replace(/[\\%_]/g, (ch) => "\\" + ch).replace(/\/+$/, "") + "/%" : "";
  const flat: any[] = tagsAll(db, under);
  const plan = planDocsSet();
  const sm = smSnapshot();
  const dynSrc = new Map<string, { src: string; display: string; count: number; tier: number }>();
  if (plan.size) {
    let n = 0;
    for (const d of db.prepare(`SELECT root, relpath FROM docs WHERE deleted=0${u ? " AND (root || '/' || relpath) LIKE ? ESCAPE '\\'" : ""}`).all(...(u ? [u] : [])) as any[]) {
      if (plan.has(docAbs(d.root, d.relpath).toLowerCase())) n++;
    }
    if (n) dynSrc.set(cfg.planTag.toLowerCase(), { src: "plan", display: cfg.planTag, count: n, tier: 1 });
  }
  if (sm) {
    const counts = new Map<string, Set<number>>();
    for (const r of db.prepare(`SELECT ds.doc_id, ds.session_id FROM doc_sessions ds JOIN docs d ON d.id = ds.doc_id AND d.deleted = 0${u ? " WHERE (d.root || '/' || d.relpath) LIKE ? ESCAPE '\\'" : ""}`).all(...(u ? [u] : [])) as any[]) {
      for (const p of sm.sidPaths.get(r.session_id) ?? []) {
        const k = p.toLowerCase();
        const s = counts.get(k) ?? new Set<number>();
        s.add(r.doc_id);
        counts.set(k, s);
      }
    }
    for (const [k, s] of counts) dynSrc.set(k, { src: "session", display: sm.display.get(k) ?? k, count: s.size, tier: 3 });
  }
  for (const f of flat) {
    const d = dynSrc.get(f.key);
    if (d) { f.src = d.src; f.tier = Math.min(f.tier ?? 4, d.tier); dynSrc.delete(f.key); }
  }
  for (const [k, d] of dynSrc) flat.push({ key: k, display: d.display, count: d.count, src: d.src, tier: d.tier });
  // 云/树排序：重要度优先（手打 > 方案 > inline > 会话继承 > 目录派生），同层按数量
  flat.sort((a, b) => (a.tier ?? 4) - (b.tier ?? 4) || b.count - a.count || String(a.key).localeCompare(String(b.key)));
  return flat;
}

function markTreeSrc(nodes: any[], srcMap: Map<string, string>): void {
  for (const n of nodes) {
    const src = srcMap.get(n.key);
    if (src) n.src = src;
    if (n.children?.length) markTreeSrc(n.children, srcMap);
  }
}

// ───────────────────────── 路径解析 + tags 写回（M4 工具 / M5 通道共用） ─────────────────────────

function resolveDocByPath(pathAbs: string): { root: string; rel: string; abs: string } | null {
  const p = normalizeRoots([pathAbs])[0];
  if (!p) return null;
  for (const r of cfg.roots) {
    if (p === r || p.startsWith(r + "/")) {
      const rel = p === r ? "" : p.slice(r.length + 1);
      if (!rel) return null;
      return { root: r, rel, abs: p };
    }
  }
  return null;
}

async function pathAllowed(p: string): Promise<boolean> {
  try {
    const fa = hostCtx?.core?.fileAccess;
    if (!fa?.isAllowed) return true; // 宿主无门禁（本地单测环境）→ 放行
    return await fa.isAllowed(p);
  } catch { return false; }
}

/** front-matter tags 写回（文件内单写点；写后经 Worker 重索引）。 */
function writeTagsToPath(root: string, rel: string, add: string[], remove: string[]): string[] {
  const abs = root + "/" + rel;
  const text = readFileSync(abs, "utf8");
  const r = writeFmTags(text, add, remove);
  if (r.text !== text) {
    writeFileSync(abs, r.text);
    postWorker({ cmd: "reindex", root, rel });
  }
  return r.tags;
}

// ───────────────────────── 扩展定义 ─────────────────────────

// 命名为模块常量：server.startup 经 ext.services.docs 接入 ctx.services 出口（DI 方案 P1）
const ext = {
  id: "aiti-doc-center",
  name: "文档中心",
  icon: "icon.svg",
  client: "dist/aiti-doc-center-client.mjs",
  ui: {
    clientImmediately: false, // [懒加载 v2] M1 已同步生产，懒化重启用
    // 懒加载 v2 M3批①：静态条目与 client 注册 id/icon 对齐（物化前后零闪变）
    toolbar: [{ id: "aiti-doc-center-open", label: "文档", title: "文档中心：workspace 文档收集与全文检索", icon: { svg: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>' } }],
    rightFileDock: [{ id: "docs", label: "文档" }],
    pages: [{ id: "aiti-doc-center-page", label: "文档中心", title: "aiti-doc-center：文档中心" }],
    i18n: {
      zh: {
        "dc.tabsDir": "目录",
        "dc.tabsTime": "时间",
        "dc.tabsSession": "会话",
        "dc.wsTipUnder": "workspace：{dir}（点击切换/移除已选）",
        "dc.wsTipAll": "workspace：全部（默认当前会话；点击选择并记忆）",
        "dc.all": "全部",
        "dc.collecting": "收集中 {done}/{total}",
        "dc.collectTip": "立即收集整理（增量扫描）",
        "dc.collect": "收集",
        "dc.close": "关闭",
        "dc.closeEsc": "关闭 (ESC)",
        "dc.searchPh": "搜索文件名/标题/正文/tag…（空格 = AND，文件名命中优先）",
        "dc.dirFilterTip": "目录过滤（弹出）",
        "dc.tagFilterTip": "标签过滤（弹出 tag 云）",
        "dc.dirLabel": "目录",
        "dc.tagsLabel": "标签",
        "dc.sortSmart": "综合",
        "dc.sortRel": "相关度",
        "dc.sortMtime": "更新时间",
        "dc.sortRank": "权重",
        "dc.sortTitle": "标题",
        "dc.filterTagsPh": "过滤标签…",
        "dc.clearAllTags": "清除全部已选标签",
        "dc.clearSel": "✕ 清除({n})",
        "dc.remove": "移除",
        "dc.clearFilters": "清除全部过滤",
        "dc.clear": "清除",
        "dc.tagCloud": "tag 云（点击过滤）",
        "dc.exportTagsTip": "导出标签清单（markdown：标签→文档列表）",
        "dc.exportList": "⇩ 清单",
        "dc.loading": "加载中…",
        "dc.docsCount": "{n} 篇",
        "dc.relNote": "（相关度=融合分：bm25+权重）",
        "dc.loadMore": "加载更多（{a}/{b}）",
        "dc.noMatch": "无匹配文档",
        "dc.noDocs": "暂无文档",
        "dc.srcSessions": "来自 All Sessions 会话标签继承",
        "dc.srcPlan": "方案（plan-first 绑定派生）",
        "dc.renameTagTip": "重命名 tag（子 tag 一并迁移；文件 front-matter 同步改写）",
        "dc.renameTagPrompt": "重命名 tag（子 tag 一并迁移；front-matter 来源同步改写文件）",
        "dc.renameFail": "重命名失败：",
        "dc.atCurrentTip": "引用到当前会话输入框（@ 路径，不发送）",
        "dc.reference": "引用",
        "dc.atNewTip": "新建会话并预填引用（文档在当前工作区/其关注路径内则保持当前 workspace，否则切到文档所在目录）",
        "dc.newSession": "新会话",
        "dc.openTip": "在右侧文件标签页打开",
        "dc.open": "打开",
        "dc.copyPathTip": "复制绝对路径",
        "dc.path": "路径",
        "dc.sessTipArchived": "打开创建/触达此文档的会话（已归档：在 All Sessions 归档查看器打开）",
        "dc.sessTipRecent": "打开创建/触达此文档的会话（最近：{name}）",
        "dc.sessTipRecentN": "打开创建/触达此文档的会话（最近：{name}，共 {n} 个，见下方关联会话）",
        "dc.session": "会话",
        "dc.dupStatus": "⚠ {n} 个 方案/* 状态 tag（{list}）",
        "dc.fixDupTip": "保留「{keep}」，移除 {rest}（写回 front-matter；正文内联 #tag 需手动删）",
        "dc.source": "来源: {src}",
        "dc.related": "引用 ({n})",
        "dc.touches": "{n} 次触达",
        "dc.sessDocsEmpty": "该会话触达的 md 均不在当前扫描根内",
        "dc.copySid": "复制 session id",
        "dc.wsFilterHead": "workspace 过滤（默认当前会话；选择会记住）",
        "dc.wsAll": "全部 workspace",
        "dc.wsCurrent": "● 当前：{name}",
        "dc.pinnedHead": "已选",
        "dc.trackedHead": "git-trace 追踪仓库",
        "dc.trackedTip": "aiti-git-trace 追踪动过的仓库",
        "dc.unpinRow": "从已选移除",
        "dc.running": "运行中",
        "dc.idle": "空闲",
        "dc.favorite": "收藏",
        "dc.planBound": "方案先行：已绑定 {plan}",
        "dc.archNote": "（已归档：消息区不可打开，↗ 在归档查看器打开）",
        "dc.histNote": "（历史）",
        "dc.archTag": "（归档）",
        "dc.histTag": "（历史）",
        "dc.openSessArchived": "已归档：在 All Sessions 归档查看器打开",
        "dc.openSess": "打开此会话",
        "dc.docsN": "{n} 篇",
        "dc.sidCopyTip2": "点击复制会话 id（去 All Sessions 面板打开）",
        "dc.docs": "文档",
        "dc.ftEmpty": "（无标签）",
        "dc.ftManual": "手工 tag（仅存文档中心）",
        "dc.ftFileSource": "文件来源：{src}",
        "dc.ftLoadFail": "加载失败（文档中心未就绪？）",
        "dc.ftTagsLabel": "标签",
        "dc.ftAddPh": "新增标签（回车确认；/ 分层级）",
        "dc.ftAdd": "添加",
        "dc.ftActionTitle": "标签（文档中心：查看/增删，非 md 文件打 tag 后进索引）",
      },
      en: {
        "dc.tabsDir": "Folder",
        "dc.tabsTime": "Time",
        "dc.tabsSession": "Sessions",
        "dc.wsTipUnder": "Workspace: {dir} (click to switch / remove pinned)",
        "dc.wsTipAll": "Workspace: all (defaults to current session; click to pick & remember)",
        "dc.all": "All",
        "dc.collecting": "Collecting {done}/{total}",
        "dc.collectTip": "Collect & index now (incremental scan)",
        "dc.collect": "Collect",
        "dc.close": "Close",
        "dc.closeEsc": "Close (ESC)",
        "dc.searchPh": "Search filename/title/body/tags… (space = AND; filename matches first)",
        "dc.dirFilterTip": "Filter by folder (popup)",
        "dc.tagFilterTip": "Filter by tags (popup tag cloud)",
        "dc.dirLabel": "Folder",
        "dc.tagsLabel": "Tags",
        "dc.sortSmart": "Smart",
        "dc.sortRel": "Relevance",
        "dc.sortMtime": "Updated",
        "dc.sortRank": "Weight",
        "dc.sortTitle": "Title",
        "dc.filterTagsPh": "Filter tags…",
        "dc.clearAllTags": "Clear all selected tags",
        "dc.clearSel": "✕ Clear({n})",
        "dc.remove": "Remove",
        "dc.clearFilters": "Clear all filters",
        "dc.clear": "Clear",
        "dc.tagCloud": "Tag cloud (click to filter)",
        "dc.exportTagsTip": "Export tag list (markdown: tag → docs)",
        "dc.exportList": "⇩ List",
        "dc.loading": "Loading…",
        "dc.docsCount": "{n} docs",
        "dc.relNote": " (relevance = fused: bm25 + weight)",
        "dc.loadMore": "Load more ({a}/{b})",
        "dc.noMatch": "No matching docs",
        "dc.noDocs": "No docs yet",
        "dc.srcSessions": "Inherited from All Sessions session tags",
        "dc.srcPlan": "Plan (derived from plan-first binding)",
        "dc.renameTagTip": "Rename tag (children migrate; file front-matter rewritten)",
        "dc.renameTagPrompt": "Rename tag (children migrate; front-matter sources rewritten in files)",
        "dc.renameFail": "Rename failed: ",
        "dc.atCurrentTip": "Reference into the current session input (@ path, not sent)",
        "dc.reference": "Ref",
        "dc.atNewTip": "New session with reference (keeps workspace if the doc is inside it / watched paths, else switches to the doc's folder)",
        "dc.newSession": "New session",
        "dc.openTip": "Open in the right file tab",
        "dc.open": "Open",
        "dc.copyPathTip": "Copy absolute path",
        "dc.path": "Path",
        "dc.sessTipArchived": "Open sessions that created/touched this doc (archived: opens in the All Sessions archive viewer)",
        "dc.sessTipRecent": "Open sessions that created/touched this doc (recent: {name})",
        "dc.sessTipRecentN": "Open sessions that created/touched this doc (recent: {name}, {n} total, see related sessions below)",
        "dc.session": "Sessions",
        "dc.dupStatus": "⚠ {n} plan/* status tags ({list})",
        "dc.fixDupTip": "Keep \"{keep}\", remove {rest} (written back to front-matter; inline #tags in the body need manual removal)",
        "dc.source": "Source: {src}",
        "dc.related": "References ({n})",
        "dc.touches": "{n} touches",
        "dc.sessDocsEmpty": "None of the md docs touched by this session are inside the current scan roots",
        "dc.copySid": "Copy session id",
        "dc.wsFilterHead": "Workspace filter (defaults to current session; remembered)",
        "dc.wsAll": "All workspaces",
        "dc.wsCurrent": "● Current: {name}",
        "dc.pinnedHead": "Pinned",
        "dc.trackedHead": "git-trace tracked repos",
        "dc.trackedTip": "Repo touched under aiti-git-trace tracking",
        "dc.unpinRow": "Unpin",
        "dc.running": "running",
        "dc.idle": "idle",
        "dc.favorite": "Favorite",
        "dc.planBound": "Plan-first: bound to {plan}",
        "dc.archNote": " (archived: not openable in the message view; use ↗ in the archive viewer)",
        "dc.histNote": " (history)",
        "dc.archTag": "(archived)",
        "dc.histTag": "(history)",
        "dc.openSessArchived": "Archived: open in the All Sessions archive viewer",
        "dc.openSess": "Open this session",
        "dc.docsN": "{n} docs",
        "dc.sidCopyTip2": "Click to copy session id (open it in All Sessions)",
        "dc.docs": "Docs",
        "dc.ftEmpty": "(no tags)",
        "dc.ftManual": "Manual tag (doc-center only)",
        "dc.ftFileSource": "File source: {src}",
        "dc.ftLoadFail": "Load failed (doc center not ready?)",
        "dc.ftTagsLabel": "Tags",
        "dc.ftAddPh": "Add tag (Enter to confirm; / for hierarchy)",
        "dc.ftAdd": "Add",
        "dc.ftActionTitle": "Tags (doc-center: view/add/remove; non-md files get indexed after tagging)",
      },
    },
  },
  ai: {
    manage: true,
    intro: "文档中心：workspace 文档收集/整理/全文检索。AI 可用 aiti_doc_search 找方案文档与 README，用 aiti_doc_tags_set 给文档打 tag（工具默认关；经 🤖 帮助点或 extman 打开 agentTools.enabled 后注入）",
    skills: "skills",
  },

  features: [
    { id: "scan.roots", type: "string", label: "扫描根目录", group: "文档收集", description: "逗号/换行分隔（支持 ~）。要精确控制 tag 层级和实时监听就把根定到具体仓库", placeholder: "~/workspace" },
    { id: "scan.excludes", type: "string", label: "排除目录", group: "文档收集", description: "逗号分隔的目录名或通配（*.tmp）；另自动遵循 .gitignore/.aitiignore/.dockerignore", placeholder: DEFAULT_EXCLUDES.join(",") },
    { id: "scan.maxFileKB", type: "string", label: "单文件上限 KB", group: "文档收集", description: "超过则只索元数据不索正文", placeholder: "512" },
    { id: "watch.enabled", type: "boolean", label: "实时监听", group: "文档收集", description: "fs.watch 事件驱动近实时重索引；目录数超 5 万自动降级" },
    { id: "tags.planTag", type: "string", label: "方案 tag 词", group: "标签", description: "方案状态 tag 的命名空间词（方案/评审中、方案/已实施…）", placeholder: "方案" },
    { id: "agentTools.enabled", type: "boolean", label: "AI 工具（M4）", group: "AI", default: false, description: "会话内注入 aiti_doc_* 工具（默认关；需要时经 aiti-helper 帮助点（🤖）临时启用，或扩展管理器开启）" },
  ],

  // 定期兜底：aiti-ai-schedule 聚合执行（不自造 setInterval；受调度器门控防 dev/prod 双触发）
  schedules: [
    {
      id: "doc-center-scan",
      name: "文档中心定期收集整理",
      intervalSec: 600,
      enabled: true,
      run: (_ctx: any) => { postWorker({ cmd: "scan", full: false }); },
    },
  ],

  // 跨扩展服务出口（plan-first 消费词表/搜索；docsOfSession 已就绪）
  services: {
    get docs() {
      return {
        tagsAll: (under?: string) => (db ? tagsAllMerged(under) : []),
        search: (q: string, limit = 10) => (db ? searchSnippets(db, q, limit).items : []),
        // v2 增强：供消费方（plan-first md 选择器）复用完整检索——q（FTS 全文/标题）/ tag（含子 tag）/ under（workspace 前缀）/ limit
        // 返回 items（含 tags），与 HTTP GET /docs 同构；db 未就绪返回 []
        query: (opts?: { q?: string; tag?: string; under?: string; limit?: number; offset?: number }): any[] =>
          db ? queryDocs(db, {
            q: opts?.q ?? undefined,
            tag: opts?.tag ?? undefined,
            under: opts?.under ?? undefined,
            sort: opts?.q ? "rel" : "mtime",
            limit: Math.min(Math.max(opts?.limit ?? 50, 1), 200),
            offset: Math.max(opts?.offset ?? 0, 0),
          }).items : [],
        // AI 工具出口（跨 reload 稳定）：带 snippet + total 的完整搜索。execute 经此动态取最新实现——
        // reload 换模块后旧会话闭包仍能拿到新 db（避免工具变成 db=null 的僵尸）。
        searchFull: (q: string, tag?: string, limit = 8) => {
          if (!db) return { total: 0, items: [] };
          const r = queryDocs(db, {
            q: String(q ?? "").trim(), tag: tag ? String(tag) : undefined,
            sort: "rel", limit: Math.min(Math.max(limit, 1), 20), withSnippet: true,
          });
          return { total: r.total, items: r.items };
        },
        docsOfSession: (sid: string) => {
          if (!db || !/^[A-Za-z0-9_-]{1,80}$/.test(String(sid))) return [];
          return db.prepare(
            `SELECT d.id, d.root, d.relpath, d.title FROM doc_sessions ds
             JOIN docs d ON d.id = ds.doc_id AND d.deleted = 0 WHERE ds.session_id = ?`).all(String(sid));
        },
        // 反向：文档 → 触达过的 session（doc_sessions 反查，todo-sm-sidebar-search-doc-condition §2；
        // dock 搜索「文档条件」P1 关联视图用；docId 来自 query/清单 items[].id）
        sessionsOfDoc: (docId: number) => {
          const id = Number(docId);
          if (!db || !Number.isInteger(id) || id <= 0) return [];
          return db.prepare(
            `SELECT ds.session_id AS sessionId, ds.first_op AS firstOp, ds.last_op AS lastOp, ds.op_count AS opCount
             FROM doc_sessions ds WHERE ds.doc_id = ? ORDER BY ds.last_op DESC`).all(id);
        },
      };
    },
  },

  server: {
    agent: {
      agentTools(_info: { sessionId?: string; cwd?: string }) {
        // 门控由 core 统一判定（feature agentTools.enabled + per-session enableExtTools），此处无条件返回
        return [
          {
            name: "aiti_doc_search",
            label: "aiti_doc_search",
            description: "搜索 workspace 文档中心（FTS 全文 + 权重融合排序）。参数 query（必填，≥3 字符效果最佳）、tag（可选，如 方案、docs）、limit（可选，默认 8）。返回带 snippet 高亮的文档清单（路径/标题/更新时间/tags）。",
            parameters: { type: "object", properties: { query: { type: "string" }, tag: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
            async execute(_id: string, params: any) {
              const q = String(params?.query ?? "").trim();
              if (!q) return { content: [{ type: "text", text: "query 不能为空" }], isError: true } as never;
              // 经 services 通道动态取最新实现（跨 reload 稳定）：reload 换模块后旧会话闭包里的模块级 db
              // 已被旧 shutdown 置 null（此前直接 queryDocs(db!, …) 崩成
              // “Cannot read properties of null (reading 'prepare')”）——services 出口由 registry 提供当前
              // 最新模块的实现，旧会话也能拿到新 db；get 缺席/未就绪时友好提示。
              const svc = hostCtx?.services?.get?.("aiti-doc-center.docs") as any;
              const r = svc && typeof svc.searchFull === "function"
                ? svc.searchFull(q, params?.tag ? String(params.tag) : undefined, Math.min(Number(params?.limit) || 8, 20))
                : (db ? queryDocs(db, {
                    q, tag: params?.tag ? String(params.tag) : undefined,
                    sort: "rel", limit: Math.min(Number(params?.limit) || 8, 20), withSnippet: true,
                  }) : { total: 0, items: [] });
              const lines = r.items.map((it) => `· ${it.title}\n  ${it.root}/${it.relpath}\n  更新 ${new Date(it.mtimeMs).toISOString().slice(0, 10)}  tags: ${(it.tags || []).map((t: any) => "#" + t.key).join(" ") || "—"}\n  ${String(it.snippet || "").replace(/<\/?mark>/g, "")}`);
              return { content: [{ type: "text", text: `共 ${r.total} 篇命中：\n${lines.join("\n\n") || "（无）"}` }] } as never;
            },
          },
          {
            name: "aiti_doc_tags_set",
            label: "aiti_doc_tags_set",
            description: "给文档写 tags（写入 front-matter，文件内单写点）。参数 path（绝对路径）、tags（完整最终列表）。规则：方案文档必须带且仅带一个状态 tag：方案/评审中、方案/已实施、方案/已过时；内容 tag 优先从现有词表选。",
            parameters: { type: "object", properties: { path: { type: "string" }, tags: { type: "array", items: { type: "string" } } }, required: ["path", "tags"] },
            async execute(_id: string, params: any) {
              const p = String(params?.path ?? "");
              const resolved = resolveDocByPath(p);
              if (!resolved) return { content: [{ type: "text", text: "path 不在任何扫描根内：" + p }], isError: true } as never;
              if (!(await pathAllowed(resolved.abs))) return { content: [{ type: "text", text: "path 未获宿主文件门禁放行" }], isError: true } as never;
              try {
                const tags = writeTagsToPath(resolved.root, resolved.rel, Array.isArray(params?.tags) ? params.tags.map(String) : [], []);
                return { content: [{ type: "text", text: "已写入 front-matter tags：" + tags.join(", ") }] } as never;
              } catch (e: any) {
                return { content: [{ type: "text", text: "写入失败：" + String(e?.message ?? e) }], isError: true } as never;
              }
            },
          },
        ];
      },
    },
    startup(ctx: any) {
      const __t0 = Date.now();
      const __tick = (label: string) => {
        const dt = Date.now() - __t0;
        if (dt > 200) console.log(`[aiti-doc-center] startup +${dt}ms @${label}`); // 慢段诊断（>200ms 才打印）
      };
      hostCtx = ctx;
      configDir = ctx.configDir || "";
      // 数据分层：cache 在扩展数据根下（configDir = <extRoot>/config）
      cacheDir = ctx.cacheDir || (configDir ? join(dirname(configDir), "cache") : "");
      // 跨扩展服务出口（DI 方案 P1）：ctx.services 通道（docs 方法闭包引用模块 db
      // 变量，调用时现取，索引就绪前后皆安全）；旧通道（__piWebExt.byId 穿透）双轨保留。
      ctx.services?.provide?.("aiti-doc-center.docs", ext.services.docs);
      // 自愈重订（plan-first §3.3 同款）：trace 服务上线即重订，不等下一轮回填探测
      hostCtx?.services?.onChange?.((key: string, phase: string) => {
        if (key === "aiti-git-trace.trace" && phase === "up") { try { ensureTraceListening(); } catch {} }
      });
      // lazy migrate（数据分层双保险）：遗留索引目录 → cache/（索引可重建）；迁移脚本把旧根级条目
      // 归入 config/，故 from = <configDir>/aiti-doc-center（旧位置 / 误归位两种情形均自愈到 cache）
      try {
        const from = join(configDir, "aiti-doc-center"), to = join(cacheDir, "aiti-doc-center");
        if (existsSync(from) && !existsSync(to)) { mkdirSync(join(to, ".."), { recursive: true }); renameSync(from, to); }
      } catch { /* 下次重试 */ }
      const dir = join(cacheDir, "aiti-doc-center");
      mkdirSync(dir, { recursive: true });
      db = new DatabaseSync(join(dir, "index.db"));
      db.exec("PRAGMA journal_mode=WAL;");
      db.exec("PRAGMA busy_timeout=5000");
      __tick("db-open");
      initSchema(db);
      loadFeatures();
      __tick("schema+features");
      spawnWorker(); // 索引 Worker（扫描/写库全在后台线程；hostCtx.dir 已就绪）
      ensureTraceWithRetry();
      __tick("worker+trace");
      setTimeout(() => { postWorker({ cmd: "scan", full: false }); }, 3000); // 启动增量扫描（Worker 内跑，不占主线程）
      // watch 初始化后台化：countDirs 分片探测 + 10min 缓存，不再阻塞 startup（reload 全局停顿根因）；
      // 后台就绪前的窗口内改动由 onOp（AI 写文件）+ 定期扫描兼底，与降级路径同一套兼底。
      void initWatchers().catch((e) => console.log("[aiti-doc-center] watch init failed: " + String(e)));
      console.log("[aiti-doc-center] 就绪 · roots=" + cfg.roots.length + " · watch=" + (cfg.watch ? "on(background)" : "off") + " · " + (Date.now() - __t0) + "ms");
    },

    shutdown() {
      watchInitGen++; // 中止 in-flight watch 初始化（initWatchers 内部代次自检）
      try { offOp?.(); } catch { /* ignore */ }
      offOp = null;
      closeWatchers();
      try { worker?.postMessage({ cmd: "abort" }); worker?.terminate(); } catch { /* ignore */ }
      worker = null;
      for (const c of [...sseClients]) { try { c.close(); } catch { /* ignore */ } sseClients.delete(c); }
      try { db?.close(); } catch { /* ignore */ }
      db = null;
      console.log("[aiti-doc-center] 关闭");
    },

    async api(req: Request, ctx: any) {
      lastApiAt = Date.now();
      if (!db) return json({ ok: false, error: "not ready" }, 503);
      const p: string[] = (ctx.path as string[]) || [];
      const sp = new URL(req.url).searchParams;
      const num = (v: string | null, dflt: number) => { const n = parseInt(v ?? "", 10); return Number.isFinite(n) ? n : dflt; };

      if (req.method === "GET" && p[0] === "docs" && !p[1]) {
        const tagParams = sp.getAll("tag").map((x) => x.toLowerCase()).filter(Boolean);
        let tagIdSets: number[][] | undefined;
        if (tagParams.length) {
          tagIdSets = [];
          for (const key of tagParams) {
            const set = new Set<number>(staticTagIds(key));
            for (const id of dynTagDocIds(key) ?? []) set.add(id);
            tagIdSets.push([...set].slice(0, 5000));
          }
          if (tagIdSets.some((s) => !s.length)) return json({ ok: true, items: [], total: 0, facets: [] });
        }
        const result = queryDocs(db, {
          q: sp.get("q") ?? undefined,
          dir: sp.get("dir") ?? undefined,
          // 缺省 smart 综合排序（浏览视图三信号加权；搜索视图相关性主导）
          sort: sp.get("sort") ?? "smart",
          limit: num(sp.get("limit"), 50),
          offset: num(sp.get("offset"), 0),
          withSnippet: sp.get("snippet") === "1",
          tagIdSets,
          under: sp.get("under") ?? undefined,
          planPaths: new Set(planDocsSet().keys()),
          smart: { now: Date.now(), halfLifeDays: cfg.rank.halfLifeDays, wFresh: cfg.rank.wFresh, wRank: cfg.rank.wRank, wPlan: cfg.rank.wPlan, wRel: cfg.rank.wRel },
        });
        mergeDynTagsInto(result, planDocsSet(), smSnapshot());
        return json({ ok: true, ...result });
      }
      if (req.method === "GET" && p[0] === "docs" && p[1]) {
        const id = Number(p[1]);
        if (!Number.isInteger(id) || id <= 0) return json({ ok: false, error: "bad id" }, 400);
        const d = docDetail(db, id, cfg.roots);
        if (d) {
          // 关联会话名称补全（与 sessions-view 同源：core.listSessions() 的 name/firstMessage；
          // 历史会话不在列表则回落空——前端显示 sid 前缀）
          try {
            const core = (hostCtx as any)?.core;
            if (core?.listSessions) {
              const live = (await core.listSessions()) as any[];
              const byId = new Map(live.map((s: any) => [String(s?.id), String(s?.name || s?.firstMessage || "").split("\n")[0].slice(0, 80)]));
              for (const s of d.sessions || []) s.name = byId.get(String(s.session_id)) || "";
            }
          } catch { /* 宿主核心缺席：前端回落 sid */ }
          // 归档标（session-manager 出口；归档会话消息区打不开，前端降级为归档查看器通道）
          try {
            const archivedSet = smArchivedSet();
            for (const s of d.sessions || []) s.archived = archivedSet.has(String(s.session_id));
          } catch { /* 缺席：前端按未归档处理（现状行为） */ }
          const dyn = dynTagsForDoc(d.root, d.relpath, (d.sessions || []).map((s: any) => s.session_id), planDocsSet(), smSnapshot());
          if (dyn.length) {
            const seen = new Set((d.tags || []).map((x: any) => x.key));
            for (const x of dyn) if (!seen.has(x.key)) d.tags.push(x);
          }
          d.planBound = dyn.some((x) => x.source === "plan");
        }
        return d ? json({ ok: true, doc: d }) : json({ ok: false, error: "not found" }, 404);
      }
      if (req.method === "PUT" && p[0] === "docs" && p[2] === "tags") {
        const id = Number(p[1]);
        const d = id > 0 ? (db as DatabaseSync).prepare("SELECT id, root, relpath FROM docs WHERE id=?").get(id) as any : null;
        if (!d) return json({ ok: false, error: "not found" }, 404);
        let body: any = {};
        try { body = await req.json(); } catch { /* 无 body 容忍 */ }
        const add = Array.isArray(body?.add) ? body.add.map(String) : [];
        const remove = Array.isArray(body?.remove) ? body.remove.map(String) : [];
        const abs = d.root + "/" + d.relpath;
        if (!(await pathAllowed(abs))) return json({ ok: false, error: "path not allowed" }, 403);
        try {
          const tags = writeTagsToPath(d.root, d.relpath, add, remove);
          return json({ ok: true, tags });
        } catch (e: any) {
          return json({ ok: false, error: String(e?.message ?? e) }, 500);
        }
      }
      // ── M6-B file-tags：非 md 文件手工 tag（编辑器顶栏 🏷 入口的数据源）──
      // GET /file-tags?path= —— 现有 tag（全来源；未登记返回空数组）
      if (req.method === "GET" && p[0] === "file-tags") {
        const path = String(sp.get("path") ?? "").trim();
        if (!path) return json({ ok: false, error: "需要 path" }, 400);
        const d = db ? findDocByAbsPath(db, path) : null;
        const tags = d && db
          ? (db.prepare("SELECT tg.key, tg.display, dt.source FROM doc_tags dt JOIN tags tg ON tg.id = dt.tag_id WHERE dt.doc_id=? ORDER BY tg.key").all(d.id) as any[])
          : [];
        return json({ ok: true, path, docId: d?.id ?? null, kind: d?.kind ?? null, tags });
      }
      // POST /file-tags {path, tags:[key…]} —— 登记（非 md → kind='file'）+ 加 db 来源 tag
      if (req.method === "POST" && p[0] === "file-tags") {
        let body: any = {};
        try { body = await req.json(); } catch { /* 无 body 容忍 */ }
        const path = String(body?.path ?? "").trim();
        const tagsIn = Array.isArray(body?.tags) ? body.tags.map(String).filter(Boolean) : [];
        if (!path || !tagsIn.length) return json({ ok: false, error: "需要 path 与 tags" }, 400);
        if (!(await pathAllowed(path))) return json({ ok: false, error: "path not allowed" }, 403);
        if (!existsSync(path)) return json({ ok: false, error: "文件不存在" }, 404);
        try {
          let st: any = null;
          try { st = (await import("node:fs")).statSync(path); } catch { /* stat 失败容忍（meta 缺省） */ }
          const docId = registerFileDoc(db as DatabaseSync, path, { mtimeMs: st?.mtimeMs, size: st?.size });
          const applied: string[] = [];
          for (const t of tagsIn) {
            const r = addDbTag(db as DatabaseSync, docId, t);
            if (r) applied.push(r.key);
          }
          return json({ ok: true, docId, applied });
        } catch (e: any) {
          return json({ ok: false, error: String(e?.message ?? e) }, 500);
        }
      }
      // DELETE /file-tags {path, tags:[key…]} —— 删 db tag（纯 DB 操作；kind='file' 删光即软删退出索引）
      if (req.method === "DELETE" && p[0] === "file-tags") {
        let body: any = {};
        try { body = await req.json(); } catch { /* 无 body 容忍 */ }
        const path = String(body?.path ?? "").trim();
        const tagsIn = Array.isArray(body?.tags) ? body.tags.map(String).filter(Boolean) : [];
        if (!path || !tagsIn.length) return json({ ok: false, error: "需要 path 与 tags" }, 400);
        const d = db ? findDocByAbsPath(db, path) : null;
        if (!d) return json({ ok: true, removed: 0 });
        let removed = 0;
        for (const t of tagsIn) if (removeDbTag(db as DatabaseSync, d.id, t)) removed++;
        return json({ ok: true, removed });
      }
      if (req.method === "GET" && p[0] === "search") {
        const q = sp.get("q") ?? "";
        if (!q.trim()) return json({ ok: true, items: [], total: 0, facets: [] });
        return json({ ok: true, ...queryDocs(db, { q, withSnippet: true, sort: "rel", limit: num(sp.get("limit"), 10), under: sp.get("under") ?? undefined }) });
      }
      // ── M5：tag 批量重命名（front-matter 写回 + DB 迁移；inline/path 来源仅迁 DB，不改文件）──
      if (req.method === "POST" && p[0] === "tags" && p[1] === "rename") {
        let body: any = {};
        try { body = await req.json(); } catch { /* 无 body 容忍 */ }
        const oldKey = String(body?.key ?? "").trim();
        const nt = normalizeTag(String(body?.newKey ?? ""));
        if (!oldKey || !nt) return json({ ok: false, error: "需要 key 与合法 newKey" }, 400);
        if (oldKey === nt.key) return json({ ok: false, error: "新名与旧名相同" }, 400);
        const oldTag = (db as DatabaseSync).prepare("SELECT id FROM tags WHERE key=?").get(oldKey) as any;
        if (!oldTag) return json({ ok: false, error: "tag 不存在" }, 404);
        (db as DatabaseSync).prepare("INSERT OR IGNORE INTO tags(key, display) VALUES(?, ?)").run(nt.key, nt.display);
        const newTag = (db as DatabaseSync).prepare("SELECT id FROM tags WHERE key=?").get(nt.key) as any;
        let rewritten = 0, moved = 0, skipped = 0;
        (db as DatabaseSync).exec("BEGIN");
        try {
          const rows = (db as DatabaseSync).prepare(
            "SELECT dt.doc_id, dt.source, d.root, d.relpath FROM doc_tags dt JOIN docs d ON d.id=dt.doc_id WHERE dt.tag_id=?").all(oldTag.id) as any[];
          for (const r of rows) {
            // 文件写回仅限 front-matter 可写来源；inline 在正文不可安全改写、path 由目录派生——只迁 DB
            if ((r.source === "frontmatter" || r.source === "ui") && r.root && r.relpath) {
              const abs = r.root + "/" + r.relpath;
              try {
                if (existsSync(abs) && (await pathAllowed(abs))) {
                  const text = readFileSync(abs, "utf8");
                  const wr = writeFmTags(text, [nt.key], [oldKey]);
                  if (wr.text !== text) {
                    writeFileSync(abs, wr.text);
                    postWorker({ cmd: "reindex", root: r.root, rel: r.relpath });
                  }
                  rewritten++;
                }
              } catch { skipped++; }
            } else if (r.source === "inline" || r.source === "path") {
              skipped++;
            }
            (db as DatabaseSync).prepare("INSERT OR IGNORE INTO doc_tags(doc_id, tag_id, source) VALUES(?,?,?)").run(r.doc_id, newTag.id, r.source);
            (db as DatabaseSync).prepare("DELETE FROM doc_tags WHERE doc_id=? AND tag_id=? AND source=?").run(r.doc_id, oldTag.id, r.source);
            moved++;
          }
          const left = (db as DatabaseSync).prepare("SELECT COUNT(*) c FROM doc_tags WHERE tag_id=?").get(oldTag.id) as any;
          if (!left.c) (db as DatabaseSync).prepare("DELETE FROM tags WHERE id=?").run(oldTag.id);
          (db as DatabaseSync).exec("COMMIT");
          return json({ ok: true, moved, rewritten, skipped });
        } catch (e: any) {
          try { (db as DatabaseSync).exec("ROLLBACK"); } catch { /* noop */ }
          return json({ ok: false, error: String(e?.message ?? e) }, 500);
        }
      }
      // GET /tags/export —— M5：标签清单导出（markdown 下载；under 过滤透传）
      if (req.method === "GET" && p[0] === "tags" && p[1] === "export") {
        const flat = tagsAllMerged(sp.get("under") ?? undefined);
        const lines: string[] = [
          "# doc-center 标签清单",
          "",
          "- 导出时间：" + new Date().toISOString(),
          "- 标签数：" + flat.length,
          "",
        ];
        for (const t of flat) {
          lines.push("## #" + t.key + "（" + (t.display || t.key) + "）· " + t.count + " 篇");
          const rows = (db as DatabaseSync).prepare(
            "SELECT d.root, d.relpath FROM doc_tags dt JOIN tags tg ON tg.id=dt.tag_id JOIN docs d ON d.id=dt.doc_id AND d.deleted=0 WHERE tg.key=? ORDER BY d.relpath LIMIT 200").all(t.key) as any[];
          for (const r of rows) lines.push("- " + r.root + "/" + r.relpath);
          lines.push("");
        }
        return new Response(lines.join("\n"), {
          headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": 'attachment; filename="doc-tags.md"' },
        });
      }
      if (req.method === "GET" && p[0] === "tags") {
        const flat = tagsAllMerged(sp.get("under") ?? undefined);
        const tree = tagTree(flat);
        const srcMap = new Map<string, string>(flat.filter((f) => f.src).map((f) => [f.key, f.src]));
        markTreeSrc(tree, srcMap);
        return json({ ok: true, tags: flat, tree, planTag: cfg.planTag });
      }
      if (req.method === "POST" && p[0] === "scan") {
        let body: any = {};
        try { body = await req.json(); } catch { /* 无 body 容忍 */ }
        if (body?.replay) {
          // 同步占锁防 backfillTick 抢跑（reload 后启动 tick 会先到）；跑完释放，busy 时如实告知
          if (backfillState.running || !db) return json({ ok: false, error: "backfill busy，稍后重试" }, 409);
          backfillState.running = true;
          void replayBackfill().catch(() => {}).finally(() => { backfillState.running = false; });
          return json({ ok: true, replay: true });
        }
        postWorker({ cmd: "scan", full: Boolean(body?.full) });
        return json({ ok: true, started: true });
      }
      if (req.method === "GET" && p[0] === "workspaces") {
        // workspace 候选：必须位于 scan.roots 之下（排除 home/扫描根本身这类容器）。
        // 来源 = ①索引文档的一级目录（有文档）②git-trace 追踪动过的仓库（sessionStores 全量）
        const rows = db.prepare("SELECT root, relpath FROM docs WHERE deleted=0").all() as any[];
        const list = new Map<string, { path: string; docs: number; tracked: boolean }>();
        for (const r of rows) {
          const seg = String(r.relpath).split("/")[0];
          if (!seg) continue;
          const p = docAbs(r.root, seg);
          const e = list.get(p) ?? { path: p, docs: 0, tracked: false };
          e.docs += 1;
          list.set(p, e);
        }
        const s = traceService();
        if (s && typeof s.sessions === "function" && typeof s.sessionStores === "function") {
          try {
            for (const item of (s.sessions() as any[]) ?? []) {
              for (const st of (s.sessionStores(item.sid) as any[]) ?? []) {
                const root = typeof st?.root === "string" ? st.root.replace(/\/+$/, "") : "";
                if (!root) continue;
                if (!cfg.roots.some((r: string) => root.startsWith(r + "/"))) continue; // 只收扫描根之下
                const e = list.get(root) ?? { path: root, docs: 0, tracked: false };
                e.tracked = true;
                list.set(root, e);
              }
            }
          } catch { /* trace 缺席降级：仅文档候选 */ }
        }
        const out = [...list.values()].sort((a, b) => (b.tracked ? 1 : 0) - (a.tracked ? 1 : 0) || b.docs - a.docs);
        return json({ ok: true, workspaces: out, roots: cfg.roots });
      }
      if (req.method === "GET" && p[0] === "sessions-view") {
        const rows = db.prepare(
          `SELECT ds.session_id sid, COUNT(DISTINCT ds.doc_id) docs, MAX(ds.last_op) lastOp
           FROM doc_sessions ds JOIN docs d ON d.id = ds.doc_id AND d.deleted = 0
           GROUP BY ds.session_id ORDER BY lastOp DESC LIMIT 200`).all() as any[];
        let live: any[] = [];
        const runningSet = new Set<string>();
        try {
          const core = (hostCtx as any)?.core;
          if (core?.listSessions) live = (await core.listSessions()) as any[];
          if (core?.getRunningSessionIds) for (const r of (await core.getRunningSessionIds()) as string[]) runningSet.add(String(r));
        } catch { /* 宿主核心缺席：名称回落 sid */ }
        const liveById = new Map(live.map((s: any) => [String(s.id), s]));
        const sm = smSnapshot();
        const favVisible = favIconVisible();
        const archivedSet = smArchivedSet();
        const out = rows.map((r) => {
          const s = liveById.get(r.sid);
          return {
            sid: r.sid, docs: r.docs, lastOp: r.lastOp,
            name: s?.name || s?.firstMessage || r.sid.slice(0, 12),
            running: runningSet.has(r.sid),
            favorite: sm ? (favVisible && sm.favs.has(r.sid)) : false,
            tags: sm ? (sm.sidPaths.get(r.sid) ?? []).map((p) => sm.display.get(p.toLowerCase()) ?? p) : [],
            live: !!s,
            archived: archivedSet.has(r.sid),
          };
        });
        out.sort((a, b) => (b.running ? 1 : 0) - (a.running ? 1 : 0) || (b.lastOp || 0) - (a.lastOp || 0));
        return json({ ok: true, sessions: out });
      }
      if (req.method === "GET" && p[0] === "sessions" && !p[1]) {
        const rows = db.prepare(
          `SELECT ds.session_id sid, COUNT(DISTINCT ds.doc_id) docs, MAX(ds.last_op) lastOp
           FROM doc_sessions ds JOIN docs d ON d.id = ds.doc_id AND d.deleted = 0
           GROUP BY ds.session_id ORDER BY lastOp DESC LIMIT 200`).all();
        return json({ ok: true, sessions: rows });
      }
      if (req.method === "GET" && p[0] === "sessions" && p[1] && p[2] === "docs") {
        const sid = String(p[1]);
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(sid)) return json({ ok: false, error: "bad sid" }, 400);
        const rows = db.prepare(
          `SELECT d.id, d.root, d.relpath, d.title, d.mtime_ms AS mtimeMs, ds.first_op AS firstOp, ds.last_op AS lastOp, ds.op_count AS opCount
           FROM doc_sessions ds JOIN docs d ON d.id = ds.doc_id AND d.deleted = 0
           WHERE ds.session_id = ? ORDER BY ds.last_op DESC LIMIT 200`).all(sid);
        return json({ ok: true, sid, docs: rows });
      }
      if (req.method === "GET" && p[0] === "stats") {
        const docs = db.prepare("SELECT COUNT(*) c FROM docs WHERE deleted=0").get() as any;
        const tags = db.prepare("SELECT COUNT(*) c FROM tags").get() as any;
        const links = db.prepare("SELECT COUNT(*) c FROM doc_links").get() as any;
        const sess = db.prepare("SELECT COUNT(DISTINCT session_id) c FROM doc_sessions").get() as any;
        return json({ ok: true, docs: docs.c, tags: tags.c, links: links.c, sessions: sess.c, scan: { ...scan, watchers: watchers.length } });
      }
      if (req.method === "GET" && p[0] === "events") return sseResponse();
      return json({ ok: false, error: "no route" }, 404);
    },
  },
} as any;

export default ext;
