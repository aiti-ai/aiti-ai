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

/** 正在执行 turn 的后端会话 id 列表（侧栏运行中指示器数据源之一）。 */
export function getRunningHandleIds(): string[] {
  return [...store().entries()]
    .filter(([, h]) => h.alive() && h.isRunning())
    .map(([key]) => key);
}
