/**
 * ASR 用量 / 流量统计（云引擎计费口径）—— docs/aiti-ai-input-asr-provider-plan.md
 *
 * 记什么：每个引擎**按天（本地日）**的 请求数 / 音频时长 / 错误数 / 模式拆分 / 最近使用；
 *         可选单价（元/分钟）→ 估算费用。
 * 存哪里：`stateDir/asr-usage.json`（不可再生数据 → state 层；宿主未给 stateDir 时回退 `<configDir>/state`）。
 *
 * 口径：
 *   - `quick`（VAD 分句每句）/ `final`（松手整段精修）/ `vad`（真流式会话）：每次请求计 1 次；
 *   - 音频时长 = PCM 字节 / 32000（16k/16bit 单声道），非 wav（如 webm 兑底）为估算值；
 *   - 本地日（与 aiti-ai-usage 的 localDay 同口径），旧 UTC 日键在首次写入时按「当日 12:00Z → 本地日」迁移；
 *   - 只保留最近 90 天，写盘时滚动清理。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const SCHEMA_V = 2;             // 1 = UTC 日 + 无模式维度；2 = 本地日 + byMode
const KEEP_DAYS = 90;

export interface ModeRow { requests: number; seconds: number }
export interface DayRow { requests: number; seconds: number; errors: number; byMode?: Record<string, ModeRow> }
interface UsageFile {
  v?: number;
  days: Record<string, Record<string, DayRow>>;   // "YYYY-MM-DD"（本地日） → provider → 行
  price: Record<string, number>;                  // 元/分钟（可选，0/缺省 = 不估算）
  lastAt: Record<string, number>;                 // provider → 最近一次时间戳
}

let usageDir = "";
export function setUsageDir(dir: string): void { if (dir) usageDir = dir; }

export function usageFile(): string {
  const base = usageDir || join(homedir(), ".pi", "web", "data", "aiti-ai-input", "state");
  return join(base, "asr-usage.json");
}

/** 由 asr-config.json 路径推导（桥模块里没有 ctx 时用） */
export function setUsageDirFromConfig(configPath: string): void {
  try { setUsageDir(join(dirname(configPath), "state")); } catch { /* ignore */ }
}

