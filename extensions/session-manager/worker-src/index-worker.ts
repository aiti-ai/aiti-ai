/**
 * index-worker.ts —— session-manager 索引后台 Worker（照 aiti-doc-center doc-worker 先例）。
 *
 * 为什么：node:sqlite 是同步 API，session-index 的 sync/syncExt（FTS5 批量写，索引库
 * 2G+/百万消息级）在主线程跑会饿死事件循环（2026-09-12 拷贝风暴/重索引事故：pi-web
 * 失去响应 → guard 探活超时 → 重启风暴）。本 Worker 独立线程 + 独立 SQLite 连接
 * （WAL 多连接并发，busy_timeout 防碰撞），主线程保留读/小写连接。
 *
 * 协议（Main → Worker）：
 *   {cmd:"sync", id, sessions}            pi 会话索引同步（runtime.syncIndex）
 *   {cmd:"syncExt", id, agent, refs}      外部源同步；parse 在 worker 内按内置适配器表完成
 *   {cmd:"vacuum"}                        索引库瘦身（schedule hook 触发，fire-and-forget）
 * 协议（Worker → Main）：
 *   {type:"ready"} / {type:"done", id, result} / {type:"error", id, message, code?} / {type:"log", msg}
 *
 * 第三方代理适配器不在内置表 → error code:"NO_ADAPTER"，main 侧门面回落本地实现。
 * runCommand / runVacuumOn 导出供单测（parentPort 不存在的 import 环境只定义不启动）。
 */
