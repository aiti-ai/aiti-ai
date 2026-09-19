/**
 * USD→CNY exchange-rate service (server-side; reused by /api/fx and extension servers).
 *
 * Source chain (free, no key): open.er-api.com → frankfurter.app (ECB) → built-in fallback 7.2.
 * Caching: memory + <dataRoot>/fx.json, TTL 24h with lazy refresh — the first request after
 * expiry triggers an update; on failure the old value is served (marked stale). Not polling.
 *
 * Manual override (fixed accounting rate): edit fx.json and write "manual": { "rate": 7.3 };
 * delete the field to resume automatic fetching. manual has the highest priority and is never
 * auto-refreshed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { dataRoot } from "./ext/data-dir";

export interface FxSnapshot {
  /** CNY per 1 USD */
  rate: number;
  /** Source: er-api / ecb / manual / fallback */
  source: string;
  /** Fetch time (ms epoch; 0 for manual/fallback) */
  fetchedAt: number;
  /** true = fetch failed, the value served is stale cache/fallback */
  stale?: boolean;
}

const TTL_MS = 24 * 60 * 60 * 1000;
const FALLBACK_RATE = 7.2;
const FETCH_TIMEOUT_MS = 5000;

interface FxFile {
  /** Manual override; null = automatic fetching. */
  manual: { rate: number } | null;
  /** Snapshot of the most recent automatic fetch (old value used as fallback after power loss/restart). */
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
  try { writeFileSync(fxFile(), JSON.stringify(file, null, 2)); } catch { /* ignored in read-only-disk and similar situations */ }
}

// ---------------------------------------------------------------- Fetch sources

type RatesPayload = { rates?: { CNY?: unknown } } | null;
type Source = { name: string; url: string; pick: (j: RatesPayload) => number | null };

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

// ---------------------------------------------------------------- Public entry points

let mem: FxSnapshot | null = null;
let inflight: Promise<FxSnapshot> | null = null;

/** Get the current rate (cached; lazily refreshed on expiry, concurrent requests share one refresh). */
export async function getFx(): Promise<FxSnapshot> {
  const disk = readDisk();
  // Manual override wins, never refreshed
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
    } catch { /* try the next source */ }
  }
  // All sources failed: fall back to the expired cache (marked stale) → then to the fallback constant
  const prev = mem ?? disk.snapshot;
  if (prev) return { ...prev, stale: true };
  return { rate: FALLBACK_RATE, source: "fallback", fetchedAt: 0, stale: true };
}
