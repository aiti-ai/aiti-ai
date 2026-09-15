/**
 * Live handle store — server-side registry of SessionHandles created through
 * non-local providers (attach/spawn/extension backends).
 *
 * Local sessions stay in rpc-manager's __piSessions map (AgentSessionWrapper
 * world). Provider handles live here so API routes can resolve them by id,
 * exactly like getRpcSession does for local ones.
 *
 * Stored on globalThis for the same reason as __piSessions: Next.js dev HMR
 * recreates modules; the process-global survives.
 */

import type { SessionHandle } from "./types";
import { hasPlaceholder } from "./placeholder.ts";

// ============================================================================
// firstMessage 惰性缓存（2026-09-14）
//
// 后端 handle 的瞬态行此前 firstMessage 硬编码 "(backend session)"——pi 磁盘会话
// 会显示真实首条用户消息（session.name 为空时），spawn 类后端（omp 等，无站位文件、
// 无 agentKey）只能拿到占位文本。这里按 handle 实例惰性缓存真实首条 user 消息：
// 首次 /api/sessions 预热（getMessages capability，超时保护）后，后续请求同步命中。
// ============================================================================

/** handle 实例级 firstMessage 缓存（WeakMap：handle 出库自动回收）。 */
const firstMessageCache = new WeakMap<SessionHandle, string>();
/** 预热 in-flight 去重（同一 handle 并发 GET 只拉一次 getMessages）。 */
const firstMessageWarming = new WeakSet<SessionHandle>();

/** content（string | 文本块数组）→ 文本。 */
function textFromContent(c: unknown): string {
  if (typeof c === "string") return c.trim();
  if (Array.isArray(c)) {
    const t = (c as Array<{ type?: unknown; text?: unknown }>).find((b) => b?.type === "text")?.text;
    if (typeof t === "string" && t.trim()) return t.trim();
  }
  return "";
}

/**
 * 从后端 getMessages 结果提取首条 user 消息文本（跨形状自适应，与
 * normalizeHandleMessages 同款判定）：pi entry（{type,message} 嵌层）解包；
 * 直传消息形状（{role,content}）直接用。取不到 → ""。
 */
export function extractFirstUserText(entries: unknown[]): string {
  for (const item of Array.isArray(entries) ? entries : []) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    let msg: Record<string, unknown> | undefined;
    if (typeof rec.type === "string" && !("role" in rec)) {
      const m = (rec as { message?: unknown }).message;
      if (m && typeof m === "object") msg = m as Record<string, unknown>;
      else continue;
    } else {
      msg = rec;
    }
    if (msg.role !== "user") continue;
    const text = textFromContent(msg.content);
    if (text) return text;
  }
  return "";
}

/** 预热单个 handle（超时保护，失败静默保持占位）。 */
async function warmOne(h: SessionHandle, timeoutMs: number): Promise<void> {
  firstMessageWarming.add(h);
  try {
    const entries = await Promise.race([
      h.getMessages!(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("firstMessage warm timeout")), timeoutMs);
      }),
    ]);
    const text = extractFirstUserText(entries as unknown[]);
    if (text) firstMessageCache.set(h, text);
  } catch {
    // 读取失败/超时：保持占位，下轮 GET 再试
  } finally {
    firstMessageWarming.delete(h);
  }
}

/**
 * 为缺缓存的存活 handle 并行预热 firstMessage（有 getMessages 能力者）。
 * 缓存命中的同步返回；in-flight 去重防并发 GET 重复拉取。
 * 列表/详情路由在组装行前 await 一次，保证首载即真实首条消息。
 */
export async function warmHandleFirstMessages(timeoutMs = 2000): Promise<void> {
  const targets: SessionHandle[] = [];
  for (const h of store().values()) {
    if (h.alive() && typeof h.getMessages === "function" && !firstMessageCache.has(h) && !firstMessageWarming.has(h)) {
      targets.push(h);
    }
  }
  await Promise.all(targets.map((h) => warmOne(h, timeoutMs)));
}

declare global {
  var __sessionHandles: Map<string, SessionHandle> | undefined;
}

