/**
 * aiti-ai-usage · 外部 agent 会话摄入（第四路，全事件驱动零轮询）。
 *
 * 数据源：_shared/ext-session-usage.ts 的 builtinExtUsageSources()（claude / qodercn /
 * codebuddy / zcode 四源）。会话 → 用量行（ExtUsageRow）→ ext_usage 表。
 *
 * 增量水位：
 *   - jsonl 源（claude/qodercn/codebuddy）：per-file mtime_ms+size（ext_files 表）；
 *   - sqlite 源（zcode）：per-session rev=time_updated（list 时携带），禁止按文件 stat
 *     （源 db 每轮写入/WAL 都在变，按文件 stat 恒判变 → 全量重解析；对齐 session-manager
 *     zcode 直读教训）。
 *
 * 异步分批：每会话一个写事务 + 让出事件循环（withTx + yieldToLoop），主线程/worker 双可用。
 */
import fs from "node:fs";
import type { UsageDb } from "./db.ts";
import { localDay } from "./db.ts";
import { noteDirtyDay, withTx, yieldToLoop } from "./ingest.ts";
import {
  builtinExtUsageSources,
  type ExtUsageRow,
  type ExtUsageSource,
  type ExtUsageSourceEnv,
} from "./ext-session-usage.ts"; // 本扩展内副本（deploy 从 _shared 权威源自动同步）

export interface ExtIngestCtx {
  usage: UsageDb;
  /** 测试隔离口：覆盖各源默认根目录（生产不传，走 homedir 默认）。 */
  env?: ExtUsageSourceEnv;
}

/** 源枚举失败（zcode db 短暂写锁等）时静默跳过本轮，下轮收敛。 */
function listSafe(src: ExtUsageSource) {
  try {
    return src.list();
  } catch (e) {
    console.error(`[aiti-ai-usage] ext source ${src.id} list 失败（下轮重试）:`,
      e instanceof Error ? e.message : e);
    return [];
  }
}

/** 一个会话的 rows 写入 ext_usage（幂等 PK 去重）+ 标记受影响 day 汇总。 */
function insertExtRows(usage: UsageDb, rows: ExtUsageRow[]): void {
  if (rows.length === 0) return;
  const ins = usage.db.prepare(`
    INSERT OR IGNORE INTO ext_usage
      (agent, session_id, ts, day, provider, model, input, output,
       cache_read, cache_write, reasoning, total_tokens, cost_total, credits)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const r of rows) {
    ins.run(r.agent, r.sid, r.ts, localDay(r.ts), r.provider, r.model,
      r.input, r.output, r.cacheRead, r.cacheWrite, r.reasoning, r.totalTokens, r.costTotal, r.credits);
    noteDirtyDay(localDay(r.ts));
  }
}

/** 增量同步全部外部 agent 源。返回处理的会话数。 */
export async function syncExtUsage(ctx: ExtIngestCtx): Promise<number> {
  const { usage } = ctx;
  const db = usage.db;
  let changed = 0;

  for (const src of builtinExtUsageSources(ctx.env)) {
    let probe: boolean;
    try { probe = src.probe(); } catch { continue; }
    if (!probe) continue;

    const refs = listSafe(src);
    for (const ref of refs) {
      // 水位判断
      if (ref.rev !== undefined) {
        // sqlite 源：per-session rev 水位
        const prev = db.prepare("SELECT rev FROM ext_files WHERE path = ? AND agent = ?")
          .get(ref.path, src.id) as { rev?: number | null } | undefined;
        if (prev && prev.rev === ref.rev) continue;
      } else {
        // jsonl 源：mtime+size 水位
        let st: fs.Stats;
        try { st = fs.statSync(ref.path); } catch { continue; }
        const prev = db.prepare("SELECT mtime_ms, size FROM ext_files WHERE path = ? AND agent = ?")
          .get(ref.path, src.id) as { mtime_ms?: number | null; size?: number | null } | undefined;
        if (prev && prev.mtime_ms === Math.round(st.mtimeMs) && prev.size === st.size) continue;
      }

      let rows: ExtUsageRow[] = [];
      try { rows = src.parse(ref); } catch (e) {
        console.error(`[aiti-ai-usage] ext parse ${src.id} ${ref.sid} 失败:`,
          e instanceof Error ? e.message : e);
      }

      withTx(db, () => {
        insertExtRows(usage, rows);
        // 水位落盘（含「无数据会话」——parse 返回 [] 也记录水位，避免每轮重扫噪音会话）
        const st = ref.rev === undefined ? (() => {
          try { return fs.statSync(ref.path); } catch { return null; }
        })() : null;
        db.prepare(`
          INSERT INTO ext_files (path, agent, session_id, mtime_ms, size, rev)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(path, agent) DO UPDATE SET
            session_id=excluded.session_id, mtime_ms=excluded.mtime_ms,
            size=excluded.size, rev=excluded.rev`).run(
          ref.path, src.id, ref.sid,
          st ? Math.round(st.mtimeMs) : null, st ? st.size : null, ref.rev ?? null);
      });

      changed++;
      await yieldToLoop(); // 每会话让步
    }
  }
  return changed;
}
