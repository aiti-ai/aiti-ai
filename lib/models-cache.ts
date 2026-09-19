import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ModelsData {
  models: Record<string, string>;
  modelList: {
    id: string; name: string; provider: string; input?: string[];
    /** Probe/runtime availability from the model-check extension: ok=available / rl=rate-limited (429) / err=other errors / unprobed=not probed (default=no data) */
    avail?: "ok" | "rl" | "err" | "unprobed";
    /** Whether this provider is rate-limited as a whole (all models currently 429) — display hint only, not auto-disabled */
    providerRL?: boolean;
  }[];
  defaultModel: { provider: string; modelId: string } | null;
  /** Resolved thinking level a new session starts with when the user has not picked one. */
  defaultThinkingLevel: string | null;
  thinkingLevels: Record<string, string[]>;
  thinkingLevelMaps: Record<string, Record<string, string | null>>;
  /** `provider/modelId` → thinking level pinned by an `enabledModels` `:level` suffix. */
  thinkingLevelPins: Record<string, string>;
  modelError?: string;
  /** Warnings from resolving the `enabledModels` scope (e.g. a pattern matched nothing). */
  modelScopeWarnings?: string[];
}

interface ModelsCacheState {
  entries: Map<string, { data: ModelsData; expiresAt: number }>;
  inFlight: Map<string, Promise<ModelsData>>;
  generation: number;
}

/** On-disk snapshot file shape (under the models-cache directory, one per cwd). */
interface ModelsDiskSnapshot {
  savedAt: number;
  data: ModelsData;
}

declare global {
  var __piModelsCacheState: ModelsCacheState | undefined;
}

const MODELS_CACHE_TTL_MS = 60_000;
const MAX_MODELS_CACHE_ENTRIES = 32;
// Disk snapshot (stale-while-revalidate): after a process restart or memory expiry, serve the
// snapshot immediately and refresh in the background, eliminating the seconds-long stall of the
// cold-start full load (createAgentSessionServices).
// Snapshot contents are only model id/name/provider/thinking levels and availability
// annotations — no keys, no sensitive paths.
const DISK_SNAPSHOT_DIR = join(
  process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
  "..", "web", "cache", "models-cache",
);
/** Snapshots within this age are considered fully fresh: returned directly, no background refresh triggered. */
const DISK_SNAPSHOT_FRESH_MS = 10 * 60_000;
/** Snapshots older than this are no longer used as a fallback (treated as absent); go through the synchronous load — guards against permanently stale data. */
const DISK_SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** Currently active snapshot directory (redirectable in tests; always DISK_SNAPSHOT_DIR in production). */
let activeSnapshotDir = DISK_SNAPSHOT_DIR;

/** Test injection point: redirects the snapshot directory (including invalidateModelsCache's deletion scope); returns a restore function. */
export function setModelsSnapshotDirForTest(dir: string): () => void {
  const prev = activeSnapshotDir;
  activeSnapshotDir = dir;
  return () => { activeSnapshotDir = prev; };
}
// Never interpolate the caught error here; SDK errors can contain paths and provider details.
const SAFE_MODEL_LOAD_FAILURE_MESSAGE = "Model list is temporarily unavailable. Check your configuration and try again.";

function getModelsCacheState(): ModelsCacheState {
  if (!globalThis.__piModelsCacheState) {
    globalThis.__piModelsCacheState = {
      entries: new Map(),
      inFlight: new Map(),
      generation: 0,
    };
  }
  return globalThis.__piModelsCacheState;
}

// ── Disk snapshot layer (synchronous small-file IO: each file <100KB, cache-friendly paths; atomic tmp+rename writes) ──

function readSnapshot(cwd: string, dir: string): ModelsDiskSnapshot | null {
  try {
    const p = join(dir, `${createHash("sha1").update(cwd).digest("hex").slice(0, 16)}.json`);
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, "utf8")) as ModelsDiskSnapshot;
    if (!raw || typeof raw.savedAt !== "number" || !raw.data || !Array.isArray(raw.data.modelList)) return null;
    return raw;
  } catch {
    return null; // corrupt/unreadable → treated as absent
  }
}

