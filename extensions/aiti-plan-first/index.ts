/**
 * aiti-plan-first · 方案先行提醒扩展（server 端入口 + client 装配）
 *
 * 方案：docs/aiti-plan-first-plan.md（v3 推-听架构）
 *
 * 职责：
 *   - 监听 git-trace op 事件（services.trace.onOp 进程内，零扫描）累积本轮 buffer
 *   - onAgentSettled 轮次边界冲刷：跳号补洞 → evalTurn → 自家 SSE 广播
 *   - API：status / bind / unbind / mute / md-files / check(进入会话检查) / events(SSE 已退役→页面事件流)
 *   - 三档降级：onOp 在场=纯监听；仅 readOps=settle 增量拉；缺席=休眠（手动绑定仍可用）
 *
 * 红线：不读其他扩展 configDir（数据只走 git-trace services.trace 出口）；无轮询。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join as pathJoin, relative as pathRelative, resolve as pathResolve, sep } from "node:path";
import {
  evalTurn, loadPlans, savePlans, prunePlans, stateOf, normRoot, parseFmTags, applyFmTags,
  plansMtime,
  compileIgnoreLines, isIgnoredBy, type IgnorePattern, type IgnoreSet,
  BUFFER_CAP, type PlanState, type PlansFile, type EvalCfg, type OpRowLite, type PlanEvent,
} from "./plan-core.ts";

let configDir = "";
let hostCtx: any = null;
let cfg: EvalCfg = { bigFiles: 3, bigOps: 3, mdIgnores: [], suggestMd: true, leadRemind: true, staleRemind: true };
// UI 自动收起时长（ms 内部值：秒输入 → 解析缓存；0 = 不自动收起）。类型区分：suggest-md 常驻、stale 30s、lead 10s（客户端经 status 下发）
let autoCloseCfg = { suggestMs: 0, staleMs: 30000, leadMs: 10000 };
let plans: PlansFile = { version: 1, sessions: {} };
let plansMtimeCache = -2; // -2 = 未初始化（首次 stateOfSid 必重读盘）

/** 盘上 plans.json mtime 变了才重读（跨实例共享 configDir：另一实例 bind 后本进程惰性感知；无轮询） */
function refreshPlans(): void {
  const m = plansMtime(configDir);
  if (m !== plansMtimeCache) {
    plansMtimeCache = m;
    plans = loadPlans(configDir);
  }
}

/** 唯一写盘出口：savePlans + 同步 mtime 缓存（免得自己写完下一次读又重载） */
function persistPlans(): void {
  try {
    savePlans(configDir, plans);
    plansMtimeCache = plansMtime(configDir);
  } catch (e) { console.warn("[aiti-plan-first] savePlans 失败:", e); }
}

// ---------- git-trace 服务消费（§3.3：惰性解析 + 自愈重订） ----------

function traceService(): any | null {
  // 双轨（DI 方案 P1）：ctx.services 优先，__piWebExt.byId 穿透兜底（生产旧 core 过渡期）
  const viaSvc = hostCtx?.services?.get?.("aiti-git-trace.trace");
  if (viaSvc && typeof viaSvc.readOps === "function" && typeof viaSvc.onOp === "function") return viaSvc;
  const reg = (globalThis as any).__piWebExt;
  const loaded = reg && typeof reg.byId === "function" ? reg.byId("aiti-git-trace") : null;
  const s = loaded?.ext?.services?.trace;
  return s && typeof s.readOps === "function" && typeof s.onOp === "function" ? s : null;
}

/** aiti-doc-center services.docs 出口（搜索/词表/query）；缺席或版本过旧 → null（选择器降级纯清单） */
function docCenterService(): any | null {
  // 双轨：同上（aiti-doc-center.docs）
  const viaSvc = hostCtx?.services?.get?.("aiti-doc-center.docs");
  if (viaSvc && typeof viaSvc.query === "function") return viaSvc;
  const reg = (globalThis as any).__piWebExt;
  const loaded = reg && typeof reg.byId === "function" ? reg.byId("aiti-doc-center") : null;
  const s = loaded?.ext?.services?.docs;
  return s && typeof s.query === "function" ? s : null;
}

let boundService: any = null; // 当前订阅的 service 实例（身份比对，变更即重订）
let offOp: (() => void) | null = null;
const buffers = new Map<string, OpRowLite[]>(); // sessionId → 本轮事件 buffer
const bufferGap = new Set<string>(); // buffer 溢出标 gap → flush 强制对齐

function ensureListening(): void {
  const s = traceService();
  if (!s) return; // 休眠档（§3.3）；后续 settle 会重探
  if (offOp && s === boundService) return; // 已订阅同一实例
  try { offOp?.(); } catch { /* 旧 bus 已死 */ }
  boundService = s;
  offOp = s.onOp((evt: any) => {
    const sid = String(evt?.sessionId || "");
    const row = evt?.row;
    if (!sid || typeof row?.op !== "number") return;
    const arr = buffers.get(sid) ?? [];
    if (arr.length >= BUFFER_CAP) { bufferGap.add(sid); return; } // 溢出：弃尾部，flush 对齐（§3.4）
    arr.push(row);
    buffers.set(sid, arr);
  });
}

function drainBuffer(sessionId: string): OpRowLite[] {
  const arr = buffers.get(sessionId) ?? [];
  buffers.delete(sessionId);
  bufferGap.delete(sessionId);
  return arr;
}