import { parentPort, workerData } from "node:worker_threads";
import { openSync, closeSync, statSync, unlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { openSessionIndex, type SessionIndex } from "../lib/session-index.ts";
import { builtinAdapters } from "../lib/agents/registry.ts";
import type { AgentAdapter, ExtSessionRef } from "../lib/agents/types.ts";
import type { ParsedSessionFile } from "../lib/session-file.ts";

export type WorkerMsg = { cmd: "sync" | "syncExt" | "vacuum"; id?: number } & Record<string, unknown>;
export type WorkerReply =
  | { type: "ready" }
  | { type: "done"; id?: number; result: unknown }
  | { type: "error"; id?: number; message: string; code?: string }
  | { type: "log"; msg: string }
  | { type: "vacuum-done"; result: unknown };

/** 单条命令处理（导出供单测；parentPort 监听器是薄壳）。 */
export async function runCommand(
  index: SessionIndex,
  adapters: Map<string, AgentAdapter>,
  msg: WorkerMsg,
): Promise<unknown> {
  if (msg.cmd === "sync") {
    return index.sync(msg.sessions as Parameters<SessionIndex["sync"]>[0]);
  }
  if (msg.cmd === "syncExt") {
    const agent = String(msg.agent);
    const refs = msg.refs as ExtSessionRef[];
    const adapter = adapters.get(agent);
    if (!adapter) throw Object.assign(new Error(`NO_ADAPTER:${agent}`), { code: "NO_ADAPTER" });
    return index.syncExt(agent, refs, (ref) => adapter.parse(ref) as ParsedSessionFile | null);
  }
  if (msg.cmd === "vacuum") {
    const wd = workerData as { dbPath?: string } | null;
    return runVacuumOn(String(msg.dbPath ?? wd?.dbPath ?? ""));
  }
  throw new Error(`UNKNOWN_CMD:${msg.cmd}`);
}

/**
 * 索引库瘦身：只回收「DELETE+重插留下的空闲页」（freelist），不删任何未删的行。
 * 首次（auto_vacuum 未开）设 INCREMENTAL + 一次性 VACUUM 重写全库（2G 级分钟级，
 * worker 线程内 web 无感）；此后每次只做有界 incremental_vacuum（30s 上限）。
 * 跨实例锁：dev/prod 双实例共享同一 db，锁文件防并发 VACUUM（2h 残留接管）。
 * 导出供单测。
 */
export function runVacuumOn(dbPath: string): { mode: string; freedPages: number; durationMs: number } {
  const t0 = Date.now();
  const noFreed = { mode: "noop", freedPages: 0, durationMs: Date.now() - t0 };
  if (!dbPath) return noFreed;

  // 跨实例锁（文件 O_EXCL；独立于 sqlite 锁——VACUUM 排他锁前先礼貌让路）
  const lockPath = `${dbPath}.vacuum-lock`;
  let lockFd = -1;
  try {
    try {
      lockFd = openSync(lockPath, "wx");
    } catch {
      let stale = false;
      try { stale = Date.now() - statSync(lockPath).mtimeMs > 2 * 3600 * 1000; } catch { /* gone */ }
      if (!stale) return { mode: "skipped-locked", freedPages: 0, durationMs: Date.now() - t0 };
      try { unlinkSync(lockPath); } catch { /* raced */ }
      try { lockFd = openSync(lockPath, "wx"); } catch { return { mode: "skipped-locked", freedPages: 0, durationMs: Date.now() - t0 }; }
    }

    const db = new DatabaseSync(dbPath);
    try {
      try { db.exec("PRAGMA busy_timeout = 30000"); } catch { /* old node */ }
      // node:sqlite 下 value-returning pragma 用 .get；incremental_vacuum 不返回行
      //（.get 会抛），统一走 exec——进度以 freelist_count 前后差计。
      const freeOf = (): number => {
        const r = db.prepare("PRAGMA freelist_count").get() as Record<string, number> | undefined;
        return Number(r ? Object.values(r)[0] ?? 0 : 0);
      };
      // freelist 为 0 → 无可回收，跳过（VACUUM 不便宜，不白做）
      const freePages = freeOf();
      if (!freePages) return noFreed;

      const avRow = db.prepare("PRAGMA auto_vacuum").get() as Record<string, number> | undefined;
      const av = Number(avRow ? Object.values(avRow)[0] ?? 0 : 0);
      if (av !== 2) {
        // 首次：设 INCREMENTAL 后 VACUUM 一次性重写（pragma 随重写持久化进库）
        db.exec("PRAGMA auto_vacuum = INCREMENTAL");
        db.exec("VACUUM");
        return { mode: "full", freedPages: freePages, durationMs: Date.now() - t0 };
      }
      // 常规：有界增量回收（每步 ≤512 页，30s 上限——schedule 任务别拖太久）
      let freed = 0;
      const cap = Date.now() + 30_000;
      while (Date.now() < cap) {
        const before = freeOf();
        db.exec("PRAGMA incremental_vacuum(512)");
        const after = freeOf();
        freed += Math.max(0, before - after);
        if (after === 0 || after >= before) break; // 收敛/无进展即停
      }
      return { mode: "incremental", freedPages: freed, durationMs: Date.now() - t0 };
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  } finally {
    if (lockFd >= 0) {
      try { closeSync(lockFd); } catch { /* already closed */ }
      try { unlinkSync(lockPath); } catch { /* raced */ }
    }
    // 锁没拿到（skipped-locked）→ 绝不动别人的锁
  }
}

// ── worker 启动（仅在 worker_threads 环境执行；单测 import 时跳过）──
if (parentPort) {
  const { dbPath } = workerData as { dbPath: string };
  const index = openSessionIndex(dbPath);
  const adapters = new Map(builtinAdapters().map((a) => [a.id, a]));
  const post = (msg: WorkerReply) => { try { parentPort!.postMessage(msg); } catch { /* ignore */ } };
  const log = (msg: string) => post({ type: "log", msg });

  // 串行队列：单连接上的事务不可交错（sync/syncExt 内部 BEGIN/COMMIT）
  let chain: Promise<void> = Promise.resolve();
  parentPort.on("message", (msg: WorkerMsg) => {
    chain = chain.then(async () => {
      try {
        const result = await runCommand(index, adapters, msg);
        // vacuum 无请求 id（fire-and-forget）：回包走 vacuum-done，main 只记日志
        if (msg.cmd === "vacuum") post({ type: "vacuum-done", result });
        else post({ type: "done", id: msg.id, result });
      } catch (e) {
        post({ type: "error", id: msg.id, message: e instanceof Error ? e.message : String(e), code: (e as { code?: string }).code });
      }
    }).catch(() => { /* 队列不断 */ });
  });
  parentPort.on("close", () => { try { index.close(); } catch { /* already closed */ } });
  post({ type: "ready" });
}