function writeSnapshot(cwd: string, data: ModelsData, dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
    const p = join(dir, `${createHash("sha1").update(cwd).digest("hex").slice(0, 16)}.json`);
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ savedAt: Date.now(), data } satisfies ModelsDiskSnapshot));
    renameSync(tmp, p);
  } catch {
    /* snapshots are best-effort: write failures don't affect the main flow */
  }
}

function deleteSnapshots(dir: string): void {
  try {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".json")) {
        try { unlinkSync(join(dir, f)); } catch { /* concurrent write/already deleted */ }
      }
    }
  } catch { /* best-effort */ }
}

export function invalidateModelsCache(): void {
  const state = getModelsCacheState();
  state.generation += 1;
  state.entries.clear();
  state.inFlight.clear();
  deleteSnapshots(activeSnapshotDir); // model config/auth changed: invalidate disk snapshots too so a stale list is never read next time
}

export function withModelRuntimeError(data: ModelsData, modelError: string | undefined): ModelsData {
  return modelError ? { ...data, modelError } : data;
}

export function withSafeModelLoadFailure(data: ModelsData): ModelsData {
  return { ...data, modelError: SAFE_MODEL_LOAD_FAILURE_MESSAGE };
}

export function loadModelsWithCache(cwd: string, loader: () => Promise<ModelsData>): Promise<ModelsData> {
  const state = getModelsCacheState();
  const cached = state.entries.get(cwd);
  if (cached) {
    if (cached.expiresAt > Date.now()) return Promise.resolve(cached.data);
    state.entries.delete(cwd);
  }

  const existingLoad = state.inFlight.get(cwd);
  if (existingLoad) return existingLoad;

  // Disk snapshot fallback (stale-while-revalidate): serve the snapshot immediately, refresh
  // in the background. Avoids a seconds-long full load blocking the first-paint model selector
  // on memory misses (restart/expiry).
  const snap = readSnapshot(cwd, activeSnapshotDir);
  if (snap) {
    const age = Date.now() - snap.savedAt;
    if (age <= DISK_SNAPSHOT_FRESH_MS) {
      state.entries.set(cwd, { data: snap.data, expiresAt: Date.now() + MODELS_CACHE_TTL_MS });
      return Promise.resolve(snap.data);
    }
    if (age <= DISK_SNAPSHOT_MAX_AGE_MS) {
      // Serve the old snapshot first, refresh in the background (inFlight dedupe prevents
      // stampedes); silent on failure — the caller already holds a usable list.
      const generationAtBgStart = state.generation;
      const bg = Promise.resolve().then(loader)
        .then((data) => {
          if (state.generation === generationAtBgStart && state.inFlight.get(cwd) === bg) {
            state.entries.set(cwd, { data, expiresAt: Date.now() + MODELS_CACHE_TTL_MS });
            writeSnapshot(cwd, data, activeSnapshotDir);
          }
          return data;
        })
        .catch(() => snap.data) // on refresh failure fall back to the old snapshot (this background call only; does not affect the immediate response above)
        .finally(() => {
          if (state.inFlight.get(cwd) === bg) state.inFlight.delete(cwd);
        });
      state.inFlight.set(cwd, bg);
      return Promise.resolve(snap.data);
    }
    // Snapshot too old → treat as absent, use the synchronous load
  }

  const generation = state.generation;
  const loadPromise: Promise<ModelsData> = Promise.resolve()
    .then(loader)
    .then((data) => {
      if (state.generation === generation && state.inFlight.get(cwd) === loadPromise) {
        const now = Date.now();
        for (const [key, entry] of state.entries) {
          if (entry.expiresAt <= now) state.entries.delete(key);
        }
        while (state.entries.size >= MAX_MODELS_CACHE_ENTRIES) {
          const oldestKey = state.entries.keys().next().value;
          if (oldestKey === undefined) break;
          state.entries.delete(oldestKey);
        }
        state.entries.set(cwd, { data, expiresAt: now + MODELS_CACHE_TTL_MS });
        writeSnapshot(cwd, data, activeSnapshotDir);
      }
      return data;
    })
    .finally(() => {
      if (state.inFlight.get(cwd) === loadPromise) state.inFlight.delete(cwd);
    });

  state.inFlight.set(cwd, loadPromise);
  return loadPromise;
}