/** buffer 冲刷 + 跳号补洞（§3.4；onSettle 与 /check 共用）。回填 = 台账全量（sinceOp=cursor）∪ buffer 按 op 去重合并——不能整体替换：台账只含已落盘的 op，溢出/未落盘的尾部事件（仍在 buffer）丢了会少计改动量（e2e-chain ③ 实证） */
function collectNewOps(sessionId: string, st: PlanState): OpRowLite[] {
  const gap = bufferGap.has(sessionId); // buffer 溢出过 → 强制对齐（§3.4）
  let newOps = drainBuffer(sessionId);
  if (newOps.length && boundService && (gap || (st.cursor > 0 && Number(newOps[0].op) !== st.cursor + 1))) {
    try {
      const full = boundService.readOps(sessionId, { sinceOp: st.cursor, limit: 1000 }) as OpRowLite[];
      if (full.length) {
        const seen = new Set(full.map((r: any) => Number(r.op)));
        const rest = newOps.filter((r) => !seen.has(Number(r.op)));
        newOps = [...full, ...rest].sort((a, b) => Number(a.op) - Number(b.op));
      }
    } catch { /* 补洞失败按 buffer 继续（§3.3 单次吞错） */ }
  }
  return newOps;
}

// ---------- 提醒决策 + 广播（§3.3 监听主循环） ----------

function stateOfSid(sessionId: string): PlanState {
  refreshPlans(); // 读路径统一入口：先对齐盘上最新（另一实例可能已 bind/unbind）
  return stateOf(plans, sessionId);
}

function onSettle(sessionId: string): void {
  ensureListening(); // 自愈：git-trace 后装/重装后重订
  const st = stateOfSid(sessionId);
  const newOps = collectNewOps(sessionId, st);
  if (!newOps.length) return; // 无事件 = 无变更（不拉台账核对）
  const hasClients = true; // 帧走页面事件流广播，页面按 sessionId 过滤
  const r = evalTurn({ sessionId, newOps, state: st, cfg, hasClients, planPhase: planPhaseOf(st) });
  r.next.touchedAt = Date.now();
  plans.sessions[sessionId] = r.next;
  persistPlans();
  if (r.event && hasClients) broadcast(enrich(r.event));
}

/** stale 事件附 planMissing（方案文件被删 → 客户端引导重绑）；followed 正常广播（客户端只刷新状态不弹窗） */
function enrich(ev: PlanEvent): PlanEvent {
  if (ev.kind === "stale") {
    return { ...ev, planMissing: !existsSync(ev.plan) } as any;
  }
  return ev;
}

// ---------- 进入会话检查（/check：会话切换/带 ?session= 加载时客户端触发） ----------

/**
 * 进入会话时一次性评估台账（用户切会话/带 ？session= 加载触发，非轮询非扫描），事件弹在触发的这个页面。
 * 覆盖「事件从未到达本进程」的会话：**终端桥接（PI_WEB_BRIDGE_AUTO，外部进程 globalThis 桥不到，
 * 事件级 settle 永远无评估——cursor 冻结而台账持续增长，2026-09 实证）**、页面不在场、扩展安装前历史。
 * 评估范围：未绑定 → 规则 A 绑定向导；已绑定 → 规则 B stale（终端桥接场景的唯一自动提醒通道；
 * followed 在 plan-core 内吞为 null，防客户端弹出「绑定态空壳」）。
 * 拉取策略：cursor=0 全量（原语义）；cursor>0 且 buffer 空 → readOps(sinceOp=cursor) 拉增量
 * （终端桥接修复：否则台账领先 cursor 的变更永远不可见）。游标/suggestedMd 照常推进防重弹。
 */
function checkOnEnter(sessionId: string): PlanEvent | null {
  ensureListening();
  const st = stateOfSid(sessionId);
  if (st.muted) return null;
  const svc = traceService();
  if (!svc) return null;
  let newOps = collectNewOps(sessionId, st); // buffer 里未冲刷的（可能 agent 正在跑）一并消费，防 settle 重复评估
  if (!newOps.length) {
    if (st.cursor > 0) {
      // 台账领先游标而事件不可达（终端桥接/长掉线）：一次性拉增量评估——用户动作触发，非轮询
      try { newOps = (svc.readOps(sessionId, { sinceOp: st.cursor }) as OpRowLite[]).filter(Boolean); } catch { return null; }
    } else {
      // 从未评估过：全量拉（cap 1000）评历史
      try { newOps = (svc.readOps(sessionId, { limit: 1000 }) as OpRowLite[]).filter(Boolean); } catch { return null; }
    }
  }
  if (!newOps.length) return null; // 台账不存在/无增量（新会话/外部 agent 无台账）→ 无事发生
  // planPhase：终态方案（已实施/已过时）→ 已绑定也不弹 stale（与轮次评估同语义）
  const r = evalTurn({ sessionId, newOps, state: st, cfg, mode: "enter", planPhase: planPhaseOf(st) });
  r.next.touchedAt = Date.now();
  plans.sessions[sessionId] = r.next;
  persistPlans();
  return r.event ? enrich(r.event) : null; // 不广播：弹在触发检查的页面（多窗口各自进入时各自触发）；stale 附 planMissing
}

// ---------- remind 推送：aiti-event-bus 总线（全页 1 条连接，连接池保护） ----------
// 推送走 pi-web 页面事件流（globalThis.__piPageEvents，core 提供）。
// 总线缺席时静默降级：无实时推送，状态由 visibility/手动刷新兜底。

function broadcast(event: PlanEvent): void {
  (globalThis as any).__piPageEvents?.publish("pf:remind", event);
}

// ---------- md 候选清单（§6：session 台账绿标段 + listMd / fs walk 兜底；ignore 引擎见 plan-core） ----------

const FS_WALK_SKIP = new Set([".git", "node_modules", "dist", ".next", ".aiti-trace", ".svn"]);

