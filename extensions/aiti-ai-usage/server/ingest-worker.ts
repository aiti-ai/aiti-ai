/**
 * aiti-ai-usage · 后台摄入 worker（真异步）。
 *
 * 启动全量与手动 Rescan 在独立线程执行：独立 SQLite 连接（WAL + busy_timeout 5s，
 * 与主线程 live ingest / proxy tail 多连接并发写安全）+ Node 原生 .ts 加载
 * （≥22.18 type stripping 默认开启；22.6–22.17 由主线程 spawn 时补 flag）。
 * 主线程零参与——摄入期间 HTTP/SSE/页面不受任何影响（2026-09-12 真异步改造）。
 *
 * 生命周期：一次性 worker。主线程 spawn → postMessage({type:"sync"}) →
 * 等 {type:"done"|"error"} → terminate。不变量：一旦 done/error 必先 close DB，
 * 确保 terminate 时无挂起事务。
 */
import { parentPort, workerData } from "node:worker_threads";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { openUsageDb } from "../lib/db.ts";
import { syncLiveSessions, flushDaily, userMsgsRebuildPending, clearUserMsgsRebuild } from "../lib/ingest.ts";
import { syncArchives } from "../lib/archives.ts";
import { importProxyHistory } from "../lib/proxy-tail.ts";
import { syncExtUsage } from "../lib/ext-ingest.ts";

export interface IngestJob {
  configDir: string;
  sessionsDir: string;
  archiveDir: string;
  modelUsageDir: string;
}

const job = workerData as IngestJob;
mkdirSync(path.join(path.dirname(job.configDir), "cache"), { recursive: true }); // 数据分层：cache 在扩展数据根下（job.configDir = <extRoot>/config）
const usage = openUsageDb(path.join(path.dirname(job.configDir), "cache", "usage.sqlite"));
usage.ensure();

async function runSync(): Promise<void> {
  // user_msgs 重建标记（老库升级）：force 忽略文件/包水位，跑一轮全量后清除
  const force = userMsgsRebuildPending(usage.db);
  await syncLiveSessions({ usage, sessionsDir: job.sessionsDir }, { force });
  await syncArchives(usage, job.archiveDir, { force });
  await importProxyHistory({ usage, dir: job.modelUsageDir });
  await syncExtUsage({ usage });          // 外部 agent 会话（claude/codebuddy/zcode/qodercn）
  await flushDaily(usage);
  if (force) clearUserMsgsRebuild(usage.db);
}

parentPort?.on("message", (msg: { type?: string; id?: number }) => {
  if (msg?.type !== "sync") return;
  const id = msg.id;
  runSync().then(
    () => {
      try { usage.close(); } catch { /* already closed */ }
      parentPort?.postMessage({ type: "done", id });
    },
    (err) => {
      try { usage.close(); } catch { /* already closed */ }
      parentPort?.postMessage({ type: "error", id, message: String(err?.message ?? err) });
    },
  );
});
