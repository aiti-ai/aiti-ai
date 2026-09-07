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
 */
export async function disposeAllHandles(): Promise<number> {
  const all = listAllHandles();
  const ids = new Set<string>();
  for (const [key, h] of all) {
    ids.add(key);
    try { await h.dispose(); } catch { /* best effort */ }
  }
  store().clear();
  return ids.size;
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
      firstMessage: `(backend session)`,
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
 * ⚠ 必须用 handle.id（uuid）而非 Map key——双 key 注册（attach 的 uuid+文件路径）
 * 下按 key 遍历会混入路径脏数据且撞车误匹配。 */
export function getRunningHandleIds(): string[] {
  return [...store().values()]
    .filter((h) => h.alive() && h.isRunning())
    .map((h) => h.id);
}

// ── handle 侧 running 广播（对 /api/agent/running[events] 合并用）─────────────
type RunningListener = (ids: string[]) => void;
const runningListeners = new Set<RunningListener>();

export function subscribeRunningHandles(listener: RunningListener): () => void {
  runningListeners.add(listener);
  return () => runningListeners.delete(listener);
}

/** 重建 handle 运行集并广播（与 rpc-manager.notifyRunningChange 同构，广播合并后完整集）。 */
export function notifyHandleRunningChange(): void {
  const ids = getRunningHandleIds();
  const snapshot = JSON.stringify(ids);
  if (snapshot === lastRunningSnapshot) return;
  lastRunningSnapshot = snapshot;
  for (const l of runningListeners) l(ids);
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
