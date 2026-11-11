/**
 * session-index-async —— SessionIndex 异步门面：重活（sync/syncExt）派发到
 * dist/index-worker.mjs 后台线程，读/小写留主线程本地连接（照 aiti-doc-center
 * 主读 worker 写的分工先例）。
 *
 * 降级链（全部自动，调用方无感）：worker bundle 缺失 / spawn 失败 / 往返出错 /
 * 非内置适配器（第三方代理源不可进 worker）→ 回落本地实现（行为同旧版，重活回
 * 主线程，只失去后台化）。连续 3 次失败禁用 worker（防 spawn 崩溃循环），重启进程恢复。
 *
 * 只改 sync/syncExt 两个 async 方法的通道；其余 17 个同步读方法的调用点零改动。
 */
import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { openSessionIndex, type SessionIndex } from "./session-index.ts";
import { builtinAdapters } from "./agents/registry.ts";
import type { ExtSessionRef } from "./agents/types.ts";
import type { ParsedSessionFile } from "./session-file.ts";
import type { IndexedSessionRow } from "./session-index.ts";
import type { SearchFilters, SearchHit } from "./session-index.ts";
import type { SessionStats } from "./session-stats.ts";

const BUILTIN_IDS = new Set(builtinAdapters().map((a) => a.id));

/** dbPath → facade 登记（requestIndexVacuum 查找；schedule hook 用）。 */
const facades = new Map<string, { requestVacuum(): boolean }>();

export interface IndexFacade extends SessionIndex {
  /** 索引库瘦身触发（worker 不在场返回 false，绝不本地跑 VACUUM）。 */
  requestVacuum(): boolean;
}

export function createIndexFacade(dbPath: string, opts: { workerPath?: string } = {}): IndexFacade {
  const local = openSessionIndex(dbPath);
  let worker: Worker | null = null;
  let workerDisabled = false;
  let spawnFails = 0;
  let seq = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  const log = (...a: unknown[]) => console.warn("[session-manager:index-worker]", ...a);

  function failAllPending(err: Error): void {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  }
  function noteFailure(): void {
    if (++spawnFails >= 3) {
      workerDisabled = true;
      log("连续 3 次失败，禁用 worker——重活回落主线程（重启进程恢复）");
    }
  }

  function ensureWorker(): Worker | null {
    if (workerDisabled || !opts.workerPath || !existsSync(opts.workerPath)) return null;
    if (worker) return worker;
    try {
      const w = new Worker(opts.workerPath, { workerData: { dbPath } });
      w.unref(); // 不阻进程退出；shutdown 经 close() 显式 terminate
      w.on("message", (m: { type: string; id?: number; result?: unknown; message?: string; msg?: string }) => {
        if (m.type === "ready") { log("worker ready（索引真后台）"); return; }
        if (m.type === "log") { log(String(m.msg)); return; }
        if (m.type === "vacuum-done") { log("vacuum 完成：", JSON.stringify(m.result)); return; }
        const p = m.id !== undefined ? pending.get(m.id) : undefined;
        if (!p) {
          if (m.type === "error") log("worker 后台任务失败（无请求 id）：", String(m.message));
          return;
        }
        pending.delete(m.id);
        if (m.type === "done") { spawnFails = 0; p.resolve(m.result); }
        else p.reject(new Error(String(m.message)));
      });
      w.on("error", (e) => {
        log("worker error:", e instanceof Error ? e.message : e);
        failAllPending(e instanceof Error ? e : new Error(String(e)));
        if (worker === w) worker = null;
        noteFailure();
      });
      w.on("exit", (code) => {
        if (worker === w) {
          worker = null;
          failAllPending(new Error(`index worker exited (${code})`));
        }
      });
      worker = w;
      return w;
    } catch (e) {
      log("worker spawn failed:", e instanceof Error ? e.message : e);
      noteFailure();
      return null;
    }
  }

  /** worker 往返；不可用返回 null（调用方回落本地）。 */
  function roundtrip<T>(payload: Record<string, unknown>): Promise<T> | null {
    const w = ensureWorker();
    if (!w) return null;
    const id = ++seq;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      try { w.postMessage({ ...payload, id }); } catch (e) {
        pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  const facade: IndexFacade = {
    ensure: () => local.ensure(),

    async sync(sessions) {
      try {
        const r = await roundtrip<{ indexed: number; removed: number }>({ cmd: "sync", sessions });
        if (r) return r;
      } catch (e) {
        log("sync worker 往返失败，回落本地：", e instanceof Error ? e.message : e);
      }
      return local.sync(sessions);
    },

    async syncExt(agent: string, refs: ExtSessionRef[], parse: (ref: ExtSessionRef) => ParsedSessionFile | null) {
      if (BUILTIN_IDS.has(agent)) {
        try {
          const r = await roundtrip<{ indexed: number; removed: number }>({ cmd: "syncExt", agent, refs });
          if (r) return r;
        } catch (e) {
          log(`syncExt(${agent}) worker 往返失败，回落本地：`, e instanceof Error ? e.message : e);
        }
      }
      return local.syncExt(agent, refs, parse);
    },

    requestVacuum(): boolean {
      const w = ensureWorker();
      if (!w) return false;
      try { w.postMessage({ cmd: "vacuum" }); } catch { return false; }
      return true;
    },

    upsertExtParsed: (agent, sid, refPath, parsed) => local.upsertExtParsed(agent, sid, refPath, parsed),
    refreshExtTimestamps: (agent, fresh) => local.refreshExtTimestamps(agent, fresh),
    extRows: (agents) => local.extRows(agents),
    markArchived: (packageRef, sessionIds) => local.markArchived(packageRef, sessionIds),
    setExtArchived: (id, archived) => local.setExtArchived(id, archived),
    search: (q, limit, filters?: SearchFilters) => local.search(q, limit, filters),
    // session-search tools (docs/pi-session-search-tools-plan.md): read-only, main thread is fine (fts queries are ms-level)
    searchSessions: (q, opts) => local.searchSessions(q, opts),
    resolveSessionRefs: (refs) => local.resolveSessionRefs(refs),
    sessionMessages: (ref, opts) => local.sessionMessages(ref, opts),
    stats: (runningSessionIds, days?) => local.stats(runningSessionIds, days) as SessionStats,
    lastMeta: (sessionId) => local.lastMeta(sessionId),
    lastMetaBatch: (sessionIds) => local.lastMetaBatch(sessionIds),
    lastMessageText: (sessionId) => local.lastMessageText(sessionId),
    lastMessageTextBatch: (sessionIds) => local.lastMessageTextBatch(sessionIds),
    getSession: (id) => local.getSession(id) as IndexedSessionRow | undefined,
    getSessionBatch: (sessionIds) => local.getSessionBatch(sessionIds),
    archivedRows: () => local.archivedRows(),
    restoreToLive: (id, path) => local.restoreToLive(id, path),
    removeSession: (id) => local.removeSession(id),
    removeAgentRows: (agent) => local.removeAgentRows(agent),

    close() {
      try { void worker?.terminate(); } catch { /* already gone */ }
      worker = null;
      local.close();
    },
  };

  facades.set(dbPath, facade);
  return facade;
}

/** schedule hook 入口：向指定索引库的 worker 投递 vacuum（fire-and-forget）。 */
export function requestIndexVacuum(dbPath: string): boolean {
  const f = facades.get(dbPath);
  return f ? f.requestVacuum() : false;
}