function store(): Map<string, SessionHandle> {
  if (!globalThis.__sessionHandles) {
    globalThis.__sessionHandles = new Map();
    const cleanup = () => {
      for (const h of globalThis.__sessionHandles?.values() ?? []) {
        void h.dispose().catch(() => {});
      }
    };
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  return globalThis.__sessionHandles;
}

/** Store a handle under its id. Overwrites any previous handle with the same id (dev HMR safe). */
export function putHandle(handle: SessionHandle): void {
  const prev = store().get(handle.id);
  if (prev && prev !== handle) {
    void prev.dispose().catch(() => {});
  }
  store().set(handle.id, handle);
  watchHandleRunning(handle);
}

export function getHandle(id: string): SessionHandle | undefined {
  const h = store().get(id);
  return h?.alive() ? h : undefined;
}

/** Register the same handle under an additional key (e.g. real native id discovered late). */
export function putHandleAt(key: string, handle: SessionHandle): void {
  store().set(key, handle);
}

/** All live handles as [key, handle] pairs (identity scans). */
export function listAllHandles(): Array<[string, SessionHandle]> {
  return [...store()];
}

/**
 * Dispose every backend handle and clear the store（扩展 reload 后调用）。
 * 扩展热重载替换了 server 代码，但存活的 handle 仍是旧类实例（globalThis 存活）——
 * 不清理则已有会话继续跑旧逻辑（实测：新增的 queue_update 分支对旧 handle 不生效）。
 * dispose 后下次访问按需重建（createSession → 新代码）；zcode 等有状态后端
 * respawn+resume 无损，attach 类为断线重连语义。返回清理数量。
 *
 * 运行中的 handle 不杀（2026-09-07 事故）：reload 曾把在途 zcode app-server 连
 * 进程带轮次一起 dispose——轮次无终态、UI 无提示、内存待发队列随实例丢弃，
 * 用户侧表现即「发消息无响应」。「respawn+resume 无损」只对轮次之间成立。
 * 改为：在途 handle 连同其全部别名键保留在库内跑完当前轮，settle 后自动
 * dispose + 出库，此后下次访问才以新代码重建。
 */
export async function disposeAllHandles(): Promise<number> {
  const all = listAllHandles();
  const ids = new Set<string>();
  const deferred = new Set<SessionHandle>();
  for (const [key, h] of all) {
    ids.add(key);
    if (typeof h.isRunning === "function" && h.isRunning()) {
      deferred.add(h);
      continue;
    }
    try { await h.dispose(); } catch { /* best effort */ }
  }
  // 清库但保留在途 handle 的全部键（占位 uuid / 复合 id 多门口双注册）
  const preserved: Array<[string, SessionHandle]> = [];
  for (const [key, h] of store()) {
    if (deferred.has(h)) preserved.push([key, h]);
  }
  store().clear();
  for (const [key, h] of preserved) store().set(key, h);
  for (const h of deferred) armDeferredDispose(h);
  return ids.size;
}

/** 已挂过 settle 钩子的在途 handle（reload 重复触发时防重复订阅）。 */
const deferredDisposeArmed = new WeakSet<object>();

/** 在途 handle settle 后延迟复核再出库——紧随 agent_end 的排队续轮可能立刻 agent_start。 */
function armDeferredDispose(h: SessionHandle): void {
  if (deferredDisposeArmed.has(h)) return;
  deferredDisposeArmed.add(h);
  try {
    h.subscribe((event: { type: string }) => {
      const t = event?.type;
      if (t !== "agent_settled" && t !== "agent_end") return;
      setTimeout(() => {
        if (!h.alive()) return;
        if (typeof h.isRunning === "function" && h.isRunning()) return;
        removeHandleEverywhere(h);
      }, 1000);
    });
  } catch { /* 订阅失败则留在库内，由进程退出清理兜底 */ }
}

/** 按对象身份出库 + dispose（别名键一并清）。 */
function removeHandleEverywhere(h: SessionHandle): void {
  for (const [key, stored] of [...store()]) {
    if (stored === h) store().delete(key);
  }
  void h.dispose().catch(() => {});
  notifyHandleRunningChange();
}

/**
 * Sidebar/session-list rows for live backend sessions (deduped by object).
 * transient:true — no local file backs them.
 */
export function getHandleSessionInfos(): Array<{
  path: string;
  id: string;
  cwd: string;
  name: undefined;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  transient: boolean;
}> {
  const seen = new Set<SessionHandle>();
  const out: Array<ReturnType<typeof getHandleSessionInfos>[number] & { agent?: string }> = [];
  for (const [key, h] of store()) {
    if (!h.alive() || seen.has(h)) continue;
    seen.add(h);
    // 站位文件已接管列表展示（pi 磁盘扫描段）——瞬时行退场，避免同会话双行。
    // 判定用 handle.id（换绑后为真实复合 id，站位键随换绑迁移）。
    if (hasPlaceholder(h.id)) continue;
    // agent 标签取 source 的 provider 段："aiti-claude-code-agent/claude-code" → "claude-code"
    const agent = h.source.includes("/") ? h.source.split("/")[1] : h.source;
    out.push({
      path: "",
      id: key,
      cwd: h.cwd ?? "",
      name: undefined,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      messageCount: 0,
      // 有真实首条用户消息（缓存命中）→ 与 pi 磁盘会话同语义：无 name 时显示首条
      // 消息文本；未预热/无消息 → 保持占位
      firstMessage: firstMessageCache.get(h) ?? `(backend session)`,
      transient: true,
      agent,
    });
  }
  return out;
}

export function removeHandle(id: string): void {
  const h = store().get(id);
  if (h) void h.dispose().catch(() => {});
  store().delete(id);
}

export function listHandleIds(): string[] {
  return [...store().keys()];
}

/** 正在执行 turn 的后端会话 id 列表（侧栏运行中指示器数据源之一）。
 * 返回该 handle 注册的**全部**对外 id：Map key + handle.id。
 * 侧栏行 id 因后端而异：
 *   - attach：对外行 id = handle.id（uuid），Map key 另有文件路径（脏，过滤 `/` 开头）
 *   - 外部 agent（zcode/cursor/…）：对外行 id = 占位 uuid（putHandleAt(uuid) 的 key），
 *     handle.id 是复合 id（如 `zcode:sess_xxx`）——两者不同，只返回 handle.id 会匹配不上。
 * 因此必须同时收 key 与 handle.id，保证 runningSessionIds.has(行.id) 命中。
 * `/` 开头的 key 是 attach 的会话文件路径（仅内部复用），不暴露给 running。 */
export function getRunningHandleIds(): string[] {
  const ids = new Set<string>();
  for (const [key, h] of store()) {
    if (!h.alive() || !h.isRunning()) continue;
    if (!key.startsWith("/")) ids.add(key);
    if (h.id && !h.id.startsWith("/")) ids.add(h.id);
  }
  return [...ids];
}

// ── handle 侧 running 广播（对 /api/agent/running[events] 合并用）─────────────
type RunningListener = (ids: string[]) => void;
// globalThis 承载（2026-09-15）：运行集广播器（lib/running-broadcast.ts，由
// instrumentation / running 快照 route 入口激活）与 handle 变化（notifyHandleRunningChange）
// 可能不在同一模块图 realm——订阅集合必须进程级共享，否则跨 realm 的通知到不了广播器。
const runningListeners = (): Set<RunningListener> =>
  ((globalThis as { __piHandleRunningListeners?: Set<RunningListener> }).__piHandleRunningListeners ??= new Set());

export function subscribeRunningHandles(listener: RunningListener): () => void {
  runningListeners().add(listener);
  return () => runningListeners().delete(listener);
}

/** 重建 handle 运行集并广播（与 rpc-manager.notifyRunningChange 同构，广播合并后完整集）。 */
export function notifyHandleRunningChange(): void {
  const ids = getRunningHandleIds();
  const snapshot = JSON.stringify(ids);
  if (snapshot === lastRunningSnapshot) return;
  lastRunningSnapshot = snapshot;
  for (const l of runningListeners()) l(ids);
}
let lastRunningSnapshot = "";

/** putHandle 时给 handle 挂 running 事件监听（agent_start/end/settled/turn_*）——只挂一次。 */
const runningWatched = new WeakSet<object>();
export function watchHandleRunning(handle: { id: string; subscribe(listener: (e: { type: string }) => void): () => void }): void {
  if (runningWatched.has(handle)) return;
  runningWatched.add(handle);
  handle.subscribe((event) => {
    const t = event.type;
    if (t === "agent_start" || t === "agent_end" || t === "agent_settled" || t === "turn_start" || t === "turn_end") {
      notifyHandleRunningChange();
    }
  });
}
