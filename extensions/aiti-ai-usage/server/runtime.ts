/**
 * aiti-ai-usage · 服务端运行时：初始化/同步/watch 生命周期。
 *
 * 摄入载体（2026-09-12 真异步改造）：全量/手动 Rescan 在 worker_threads 独立线程执行
 * （ingest-worker.ts，独立 SQLite 连接）；主线程只保留实时小写入（live ingest、proxy tail、
 * 防抖 flushDaily）与 API。worker 不可用时回退主线程异步分批（保底可用）。
 */
import path from "node:path";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { Worker } from "node:worker_threads";
import { openUsageDb, type UsageDb } from "../lib/db.ts";
import { syncLiveSessions, flushDaily, scheduleFlush, cancelFlush, userMsgsRebuildPending, clearUserMsgsRebuild } from "../lib/ingest.ts";
import { syncArchives } from "../lib/archives.ts";
import { importProxyHistory, watchProxyLog } from "../lib/proxy-tail.ts";
import { syncExtUsage } from "../lib/ext-ingest.ts";
import type { IngestJob } from "./ingest-worker.ts";

export interface Runtime {
  usage: UsageDb;
  sessionsDir: string;
  archiveDir: string;
  modelUsageDir: string;
  syncAll(): Promise<void>;
  /** 最近一次摄入的执行载体（worker=真后台 / inline=主线程回退）——诊断与测试用。 */
  lastSyncBackend: "worker" | "inline" | null;
  stop(): void;
}

let rt: Runtime | null = null;
/** 并发去重：启动 sync 与手动 Rescan 共享同一在飞任务（幂等，防重复重扫）。 */
let syncInFlight: Promise<void> | null = null;
/** 在飞 worker（stop/热重载时 terminate，不留持续写库的线程）。 */
let currentWorker: Worker | null = null;

/** 在独立线程执行一次全量摄入；完成后 worker 被终止（一次性）。 */
function runSyncInWorker(job: IngestJob): Promise<void> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./ingest-worker.ts", import.meta.url), {
        workerData: job,
        // Node 22.6–22.17 需显式开启；≥22.18 默认开启且 flag 兼容（no-op 接受）
        execArgv: ["--experimental-strip-types"],
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    currentWorker = worker;
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (currentWorker === worker) currentWorker = null;
      void worker.terminate().catch(() => { /* 已退出 */ });
      if (err) reject(err); else resolve();
    };
    const t0 = Date.now();
    worker.on("message", (m: { type?: string; message?: string }) => {
      if (m?.type === "done") {
        console.log(`[aiti-ai-usage] 后台摄入完成（worker · ${Date.now() - t0}ms）`);
        finish();
      } else if (m?.type === "error") finish(new Error(String(m.message ?? "unknown worker error")));
    });
    worker.on("error", (e) => finish(e instanceof Error ? e : new Error(String(e))));
    worker.on("exit", (code) => {
      if (code !== 0) finish(new Error(`ingest worker 异常退出（code=${code}）`));
    });
    worker.postMessage({ type: "sync" });
  });
}

export function runtime(): Runtime {
  if (!rt) throw new Error("[aiti-ai-usage] runtime not initialized");
  return rt;
}