/** 本地日（YYYY-MM-DD）——与 aiti-ai-usage 的 daily 口径一致，避免跨时区错一天 */
export function localDay(d: Date | number): string {
  const t = typeof d === "number" ? new Date(d) : d;
  const y = t.getFullYear();
  const m = String(t.getMonth() + 1).padStart(2, "0");
  const dd = String(t.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function emptyRow(): DayRow { return { requests: 0, seconds: 0, errors: 0, byMode: {} }; }

function load(): UsageFile {
  let raw: Partial<UsageFile> | null = null;
  try { raw = JSON.parse(readFileSync(usageFile(), "utf8") || "{}") as Partial<UsageFile>; } catch { raw = null; }
  if (!raw || typeof raw !== "object") return { v: SCHEMA_V, days: {}, price: {}, lastAt: {} };
  const days: Record<string, Record<string, DayRow>> = {};
  for (const [day, rows] of Object.entries(raw.days && typeof raw.days === "object" ? raw.days : {})) {
    // v1（UTC 日键）迁移：把该日 12:00Z 映射到本地日后合并
    const key = (raw.v || 1) < SCHEMA_V && /^\d{4}-\d{2}-\d{2}$/.test(day)
      ? localDay(Date.parse(`${day}T12:00:00Z`))
      : day;
    const bucket = days[key] ||= {};
    for (const [pid, r] of Object.entries(rows || {})) {
      const cur = bucket[pid] ||= emptyRow();
      cur.requests += Number(r?.requests || 0);
      cur.seconds += Number(r?.seconds || 0);
      cur.errors += Number(r?.errors || 0);
      for (const [mode, mr] of Object.entries(r?.byMode || {})) {
        const m = (cur.byMode ||= {})[mode] ||= { requests: 0, seconds: 0 };
        m.requests += Number(mr?.requests || 0);
        m.seconds += Number(mr?.seconds || 0);
      }
    }
  }
  return {
    v: SCHEMA_V,
    days,
    price: raw.price && typeof raw.price === "object" ? raw.price : {},
    lastAt: raw.lastAt && typeof raw.lastAt === "object" ? raw.lastAt : {},
  };
}

function save(data: UsageFile): void {
  try {
    mkdirSync(dirname(usageFile()), { recursive: true });
    // 滚动清理：只保留最近 KEEP_DAYS 天
    const keepFrom = localDay(Date.now() - (KEEP_DAYS - 1) * 86400000);
    for (const day of Object.keys(data.days)) if (day < keepFrom) delete data.days[day];
    const tmp = usageFile() + ".tmp";
    writeFileSync(tmp, JSON.stringify({ ...data, v: SCHEMA_V }, null, 2), "utf8");
    renameSync(tmp, usageFile());
  } catch { /* 统计失败不影响识别主链路 */ }
}

export interface UsageRecord {
  provider: string;
  mode?: string;          // quick / final / vad
  seconds?: number;
  ok: boolean;
  error?: string;
}

export function recordUsage(o: UsageRecord): void {
  try {
    const data = load();
    const day = localDay(Date.now());
    const row = (data.days[day] ||= {})[o.provider] ||= emptyRow();
    row.requests += 1;
    row.seconds += Math.max(0, Number(o.seconds || 0));
    if (!o.ok) row.errors += 1;
    const mode = o.mode || "other";
    const m = (row.byMode ||= {})[mode] ||= { requests: 0, seconds: 0 };
    m.requests += 1;
    m.seconds += Math.max(0, Number(o.seconds || 0));
    data.lastAt[o.provider] = Date.now();
    save(data);
  } catch { /* ignore */ }
}

/** 汇总（全期） */
function aggregate(days: Record<string, Record<string, DayRow>>): Record<string, DayRow> {
  const totals: Record<string, DayRow> = {};
  for (const rows of Object.values(days)) {
    for (const [pid, r] of Object.entries(rows)) {
      const t = totals[pid] ||= emptyRow();
      t.requests += r.requests || 0;
      t.seconds += r.seconds || 0;
      t.errors += r.errors || 0;
      for (const [mode, mr] of Object.entries(r.byMode || {})) {
        const m = (t.byMode ||= {})[mode] ||= { requests: 0, seconds: 0 };
        m.requests += mr.requests || 0;
        m.seconds += mr.seconds || 0;
      }
    }
  }
  return totals;
}

export function readUsage(): {
  ok: true; today: string;
  todayRows: Record<string, DayRow>; totals: Record<string, DayRow>;
  price: Record<string, number>; lastAt: Record<string, number>;
} {
  const data = load();
  const day = localDay(Date.now());
  return {
    ok: true, today: day,
    todayRows: data.days[day] || {},
    totals: aggregate(data.days),
    price: data.price || {},
    lastAt: data.lastAt || {},
  };
}

/** 趋势：最近 n 天，按天 × 引擎（含模式拆分）+ 全期汇总 */
export function readSeries(nDays: number): {
  ok: true; today: string; days: Array<{ day: string; providers: Record<string, DayRow> }>;
  totals: Record<string, DayRow>; price: Record<string, number>; lastAt: Record<string, number>;
} {
  const data = load();
  const n = Math.max(1, Math.min(365, Number(nDays) || 30));
  const out: Array<{ day: string; providers: Record<string, DayRow> }> = [];
  for (let i = n - 1; i >= 0; i--) {
    const day = localDay(Date.now() - i * 86400000);
    out.push({ day, providers: data.days[day] || {} });
  }
  return {
    ok: true, today: localDay(Date.now()), days: out,
    totals: aggregate(data.days), price: data.price || {}, lastAt: data.lastAt || {},
  };
}

export function setUsagePrice(prices: Record<string, unknown>): Record<string, number> {
  const data = load();
  for (const [k, v] of Object.entries(prices)) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) { delete data.price[k]; continue; }
    data.price[k] = n;
  }
  save(data);
  return data.price;
}

export function resetUsage(): void { save({ v: SCHEMA_V, days: {}, price: load().price, lastAt: {} }); }
