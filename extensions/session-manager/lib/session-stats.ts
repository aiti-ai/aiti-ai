/**
 * session-manager — stats aggregation over the SQLite index (§14.3).
 * Pure helpers so they can be unit-tested without a live server.
 */
import type { DatabaseSync } from "node:sqlite";

export interface StatsTotals {
  totalSessions: number;
  archivedSessions: number;
  runningSessions: number;
  totalMessages: number;
  todaySessions: number;
  todayMessages: number;
  weekMessages: number;
}

export interface ModelStat {
  model: string;
  sessions: number;
  messages: number;
}

export interface HeatmapPoint {
  date: string;      // YYYY-MM-DD (local)
  messages: number;
  sessions: number;
  level: 0 | 1 | 2 | 3 | 4;
}

export interface SessionStats {
  totals: StatsTotals;
  byModel: ModelStat[];
  heatmap: HeatmapPoint[];
}

function isoDay(ts: string | null): string | null {
  if (!ts) return null;
  return ts.slice(0, 10);
}

// TTL 结果缓存（§2.4 服务端红线配套）：stats 聚合 25 万行级 100-500ms，统计面板打开频繁——
// 同一索引（dbPath）+ 同 days 在 TTL 内直接复用结果；索引重建/归档后最多滞后 TTL 30s。
const statsCache = new Map<string, { at: number; result: SessionStats }>();
const STATS_TTL_MS = 30_000;

export function computeStatsCached(db: DatabaseSync, cacheKey: string, runningSessionIds: string[], days = 365): SessionStats {
  const key = cacheKey + "|" + days;
  const hit = statsCache.get(key);
  if (hit && Date.now() - hit.at < STATS_TTL_MS) return hit.result;
  const result = computeStats(db, runningSessionIds, days);
  statsCache.set(key, { at: Date.now(), result });
  return result;
}

export function computeStats(db: DatabaseSync, runningSessionIds: string[], days = 365): SessionStats {
  const totals = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM sessions) AS totalSessions,
       (SELECT COUNT(*) FROM sessions WHERE archived = 1) AS archivedSessions,
       (SELECT COUNT(*) FROM messages WHERE role IN ('user','assistant')) AS totalMessages,
       (SELECT COUNT(*) FROM sessions WHERE modified >= ?) AS todaySessions,
       (SELECT COUNT(*) FROM messages WHERE ts >= ? AND role IN ('user','assistant')) AS todayMessages,
       (SELECT COUNT(*) FROM messages WHERE ts >= ? AND role IN ('user','assistant')) AS weekMessages`,
  ).get(dayStart(-0), dayStart(-0), dayStart(-6)) as {
    totalSessions: number;
    archivedSessions: number;
    totalMessages: number;
    todaySessions: number;
    todayMessages: number;
    weekMessages: number;
  };

  // runningSessions 只统计「列表可见」的 running 会话：runningSessionIds 可能含
  // 不可见 id（如嵌套 fork 子代理：有独立 jsonl 文件、bridged/TUI 在跑，但列表扫描
  // 不扫 /forks/ 嵌套路径 → 无对应索引行）。直接取 length 会比实际多计（与侧栏杆
  // 的按钮/下拉口径对齐 = running ∩ db 行）。
  let runningLive = 0;
  if (runningSessionIds.length) {
    const placeholders = runningSessionIds.map(() => "?").join(",");
    const row = db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE id IN (${placeholders})`).get(...runningSessionIds) as { n: number };
    runningLive = row.n;
  }

  const byModel = (db.prepare(
    `SELECT COALESCE(model, '(unknown)') AS model, COUNT(DISTINCT session_id) AS sessions, COUNT(*) AS messages
     FROM messages WHERE model IS NOT NULL GROUP BY model ORDER BY messages DESC LIMIT 12`,
  ).all() as Array<{ model: string; sessions: number; messages: number }>);

  // Heatmap: last `days` days of local dates; 0-message days included with level 0.
  const rows = db.prepare(
    `SELECT substr(ts, 1, 10) AS day, COUNT(*) AS messages, COUNT(DISTINCT session_id) AS sessions
     FROM messages WHERE ts >= ? AND role IN ('user','assistant') GROUP BY day`,
  ).all(dayStart(-(days - 1))) as Array<{ day: string; messages: number; sessions: number }>;

  const byDay = new Map<string, { messages: number; sessions: number }>();
  for (const r of rows) byDay.set(r.day, { messages: r.messages, sessions: r.sessions });

  const heatmap: HeatmapPoint[] = [];
  const today = new Date();
  const msPerDay = 86400000;
  // collect positive counts to compute quantiles
  const positive = [...byDay.values()].map((v) => v.messages).sort((a, b) => a - b);
  const q = (p: number) => positive.length === 0 ? 0 : positive[Math.min(positive.length - 1, Math.floor(p * positive.length))];
  const thresholds = [q(0.25), q(0.5), q(0.75), positive[positive.length - 1] ?? 0];

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * msPerDay);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const v = byDay.get(key);
    const messages = v?.messages ?? 0;
    let level: 0 | 1 | 2 | 3 | 4 = 0;
    if (messages > 0) {
      if (messages >= thresholds[3]) level = 4;
      else if (messages >= thresholds[2]) level = 3;
      else if (messages >= thresholds[1]) level = 2;
      else level = 1;
    }
    heatmap.push({ date: key, messages, sessions: v?.sessions ?? 0, level });
  }
  return {
    totals: {
      ...totals,
      runningSessions: runningLive,
    },
    byModel,
    heatmap,
  };
}

function dayStart(daysAgo: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + daysAgo);
  return d.toISOString();
}
