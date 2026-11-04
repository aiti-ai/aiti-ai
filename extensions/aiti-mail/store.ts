/**
 * store.ts —— 发送记录持久化（aiti-mail，方案 docs/aiti-ai-schedule-integration-plan.md §4.6）
 *
 * node:sqlite（Node 24 内置，aiti-doc-center 生产先例）· configDir/mails.db
 * 写入为单行 insert（量级极小），主线程同步 API 无 doc-center 式饿死风险。
 *
 * 保留策略：默认 90 天；启动清理一次 + 每日清理一次（unref timer——数据保留清理，
 * 非等待/刷新型轮询，aiti-cmd audit.cleanupRetention 同款先例，不违反「禁轮询」红线）。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join as pathJoin, basename as pathBasename, dirname as pathDirname } from "node:path";

export const RETENTION_DAYS = 90;

export interface SendRow {
  id: number;
  ts: string;
  to_addr: string;
  subject: string;
  body_len: number | null;
  status: string;            // ok | error
  error: string | null;
  message_id: string | null;
  duration_ms: number | null;
  source: string | null;     // manual | api | aiti-ai-schedule:<planId> | test
}

export class SendStore {
  db: DatabaseSync;
  dir: string;
  private dailyTimer: any = null;

  constructor(dir: string) {
    this.dir = dir;
    // cache 根：宿主 configDir = <extRoot>/config → <extRoot>/cache；否则按传入目录下 cache/（2026-09-13 三目录对称）
    const cacheBase = pathBasename(dir) === "config" ? pathJoin(pathDirname(dir), "cache") : pathJoin(dir, "cache");
    mkdirSync(cacheBase, { recursive: true });
    this.db = new DatabaseSync(pathJoin(cacheBase, "mails.db"));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sends (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,            -- ISO 时间
        to_addr TEXT NOT NULL,       -- 单个收件人（多收件人拆行）
        subject TEXT NOT NULL,
        body_len INTEGER,
        status TEXT NOT NULL,        -- ok | error
        error TEXT,
        message_id TEXT,
        duration_ms INTEGER,
        source TEXT                  -- manual | api | aiti-ai-schedule:<planId> | test
      );
      CREATE INDEX IF NOT EXISTS idx_sends_ts ON sends(ts DESC);
    `);
  }

  insert(row: Omit<SendRow, "id">): void {
    this.db.prepare(
      `INSERT INTO sends (ts, to_addr, subject, body_len, status, error, message_id, duration_ms, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.ts, row.to_addr, row.subject,
      row.body_len ?? null, row.status, row.error ?? null,
      row.message_id ?? null, row.duration_ms ?? null, row.source ?? null,
    );
  }

  /** 发送记录（默认 50，倒序；可选 status 过滤）。 */
  list(limit = 50, status?: string): SendRow[] {
    const n = Math.max(1, Math.min(500, Number(limit) || 50));
    const sql = `SELECT id, ts, to_addr, subject, body_len, status, error, message_id, duration_ms, source
                 FROM sends ${status ? "WHERE status = ?" : ""} ORDER BY ts DESC, id DESC LIMIT ${n}`;
    const stmt = this.db.prepare(sql);
    const rows = (status ? stmt.all(status) : stmt.all()) as unknown as SendRow[];
    return rows;
  }

  /** 清理超过保留期的记录，返回删除行数。 */
  cleanup(retentionDays = RETENTION_DAYS): number {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 3600 * 1000).toISOString();
    return this.db.prepare(`DELETE FROM sends WHERE ts < ?`).run(cutoff).changes;
  }

  /** 启动清理一次 + 每日清理一次（unref timer）。 */
  startRetentionTimer(retentionDays = RETENTION_DAYS): void {
    try { this.cleanup(retentionDays); } catch { /* 启动清理失败不阻断 */ }
    if (this.dailyTimer) clearInterval(this.dailyTimer);
    this.dailyTimer = setInterval(() => {
      try { this.cleanup(retentionDays); } catch { /* 忽略 */ }
    }, 24 * 3600 * 1000);
    this.dailyTimer?.unref?.();
  }

  close(): void {
    if (this.dailyTimer) { clearInterval(this.dailyTimer); this.dailyTimer = null; }
    try { this.db.close(); } catch { /* 忽略 */ }
  }
}