/** 走查清单：遵守逐目录 .gitignore/.aitiignore（+ 根 .git/info/exclude），深度/数量限额 */
function fsWalkMd(root: string, capDirs = 2000): string[] {
  const out: string[] = [];
  let visited = 0;
  const sets: IgnoreSet[] = [];
  const readSet = (dir: string): IgnoreSet | null => {
    let text = "";
    for (const f of [".gitignore", ".aitiignore"]) {
      try { text += "\n" + readFileSync(pathJoin(dir, f), "utf8"); } catch { /* 无此文件 */ }
    }
    if (dir === root) {
      try { text += "\n" + readFileSync(pathJoin(root, ".git", "info", "exclude"), "utf8"); } catch {}
    }
    if (!text.trim()) return null;
    const relBase = pathRelative(root, dir).split(sep).join("/");
    return { base: relBase === "." ? "" : relBase + "/", patterns: compileIgnoreLines(text) };
  };
  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || visited > capDirs || out.length >= 200) return;
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    const set = readSet(dir);
    if (set) sets.push(set);
    for (const name of entries) {
      if (++visited > capDirs || out.length >= 200) return;
      if (FS_WALK_SKIP.has(name) || name.startsWith(".")) continue;
      const full = pathJoin(dir, name);
      const rel = pathRelative(root, full).split(sep).join("/");
      if (isIgnoredBy(rel, sets)) continue; // .gitignore / .aitiignore 命中（目录命中则整枝剪除）
      let st: any;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full, depth + 1);
      else if (/\.md$/i.test(name)) out.push(full);
    }
    if (set) sets.pop();
  };
  walk(root, 0);
  return out;
}

/** 仓根 .aitiignore（每次现读；选择器各段通用过滤） */
function aitiIgnoreOf(root: string): IgnorePattern[] {
  let text = "";
  try { text = readFileSync(pathJoin(root, ".aitiignore"), "utf8"); } catch { /* 无此文件 */ }
  return compileIgnoreLines(text);
}

