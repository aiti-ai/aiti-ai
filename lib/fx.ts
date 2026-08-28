/**
 * USD→CNY 汇率服务（server 端，供 /api/fx 与扩展服务端复用）。
 *
 * 数据源链（免费、无 key）：open.er-api.com → frankfurter.app（ECB）→ 内置兜底 7.2。
 * 缓存：内存 + <dataRoot>/fx.json，TTL 24h 惰性刷新——过期后第一个请求触发更新，
 * 失败回退旧值（标 stale），不是轮询。
 *
 * 手动覆盖（固定记账汇率）：编辑 fx.json 写入 "manual": { "rate": 7.3 }，
 * 删除该字段恢复自动获取。manual 优先级最高，永不自动刷新。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { dataRoot } from "./ext/data-dir";

export interface FxSnapshot {
  /** CNY per 1 USD */
  rate: number;
  /** 来源：er-api / ecb / manual / fallback */
  source: string;
  /** 获取时间（ms epoch；manual/fallback 为 0） */
  fetchedAt: number;
  /** true = 拉取失败，返回的是过期缓存/兜底值 */
  stale?: boolean;
}

const TTL_MS = 24 * 60 * 60 * 1000;
const FALLBACK_RATE = 7.2;
const FETCH_TIMEOUT_MS = 5000;

interface FxFile {
  /** 手动覆盖；null = 自动获取。 */
  manual: { rate: number } | null;
  /** 最近一次自动获取的快照（断电/重启后的旧值回退用）。 */
  snapshot: FxSnapshot | null;
}

function fxFile(): string {
  const dir = dataRoot();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, "fx.json");
}

function readDisk(): FxFile {
  try {
    const raw = JSON.parse(readFileSync(fxFile(), "utf8")) as Partial<FxFile>;
    return {
      manual: raw.manual && typeof raw.manual.rate === "number" ? { rate: raw.manual.rate } : null,
      snapshot: raw.snapshot && typeof raw.snapshot.rate === "number" ? raw.snapshot : null,
    };
  } catch {
    return { manual: null, snapshot: null };
  }
}

function writeDisk(file: FxFile): void {
  try { writeFileSync(fxFile(), JSON.stringify(file, null, 2)); } catch { /* 只读盘等场景忽略 */ }
}

// ---------------------------------------------------------------- 拉取源

type Source = { name: string; url: string; pick: (j: any) => number | null };

const SOURCES: Source[] = [
  { name: "er-api", url: "https://open.er-api.com/v6/latest/USD", pick: (j) => num(j?.rates?.CNY) },
  { name: "ecb", url: "https://api.frankfurter.app/latest?from=USD&to=CNY", pick: (j) => num(j?.rates?.CNY) },
];

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n < 1000 ? n : null;
}

async function fetchSource(s: Source): Promise<number | null> {
  const res = await fetch(s.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: "no-store" });
  if (!res.ok) return null;
  return s.pick(await res.json());
}

// ---------------------------------------------------------------- 对外入口

let mem: FxSnapshot | null = null;
let inflight: Promise<FxSnapshot> | null = null;

/** 取当前汇率（带缓存；过期惰性刷新，并发请求共享同一次刷新）。 */
export async function getFx(): Promise<FxSnapshot> {
  const disk = readDisk();
  // 手动覆盖优先，永不刷新
  if (disk.manual) return { rate: disk.manual.rate, source: "manual", fetchedAt: 0 };

  const fresh = mem ?? disk.snapshot;
  if (fresh && Date.now() - fresh.fetchedAt < TTL_MS) return fresh;

  if (!inflight) {
    inflight = refresh(disk).finally(() => { inflight = null; });
  }
  return inflight;
}

async function refresh(disk: FxFile): Promise<FxSnapshot> {
  for (const s of SOURCES) {
    try {
      const rate = await fetchSource(s);
      if (rate != null) {
        const snap: FxSnapshot = { rate, source: s.name, fetchedAt: Date.now() };
        mem = snap;
        writeDisk({ manual: disk.manual, snapshot: snap });
        return snap;
      }
    } catch { /* 试下一个源 */ }
  }
  // 全部失败：回退过期缓存（标 stale）→ 再回退兜底常量
  const prev = mem ?? disk.snapshot;
  if (prev) return { ...prev, stale: true };
  return { rate: FALLBACK_RATE, source: "fallback", fetchedAt: 0, stale: true };
}