export function init(configDir: string): Runtime {
  const agentDir = process.env.PI_CODING_AGENT_DIR
    ? path.resolve(process.env.PI_CODING_AGENT_DIR)
    : path.join(homedir(), ".pi", "agent");
  mkdirSync(path.join(path.dirname(configDir), "cache"), { recursive: true }); // 数据分层：cache 在扩展数据根下（configDir = <extRoot>/config）；宿主预建之外的双保险
  // 数据分层：用量索引（可从 pi sessions / .pwarc 重灌，可重建）→ cache/；源数据（归档/sessions）才是 state 关注对象
  const usage = openUsageDb(path.join(path.dirname(configDir), "cache", "usage.sqlite"));
  usage.ensure();
  const r: Runtime = {
    usage,
    sessionsDir: path.join(agentDir, "sessions"),
    archiveDir: process.env.TOKEN_USAGE_ARCHIVE_DIR
      ? path.resolve(process.env.TOKEN_USAGE_ARCHIVE_DIR)
      // PI_WEB_DATA_DIR 优先（Docker/Windows 数据根独立于 ~/.pi）；未设 = ~/.pi/web/data/... 原行为
      : path.join(process.env.PI_WEB_DATA_DIR || path.join(homedir(), ".pi", "web", "data"), "session-manager", "archive"),
    modelUsageDir: path.join(agentDir, "model-usage"),
    lastSyncBackend: null,
    syncAll(): Promise<void> {
      // 真异步（2026-09-12）：摄入在 worker_threads 独立线程 + 独立 SQLite 连接执行，
      // 主线程零参与；worker 不可用（旧 Node/环境限制）则回退主线程异步分批保底。
      // 与手动 Rescan 并发调用共享同一在飞任务。
      if (syncInFlight) return syncInFlight;
      const job: IngestJob = {
        configDir,
        sessionsDir: this.sessionsDir,
        archiveDir: this.archiveDir,
        modelUsageDir: this.modelUsageDir,
      };
      const run = (async () => {
        try {
          await runSyncInWorker(job);
          r.lastSyncBackend = "worker";
        } catch (err) {
          console.error("[aiti-ai-usage] worker 摄入失败，回退主线程异步分批:", err instanceof Error ? err.message : err);
          // user_msgs 重建标记（老库升级）同样在回退链消费：force 忽略文件水位重扫一轮
          const force = userMsgsRebuildPending(this.usage.db);
          const ctx = { usage: this.usage, sessionsDir: this.sessionsDir };
          await syncLiveSessions(ctx, { force });
          await syncArchives(this.usage, this.archiveDir, { force });
          await importProxyHistory({ usage: this.usage, dir: this.modelUsageDir });
          await syncExtUsage({ usage: this.usage }); // 外部 agent 会话（回退链同样覆盖）
          await flushDaily(this.usage);
          if (force) clearUserMsgsRebuild(this.usage.db);
          r.lastSyncBackend = "inline";
        }
      })().finally(() => { if (syncInFlight === run) syncInFlight = null; });
      syncInFlight = run;
      return run;
    },
    stop() {
      // watcher 由闭包持有，见下方赋值
      if (stopWatch) stopWatch();
      // 在飞 worker 终止（热重载不留下持续写库的线程；未提交事务由 SQLite 回滚，批级幂等可重跑）
      try { void currentWorker?.terminate().catch(() => { /* 已退出 */ }); } catch { /* noop */ }
      currentWorker = null;
      // 2026-09-10：不再 cancelFlush + close——热重载后旧会话的 message_end 回调仍
      // 派发到旧扩展实例，close 会让旧回调全部报 "database is not open" 且 usage
      // 明细持续丢失（实测 reload 后刷屏数分钟）。WAL 多连接并发安全（busy_timeout
      // 5s），旧连接只剩被动写（liveIngest 明细 + 3s 防抖 flush，自洽收敛），随进程
      // 退出释放；新实例接管 watch/sync 主动职责。flushDaily 幂等重算，交替写无损。
    },
  };
  let stopWatch: (() => void) | null = null;
  // 启动期全量摄入走 worker 真后台：不 await（HTTP 服务立即就绪，数据后台补齐）；
  // 摄入期间主线程完全不被占用，guard 探活正常，不再触发重启死循环（2026-09-12 修复）。
  r.syncAll().catch((e) => console.error("[aiti-ai-usage] 启动 syncAll 失败:", e));
  stopWatch = watchProxyLog({
    usage: r.usage,
    dir: r.modelUsageDir,
    onData: () => { try { scheduleFlush(r.usage); } catch (e) { console.error("[aiti-ai-usage] scheduleFlush:", e); } },
  });
  rt = r;
  return r;
}