async function mdCandidates(
  sessionId: string,
  cwd: string,
  opts: { q?: string; tag?: string } = {},
): { abs: string; rel: string; session?: boolean; tags?: string[] }[] {
  const q = String(opts?.q ?? "").trim().toLowerCase();
  const tag = String(opts?.tag ?? "").trim();
  const out: { abs: string; rel: string; session?: boolean; tags?: string[] }[] = [];
  const seen = new Set<string>();
  // 显示名一律相对 CWD（含 cwd 外的 ../ 形式）；无 cwd 时退回绝对路径
  const displayRel = (abs: string): string => {
    if (!cwd) return abs;
    const r = pathRelative(cwd, abs).split(sep).join("/");
    return r || pathBasename(abs);
  };
  const push = (abs: string, extra?: { session?: boolean; tags?: string[] }) => {
    abs = pathResolve(abs);
    if (seen.has(abs) || out.length >= 300) return; // 300 = 文件名组(≤200) + 全文组(≤100) 合计上限
    seen.add(abs);
    const rec: { abs: string; rel: string; session?: boolean; tags?: string[] } = { abs, rel: displayRel(abs) };
    if (extra?.session) rec.session = true;
    if (extra?.tags?.length) rec.tags = extra.tags;
    out.push(rec);
  };
  // ① 本 session 修改过的 md（git-trace 台账，§3.3 出口；按修改序最新在前）→ 绿色标记
  //    （事实标记不受 md 忽略名单约束；但遵守仓根 .aitiignore——用户明确不看的文件不进清单）
  //    搜索时同样保留（命中 q 即收），仍是「本轮改动」的可靠候选。
  const svc0 = traceService();
  if (svc0) {
    try {
      const ops = svc0.readOps(sessionId, { limit: 1000 }) as OpRowLite[];
      const latest = new Map<string, { op: number; root: string; rel: string }>();
      for (const row of ops) {
        const opNo = Number(row?.op) || 0;
        for (const st of row.stores ?? []) {
          const root = normRoot(st.root);
          for (const p of st.paths ?? []) {
            const rel0 = String(p).replace(/^\.\//, "");
            if (!/\.md$/i.test(rel0)) continue;
            const abs = pathResolve(root, rel0);
            const prev = latest.get(abs);
            if (!prev || opNo > prev.op) latest.set(abs, { op: opNo, root, rel: rel0 });
          }
        }
      }
      const aitiCache = new Map<string, IgnorePattern[]>();
      const ordered = [...latest.entries()].sort((a, b) => b[1].op - a[1].op);
      for (const [abs, info] of ordered) {
        let pat = aitiCache.get(info.root);
        if (!pat) { pat = aitiIgnoreOf(info.root); aitiCache.set(info.root, pat); }
        if (pat.length && isIgnoredBy(info.rel, [{ base: "", patterns: pat }])) continue;
        if (q && !info.rel.toLowerCase().includes(q)) continue; // 搜索词过滤（仅文件名路径）；tag 不过滤会话文件
        push(abs, { session: true });
      }
    } catch { /* 出口错误静默（§3.3）：选择器退化为纯清单 */ }
  }

  // ② 搜索模式：文件名/路径优先组（本地清单，先于全文）→ aiti-doc-center FTS 全文补充组。
  //    文件名优先的依据：doc-center FTS/bigrams 索引只含 标题+标题列表+正文（relpath 不索引，
  //    fts path 列 UNINDEXED），且 bm25 融合排序不优先文件名——搜文件名关键词（尤其 2 字中文
  //    词走 doc_bigrams）时正文命中会淹没/漏掉精确文件名命中（2026-09 实证）。
  if (q || tag) {
    const doc = docCenterService();
    // tag 交集集合（doc 缺席 → null = 文件名组不过滤）：文件名组给的 abs 须是 tag 命中文档，
    // 避免选了 tag 云又列出无关文件。
    let tagAbs: Set<string> | null = null;
    if (tag && doc) {
      try {
        const items = doc.query({ tag, under: cwd || undefined, limit: 200 }) as any[];
        tagAbs = new Set<string>();
        for (const it of items ?? []) {
          const rel0 = String(it?.relpath || "").replace(/^\.\//, "");
          if (!/\.md$/i.test(rel0)) continue;
          tagAbs.add(pathResolve(String(it?.root || ""), rel0));
        }
      } catch { tagAbs = null; }
    }
    // 文件名组：tier0 = basename 全部词命中（最优先）> tier1 = 仅 relpath 全部词命中；
    // 组内保持清单顺序。来源 = git-trace listMd（tracked+untracked 全量，gitignore 已生效）。
    if (q) {
      const words = q.split(/\s+/).map((w) => w.toLowerCase()).filter(Boolean);
      const allHit = (s: string) => words.every((w) => s.includes(w));
      const mdList = await (async () => {
        const svc = traceService();
        if (!svc?.listMd) return null;
        try {
          const rows = await svc.listMd(sessionId) as { path: string; root: string }[];
          return Array.isArray(rows) ? rows : null;
        } catch { return null; }
      })();
      if (mdList) {
        for (let tier = 0; tier < 2; tier++) {
          for (const m of mdList) {
            const relL = String(m.path).toLowerCase().replace(/\\/g, "/").replace(/^\.\//, "");
            const nameL = relL.split("/").pop() || relL;
            const hit = tier === 0 ? allHit(nameL) : !allHit(nameL) && allHit(relL);
            if (!hit) continue;
            const abs = pathResolve(String(m.root || ""), String(m.path));
            if (tagAbs && !tagAbs.has(abs)) continue;
            push(abs);
            if (out.length >= 200) break; // 命中爆炸时保前 200（给全文组留容量）
          }
          if (out.length >= 200) break;
        }
      } else if (cwd && !tagAbs) {
        // listMd 缺席 → fs walk 兜底（basename 匹配；tag 非空且无 doc 交集可验时跳过）
        for (const abs of fsWalkMd(cwd)) if (allHit(pathBasename(abs).toLowerCase())) push(abs);
      }
    }
    // 全文组：doc-center FTS（q+tag 语义；push 的 seen 去重保证与文件名组不重复），排在文件名组之后
    let fromDoc = 0;
    if (doc) {
      try {
        const items = doc.query({ q: q || undefined, tag: tag || undefined, under: cwd || undefined, limit: 200 }) as any[];
        for (const it of items ?? []) {
          const rel0 = String(it?.relpath || "").replace(/^\.\//, "");
          if (!/\.md$/i.test(rel0)) continue;
          const abs = pathResolve(String(it?.root || ""), rel0);
          const tags = (it?.tags ?? []).map((t2: any) => String(t2?.key || t2?.display || "").replace(/^#/, "")).filter(Boolean);
          push(abs, { tags: tags.slice(0, 8) });
          fromDoc++;
        }
      } catch { /* doc-center 查询失败 → 降级 */ }
    }
    if (!fromDoc && q) {
      // 本地兜底：doc 缺席/失败（文件名组也未覆盖到的极端形态）再匹配一轮
      const svc = traceService();
      let fromList = 0;
      if (svc?.listMd) {
        try {
          for (const m of await svc.listMd(sessionId) as { path: string; root: string }[]) {
            if (String(m.path).toLowerCase().includes(q)) { push(pathJoin(m.root, m.path)); fromList++; }
          }
        } catch { /* 出口错误静默 */ }
      }
      if (!fromList && cwd) {
        for (const abs of fsWalkMd(cwd)) if (pathBasename(abs).toLowerCase().includes(q)) push(abs);
      }
    }
    return out;
  }

  // ③ 无搜索：仓内其余 md（listMd v2：tracked+untracked 全列，.gitignore/.aitiignore 在 git-trace 侧生效）；为空或缺席 → fs walk 兜底（自带简化 ignore 引擎）
  const svc = traceService();
  let fromList = 0;
  if (svc?.listMd) {
    try {
      for (const m of svc.listMd(sessionId) as { path: string; root: string }[]) {
        const before = out.length;
        push(pathJoin(m.root, m.path));
        if (out.length > before) fromList++;
      }
    } catch { /* 出口错误静默（§3.3） */ }
  }
  if (!fromList && cwd) for (const abs of fsWalkMd(cwd)) push(abs);
  return out;
}

function pathIsAbs(p: string): boolean { return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p); }
function pathBasename(p: string): string { const n = p.split(/[\\/]/); return n[n.length - 1] || p; }

/** 会话 cwd 解析：客户端传参优先；缺省时 core.listSessions 自取（toolbar 槽拿不到 currentSession） */
async function resolveCwd(sessionId: string, clientCwd: string): Promise<string> {
  if (clientCwd) return clientCwd;
  if (!sessionId) return "";
  try {
    const sessions = (await hostCtx?.core?.listSessions?.()) as { id?: string; cwd?: string }[] | undefined;
    const hit = Array.isArray(sessions) ? sessions.find((s) => String(s?.id) === sessionId) : null;
    if (hit?.cwd) return String(hit.cwd);
  } catch { /* 会话清单不可用 → 客户端兑底 */ }
  return "";
}

// ---------- API 路由（§6 路由表） ----------

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function readBody(req: Request): Promise<any> {
  try { return await req.json(); } catch { return {}; }
}

// [P1-5] 状态 tag 自检：方案/* 生命周期 tag 应有且仅有一个（约定式规范的机器可读校验）
const planStatusCheck = (tags: string[]) => {
  const st = (tags ?? []).filter((t) => t.startsWith("方案/"));
  return { ok: st.length === 1, phase: st.length === 1 ? st[0] : null, all: st };
};

// ---------- 绑定方案状态 tag 读（终态抑制 stale；mtime 缓存防 settle/check 高频读盘） ----------

const planTagCache = new Map<string, { mtime: number; tags: string[] }>();

/** 读 md front-matter tags（mtime 感知缓存；缺文件/读失败 → []） */
function readPlanTags(abs: string): string[] {
  if (!abs) return [];
  try {
    const m = statSync(abs).mtimeMs;
    const hit = planTagCache.get(abs);
    if (hit && hit.mtime === m) return hit.tags;
    let tags: string[] = [];
    try { tags = parseFmTags(readFileSync(abs, "utf8")); } catch { /* 读失败 → 空 */ }
    if (planTagCache.size >= 200) planTagCache.clear(); // 无界保护（绑定集合小，重置无害）
    planTagCache.set(abs, { mtime: m, tags });
    return tags;
  } catch {
    planTagCache.delete(abs); // 文件不存在（planMissing）→ 清缓存
    return [];
  }
}

/** 绑定方案的状态 tag phase（恰好一个 方案/* 时给出；无绑定/缺文件/多状态违约 → null） */
function planPhaseOf(st: PlanState): string | null {
  return st.plan ? planStatusCheck(readPlanTags(st.plan)).phase : null;
}

async function handleApi(req: Request, ctx: { path: string[]; searchParams: URLSearchParams }): Promise<Response> {
  const p = ctx.path || [];
  const q = ctx.searchParams || new URLSearchParams();
  try {
    if (p[0] === "status" && req.method === "GET") {
      const sid = String(q.get("session") || "");
      const st = stateOfSid(sid);
      const planTags = readPlanTags(st.plan ?? "");
      // 未绑定时附最近绑定向导候选（体验优化）：suggest-md 事件只在触发瞬间弹一次，
      // 之后用户打开下拉/进入会话也能看到候选并一键绑定；无候选时客户端主按钮走「更多文档」选择器。
      const last = Array.isArray((st as any).lastSuggest) ? (st as any).lastSuggest : [];
      const candidates = !st.plan
        ? last.filter((p: any) => p?.abs && existsSync(p.abs)).slice(0, 5)
            .map((p: any) => ({ abs: String(p.abs), rel: String(p.rel || p.abs) }))
        : [];
      return json({
        ok: true, bound: !!st.plan, plan: st.plan, planRel: st.planRel, muted: st.muted,
        planMissing: st.plan ? !existsSync(st.plan) : false, planTags, statusCheck: planStatusCheck(planTags),
        candidates,
        bigFiles: cfg.bigFiles, bigOps: cfg.bigOps, traceOk: !!traceService(),
        autoClose: autoCloseCfg,
      });
    }
    if (p[0] === "bind" && req.method === "POST") {
      const body = await readBody(req);
      const sid = String(body?.session || "");
      const raw = String(body?.path || "");
      const cwd = String(body?.cwd || "");
      if (!sid || !raw) return json({ ok: false, error: "缺少 session/path" }, 400);
      const abs = pathResolve(pathIsAbs(raw) ? raw : pathJoin(cwd || ".", raw));
      // planRel：一律相对 CWD（含 cwd 外的 ../ 形式，与选择器显示一致；AI 按会话 cwd 可解析）
      let planRel = abs;
      if (cwd) {
        const r = pathRelative(cwd, abs).split(sep).join("/");
        if (r) planRel = r;
      }
      // repoRoot：git-trace 会话识别仓中最长前缀包含 abs 的（多仓归一化，§9）
      let repoRoot: string | null = null;
      try {
        for (const { root } of (traceService()?.sessionStores?.(sid) ?? []) as { root: string }[]) {
          if ((abs + sep).startsWith(root + sep) && (!repoRoot || root.length > repoRoot.length)) repoRoot = root;
        }
      } catch { /* 出口缺席 → repoRoot null（仅影响 stale 归一化展示） */ }
      plans.sessions[sid] = { ...stateOfSid(sid), plan: abs, planRel, repoRoot, boundAt: Date.now(), muted: false, touchedAt: Date.now() };
      persistPlans();
      return json({ ok: true, plan: abs, planRel });
    }
    if (p[0] === "unbind" && req.method === "POST") {
      const body = await readBody(req);
      const sid = String(body?.session || "");
      if (!sid) return json({ ok: false, error: "缺少 session" }, 400);
      plans.sessions[sid] = { ...stateOfSid(sid), plan: null, planRel: null, repoRoot: null, boundAt: 0, touchedAt: Date.now() };
      persistPlans();
      return json({ ok: true });
    }
    if (p[0] === "check" && req.method === "POST") {
      const body = await readBody(req);
      const sid = String(body?.session || "");
      if (!sid) return json({ ok: false, error: "缺少 session" }, 400);
      const event = checkOnEnter(sid);
      return json({ ok: true, popped: !!event, event });
    }
    if (p[0] === "mute" && req.method === "POST") {
      const body = await readBody(req);
      const sid = String(body?.session || "");
      if (!sid) return json({ ok: false, error: "缺少 session" }, 400);
      plans.sessions[sid] = { ...stateOfSid(sid), muted: body?.muted !== false, touchedAt: Date.now() };
      persistPlans();
      return json({ ok: true, muted: plans.sessions[sid].muted });
    }
    if (p[0] === "tag-vocab" && req.method === "GET") {
      // 统一词表（aiti-doc-center services.docs → All Sessions 词表优先）；缺席降级空串
      try {
        // 双轨（DI 方案 P1）：ctx.services 优先，byId 穿透兜底
        const s = hostCtx?.services?.get?.("aiti-doc-center.docs")
          ?? (() => { const reg = (globalThis as any).__piWebExt; const loaded = reg && typeof reg.byId === "function" ? reg.byId("aiti-doc-center") : null; return loaded?.ext?.services?.docs ?? null; })();
        const list = s && typeof s.tagsAll === "function" ? s.tagsAll() : [];
        const vocab = list.slice(0, 30).map((x: any) => x.display).join("、");
        return json({ ok: true, tags: vocab });
      } catch { return json({ ok: true, tags: "" }); }
    }
    if (p[0] === "bindings" && req.method === "GET") {
      refreshPlans(); // 跨实例：另一实例可能刚 bind
      // 全部绑定会话（行内 meta 图标/tags 等消费方用；键=sessionId）
      // tags：绑定的方案文档 front-matter 一次批量读取（会话量少、/bindings 低频，直接读）；
      //   缺文件/解析失败 → 空数组，行内只显 📋。
      const out: Record<string, { planRel: string | null; tags?: string[] }> = {};
      for (const [sid, st] of Object.entries(plans.sessions)) {
        if (!st.plan) continue;
        out[sid] = { planRel: st.planRel ?? "", tags: readPlanTags(st.plan) };
      }
      return json({ ok: true, bindings: out });
    }


    if (p[0] === "doctags" && req.method === "GET") {
      const sid = String(q.get("session") || "");
      const st = stateOfSid(sid);
      const tags = readPlanTags(st.plan ?? "");
      return json({ ok: true, tags, plan: st.plan, planRel: st.planRel, bound: !!st.plan, statusCheck: planStatusCheck(tags) });
    }
    if (p[0] === "doctags" && req.method === "POST") {
      const body = await readBody(req);
      const sid = String(body?.session || "");
      const st = stateOfSid(sid);
      if (!st.plan) return json({ ok: false, error: "未绑定方案" }, 400);
      const add = Array.isArray(body?.add) ? body.add.map((x: unknown) => String(x).trim()).filter(Boolean) : [];
      const remove = Array.isArray(body?.remove) ? body.remove.map((x: unknown) => String(x).trim()).filter(Boolean) : [];
      let text = "";
      try { text = existsSync(st.plan) ? readFileSync(st.plan, "utf8") : ""; } catch { text = ""; }
      const r = applyFmTags(text, add, remove);
      mkdirSync(pathResolve(st.plan, ".."), { recursive: true });
      writeFileSync(st.plan, r.text, "utf8");
      planTagCache.delete(st.plan); // 写后失效缓存（同 ms mtime 也不怕）
      return json({ ok: true, tags: r.tags, statusCheck: planStatusCheck(r.tags) });
    }
    if (p[0] === "md-files" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const sid = String(body.session || "");
      const cwd = await resolveCwd(sid, String(body.cwd || ""));
      const q = String(body.q || "");
      const tag = String(body.tag || "");
      return json({ ok: true, cwd, files: await mdCandidates(sid, cwd, { q, tag }) });
    }
    if (p[0] === "md-tags" && req.method === "GET") {
      // 供 md 选择器 tag 过滤：aiti-doc-center 词表（tag 云）；缺席/失败降级空数组
      try {
        const doc = docCenterService();
        const list = doc && typeof doc.tagsAll === "function" ? doc.tagsAll() : [];
        const tags = list.slice(0, 40).map((x: any) => ({ key: x.key, display: x.display, count: x.count }));
        return json({ ok: true, tags });
      } catch { return json({ ok: true, tags: [] }); }
    }
    return json({ ok: false, error: "not found" }, 404);
  } catch (e: any) {
    return json({ ok: false, error: String(e?.message || e) }, 400);
  }
}

// 命名导出：node:test 集成测试直调路由（含 SSE 流读取；§10 e2e-chain）
export { handleApi };

// ---------- 扩展定义 ----------

let extDir = "";

// 命名为模块常量：server.startup 经 ext.services.plans 接入 ctx.services 出口（DI 方案 P1）
const ext = {
  id: "aiti-plan-first",
  name: "方案先行",
  version: "0.3.2",
  ai: {
    manage: true,
    intro: "方案先行：结合 AI 变更追踪，md 变更时提醒绑定 session 方案文档；大改动方案未跟时提醒更新，可一键插入「更新方案文档：@file」。",
  },
  icon: "icon.svg",
  client: "dist/aiti-plan-first-client.mjs",

  features: [
    { id: "plan.toolbar", label: "工具条按钮", type: "boolean", default: true, description: "工具条显示「方案先行」按钮（切换后刷新页面生效）" },
    { id: "plan.suggestMd", label: "md 变更绑定向导", type: "boolean", default: true, description: "未绑定方案时，本轮变更出现 md 文件 → 弹下拉询问是否为 session 方案" },
    { id: "plan.staleRemind", label: "大改未跟提醒", type: "boolean", default: true, description: "已绑定方案后，单轮改动量超阈值且方案未更新 → 弹下拉提醒" },
    { id: "plan.bigFiles", label: "文件数阈值", type: "string", default: "3", placeholder: "3", description: "单轮变更文件数达到该值视为「改动很多」" },
    { id: "plan.bigOps", label: "操作数阈值", type: "string", default: "3", placeholder: "3", description: "单轮操作（op）数达到该值视为「改动很多」" },
    { id: "plan.leadRemind", label: "领先提醒", type: "boolean", default: true, description: "未绑定方案时，一旦开始改非 md 文件即弹「先做方案」（30 分钟冷却）" },
    { id: "plan.mdIgnores", label: "追加 md 忽略", type: "string", default: "", placeholder: "glob，一行一条", description: "在内置忽略（README*/CHANGELOG*/LICENSE*/node_modules 等）之上追加" },
    { id: "plan.autoCloseSuggestSec", label: "绑定向导自动收起(秒)", type: "string", default: "0", placeholder: "0", description: "md 变更绑定向导（疑似方案）多久自动收起；0=常驻，用户操作后才收起" },
    { id: "plan.autoCloseStaleSec", label: "失联提醒自动收起(秒)", type: "string", default: "30", placeholder: "30", description: "大改未跟提醒多久自动收起；0=常驻" },
    { id: "plan.autoCloseLeadSec", label: "领先提醒自动收起(秒)", type: "string", default: "10", placeholder: "10", description: "领先提醒多久自动收起；0=常驻" },
  ],

  ui: {
    toolbar: [{ id: "aiti-plan-first-button", label: "方案先行", title: "方案先行：AI 开发先方案后动手（结合变更追踪提醒）", icon: "icons/clipboard-list.svg" }],
    sessionRowLeading: [{ id: "aiti-plan-first-leading", label: "方案绑定标" }],
    dialogs: [{ id: "aiti-plan-first-dropdown", label: "方案先行下拉" }],
    i18n: {
      zh: {
        "pf.title": "方案先行",
        "pf.unbound": "本 session 未绑定方案",
        "pf.bound": "方案：{plan}",
        "pf.suggestTitle": "发现疑似方案文档",
        "pf.bindHint": "绑定后，代码大改而方案没跟时我会提醒你更新",
        "pf.bind": "设为方案",
        "pf.browse": "浏览全部 md…",
        "pf.later": "暂不",
        "pf.stale": "本轮改动 {n} 个文件，方案未更新",
        "pf.staleTitle": "方案落后于代码改动",
        "pf.staleHow": "点下方按钮把更新提示词填入输入框（含 @{plan}），回车发送即可",
        "pf.missingTitle": "方案文件已消失",
        "pf.rebindBtn": "重新绑定",
        "pf.update": "📝 让 AI 更新方案文档",
        "pf.addTags": "🏷 添加 tags",
        "pf.got": "我知道了",
        "pf.mute": "不再提醒",
        "pf.slogan": "AI 开发，先方案后动手",
        "pf.tagHint": "AI 写方案时请在文档头部 front-matter 维护 tags（可自荐新标签）",
        "pf.updateTip": "插入「更新方案文档」提示词（含 front-matter tags 与状态 tag 约定）",
        "pf.tagAdd": "回车添加（写回 front-matter，可自荐新标签）",
        "pf.tagRemove": "移除（写回 front-matter）",
        "pf.leadTitle": "还没有方案，代码已经开改",
        "pf.leadHow": "点下方按钮把提示词填入输入框，回车发送，AI 就会先出方案再动手",
        "pf.leadPrompt": "📝 插入方案先行提示词",
        "pf.sloganTip": "点击插入方案先行动提示词（可点旁侧铅笔在 Prompt 收藏中修改）",
        "pf.editPrompt": "编辑提示词（Prompt 收藏）",
        "pf.rebind": "绑定的方案文件已不存在，请重新绑定",
        "pf.boundHint": "✓ 方案已绑定：大改而方案未跟时会提醒你",
        "pf.boundDoneHint": "✓ 方案已完成（{phase}）：不再提醒跟催更新",
        "pf.unboundTitle": "还没有方案",
        "pf.unboundHint": "可点下方行动条让 AI 先写方案，或从已有 md 里选一个绑定",
        "pf.sloganAction": "点击填入提示词 →",
        "pf.traceOff": "需 aiti-git-trace 提供变更感知（手动绑定仍可用）",
        "pf.muted": "已静音（点工具条按钮恢复）",
        "pf.thisTurn": "本轮",
        "pf.pick": "选择方案文档",
        "pf.searchPh": "搜索文件名/内容（doc-center 全文）…",
        "pf.searching": "搜索中…",
        "pf.noMatch": "未找到匹配文件",
        "pf.back": "返回",
        "pf.unbind": "解绑",
        "pf.sessionTouched": "本 session 修改过",
        "pf.choose": "选择方案",
        "pf.moreDocs": "更多文档…",
        "pf.candidatesCap": "识别到本轮变更文档（点击绑定）：",
        "pf.bindAction": "绑定文档…",
        "pf.newTitle": "新建会话 · 可先选方案",
        "pf.newHint": "可以先选方案文档（会记为待绑定）；发首条消息创建会话后自动绑定，无需再操作。",
        "pf.newPick": "选择方案文档…",
        "pf.pendingChip": "待绑定",
        "pf.newSessionChip": "新建会话",
        "pf.pendingTitle": "已选方案（待绑定）：{plan}",
        "pf.pendingChange": "更换",
        "pf.pendingClear": "取消",
        "pf.pendingAuto": "会话创建后自动绑定为本会话方案。",
        "pf.openFileTip": "点击打开文件",
        "pf.atTip": "插入 @文档路径 到输入框",
      },
      en: {
        "pf.title": "Plan first",
        "pf.unbound": "No plan bound for this session",
        "pf.bound": "Plan: {plan}",
        "pf.suggestTitle": "Found a likely plan doc",
        "pf.bindHint": "Once bound, I'll remind you to update the plan when big changes leave it behind",
        "pf.bind": "Set as plan",
        "pf.browse": "Browse all md…",
        "pf.later": "Not now",
        "pf.stale": "{n} files changed this turn, plan not updated",
        "pf.staleTitle": "Plan is falling behind the code",
        "pf.staleHow": "Click below to fill the update prompt (with @{plan}) into the input, then press Enter",
        "pf.missingTitle": "Plan file is gone",
        "pf.rebindBtn": "Rebind",
        "pf.update": "📝 Let AI update the plan doc",
        "pf.addTags": "🏷 Add tags",
        "pf.got": "Got it",
        "pf.mute": "Stop reminding",
        "pf.slogan": "Plan first, then code.",
        "pf.tagHint": "Ask the AI to maintain front-matter tags in the doc header (new tags welcome)",
        "pf.updateTip": "Insert the update-plan prompt (front-matter tags + status tag conventions)",
        "pf.tagAdd": "Press Enter to add (written back to front-matter; new tags welcome)",
        "pf.tagRemove": "Remove (written back to front-matter)",
        "pf.leadTitle": "No plan yet — code changes already started",
        "pf.leadHow": "Click the button below to fill the plan-first prompt into the input, then press Enter",
        "pf.leadPrompt": "📝 Insert plan-first prompt",
        "pf.sloganTip": "Click to insert the plan-first prompt (pencil edits it in the Prompt library)",
        "pf.editPrompt": "Edit prompt (in Prompt library)",
        "pf.rebind": "The bound plan file no longer exists — please rebind",
        "pf.boundHint": "✓ Plan bound — I'll remind you when big changes leave it behind",
        "pf.boundDoneHint": "✓ Plan finished ({phase}) — stale reminders are off",
        "pf.unboundTitle": "No plan yet",
        "pf.unboundHint": "Click the action bar below to have the AI draft one, or bind an existing md",
        "pf.sloganAction": "Click to fill prompt →",
        "pf.traceOff": "Needs aiti-git-trace services.trace for change awareness (manual bind still works)",
        "pf.muted": "Reminders muted (click toolbar to re-enable)",
        "pf.thisTurn": "this turn",
        "pf.pick": "Choose plan doc",
        "pf.searchPh": "Search by name/content (doc-center FTS)…",
        "pf.searching": "Searching…",
        "pf.noMatch": "No matching files",
        "pf.back": "Back",
        "pf.unbind": "Unbind",
        "pf.sessionTouched": "Modified in this session",
        "pf.choose": "Choose plan",
        "pf.moreDocs": "More docs…",
        "pf.candidatesCap": "Docs changed this session (click to bind):",
        "pf.bindAction": "Bind a doc…",
        "pf.newTitle": "New session · pick a plan first",
        "pf.newHint": "Pick a plan doc now (marked as pending); it auto-binds to the session once the first message creates it.",
        "pf.newPick": "Choose plan doc…",
        "pf.pendingChip": "Pending",
        "pf.newSessionChip": "New session",
        "pf.pendingTitle": "Plan picked (pending binding): {plan}",
        "pf.pendingChange": "Change",
        "pf.pendingClear": "Cancel",
        "pf.pendingAuto": "Auto-binds as this session's plan once created.",
        "pf.openFileTip": "Click to open the file",
        "pf.atTip": "Insert @doc path into the input",
      },
    },
  },

  // 跨扩展服务出口（additive v2.3，方案 aiti-doc-center-plan §9.4）：导出「会话→方案文档」绑定映射
  services: {
    get plans() {
      return {
        /** 遍历内存 plans state 的绑定值；只读零成本，不改状态文件 */
        planDocs(): { sessionId: string; path: string; planRel: string | null; repoRoot: string | null; boundAt: number }[] {
          const out: { sessionId: string; path: string; planRel: string | null; repoRoot: string | null; boundAt: number }[] = [];
          try {
            for (const [sid, st] of Object.entries((plans as any)?.sessions ?? {}) as [string, any][]) {
              if (st?.plan) out.push({ sessionId: sid, path: String(st.plan), planRel: st.planRel ?? null, repoRoot: st.repoRoot ?? null, boundAt: Number(st.boundAt) || 0 });
            }
          } catch { /* 状态损坏容忍：返回空 */ }
          return out;
        },
      };
    },
  },

  server: {
    async startup(ctx: any) {
      hostCtx = ctx;
      configDir = ctx.configDir || "";
      extDir = ctx.dir || "";
      // 跨扩展服务出口（DI 方案 P1）：ctx.services 通道（plans 方法闭包读内存状态，
      // 只读零成本）；旧通道（__piWebExt.byId 穿透）双轨保留至消费方迁完。
      ctx.services?.provide?.("aiti-plan-first.plans", ext.services.plans);
      // §3.3 自愈重订升格：trace 服务上线（提供方 reload/后装）即重订，不再等下一轮 settle 探测
      hostCtx?.services?.onChange?.((key: string, phase: string) => {
        if (key === "aiti-git-trace.trace" && phase === "up") { try { ensureListening(); } catch {} }
      });
      // features → cfg（阈值/开关；extman 切换后 reload 生效——git-trace 同款约定）
      try {
        const feats = JSON.parse(readFileSync(pathDirname(configDir) + "/features.json", "utf8"));
        const mine = feats["aiti-plan-first"] ?? {};
        cfg = {
          bigFiles: parseInt(String(mine["plan.bigFiles"] ?? "3"), 10) || 3,
          bigOps: parseInt(String(mine["plan.bigOps"] ?? "3"), 10) || 3,
          mdIgnores: String(mine["plan.mdIgnores"] ?? "").split("\n").map((s: string) => s.trim()).filter(Boolean),
          suggestMd: mine["plan.suggestMd"] !== false,
          leadRemind: mine["plan.leadRemind"] !== false,
          staleRemind: mine["plan.staleRemind"] !== false,
        };
        const parseSec = (v: unknown, d: number): number => {
          const n = parseInt(String(v ?? ""), 10);
          if (!Number.isFinite(n)) return d * 1000;
          return Math.min(Math.max(n, 0), 600) * 1000; // 0=常驻；上限 10 分钟（600s）防误填
        };
        autoCloseCfg = {
          suggestMs: parseSec(mine["plan.autoCloseSuggestSec"], 0),
          staleMs: parseSec(mine["plan.autoCloseStaleSec"], 30),
          leadMs: parseSec(mine["plan.autoCloseLeadSec"], 10),
        };
      } catch { /* features.json 缺失/坏行：保持缺省 */ }
      plans = prunePlans(loadPlans(configDir));
      try { savePlans(configDir, plans); plansMtimeCache = plansMtime(configDir); } catch { /* 只读盘等场景容错 */ }
      ensureListening();
      // 会话标注（§6 列表图标）：绑定方案的会话行打 planFirst 标——宿主合并进
      // /api/sessions 行（左侧列表/下游列表消费；schema 归本扩展所有）
      try {
        ctx.sessionAnnotations?.register?.({
          annotate: async (rows: Array<{ id: string; cwd?: string }>) => {
            refreshPlans(); // 标注读路径：对齐另一实例的 bind/unbind
            const out: Record<string, Record<string, unknown>> = {};
            for (const r of rows) {
              const st = plans.sessions[String(r?.id || "")];
              if (st?.plan) out[String(r.id)] = { planFirst: true, planRel: st.planRel ?? "" };
            }
            return out;
          },
        });
      } catch { /* 标注注册失败不影响主流程 */ }
      console.log("[aiti-plan-first] 就绪 · configDir=" + configDir + " · traceOk=" + !!traceService());
    },

    shutdown() {
      try { offOp?.(); } catch {}
      offOp = null;
      boundService = null;
      buffers.clear();
      bufferGap.clear();
    },

    api(req: Request, ctx: any) {
      return handleApi(req, { path: ctx.path, searchParams: ctx.searchParams });
    },

    agent: {
      onAgentSettled(info: { sessionId: string }) {
        const sid = String(info?.sessionId || "");
        if (sid) onSettle(sid);
      },
      onAgentSessionEnd(info: { sessionId: string }) {
        // shutdown/fork/idle GC 都会触发（core 契约）：仅丢内存 buffer（幂等）；
        // plans.json 状态不删（跨 idle GC 存活，30 天修剪兜底）
        const sid = String(info?.sessionId || "");
        if (sid) drainBuffer(sid);
      },
    },
  },
} as any;

export default ext;

function pathDirname(p: string): string {
  const i = p.lastIndexOf(sep);
  return i > 0 ? p.slice(0, i) : "/";
}
