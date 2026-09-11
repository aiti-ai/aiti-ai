import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ModelsData {
  models: Record<string, string>;
  modelList: {
    id: string; name: string; provider: string; input?: string[];
    /** aiti-model-check 探测/运行期可用性：ok=可用 / rl=限流429 / err=其它错误 / unprobed=未测（缺省=无数据） */
    avail?: "ok" | "rl" | "err" | "unprobed";
    /** 该 provider 是否整体限流（全部模型当前都 429）——仅展示提示，不自动禁用 */
    providerRL?: boolean;
  }[];
  defaultModel: { provider: string; modelId: string } | null;
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

/** 磁盘快照文件形态（models-cache 目录下，每 cwd 一份）。 */
interface ModelsDiskSnapshot {
  savedAt: number;
  data: ModelsData;
}

declare global {
  var __piModelsCacheState: ModelsCacheState | undefined;
}

const MODELS_CACHE_TTL_MS = 60_000;
const MAX_MODELS_CACHE_ENTRIES = 32;
// 磁盘快照（stale-while-revalidate）：进程重启/内存过期后立即回快照、后台刷新，
// 消掉冷启动全量加载（createAgentSessionServices）的秒级卡顿。
// 快照内容只有模型 id/名称/provider/thinking levels 与可用性标注——无 key 无敏感路径。
const DISK_SNAPSHOT_DIR = join(
  process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
  "..", "web", "cache", "models-cache",
);
/** 快照在此年龄内视为完全新鲜：直接返回，不触发后台刷新。 */
const DISK_SNAPSHOT_FRESH_MS = 10 * 60_000;
/** 超过此年龄的快照不再回退使用（当作没有），走同步加载——防永久烂数据。 */
const DISK_SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** 当前生效的快照目录（测试可重定向；生产恒为 DISK_SNAPSHOT_DIR）。 */
let activeSnapshotDir = DISK_SNAPSHOT_DIR;

/** 测试注入口：重定向快照目录（含 invalidateModelsCache 的删除范围），返回恢复函数。 */
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

// ── 磁盘快照层（同步小文件读写：单文件 <100KB，路径缓存友好；写盘原子 tmp+rename）──

function readSnapshot(cwd: string, dir: string): ModelsDiskSnapshot | null {
  try {
    const p = join(dir, `${createHash("sha1").update(cwd).digest("hex").slice(0, 16)}.json`);
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, "utf8")) as ModelsDiskSnapshot;
    if (!raw || typeof raw.savedAt !== "number" || !raw.data || !Array.isArray(raw.data.modelList)) return null;
    return raw;
  } catch {
    return null; // 损坏/不可读 → 当作没有
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
    /* 快照是 best-effort：写失败不影响主流程 */
  }
}

function deleteSnapshots(dir: string): void {
  try {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".json")) {
        try { unlinkSync(join(dir, f)); } catch { /* 并发写/已被删 */ }
      }
    }
  } catch { /* best-effort */ }
}

export function invalidateModelsCache(): void {
  const state = getModelsCacheState();
  state.generation += 1;
  state.entries.clear();
  state.inFlight.clear();
  deleteSnapshots(activeSnapshotDir); // 模型配置/auth 变更：磁盘快照一并失效，避免下次读到旧列表
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

  // 磁盘快照回退（stale-while-revalidate）：立即回快照，后台刷新。
  // 内存未命中（重启/过期）时避免秒级全量加载阻塞首屏模型选择器。
  const snap = readSnapshot(cwd, activeSnapshotDir);
  if (snap) {
    const age = Date.now() - snap.savedAt;
    if (age <= DISK_SNAPSHOT_FRESH_MS) {
      state.entries.set(cwd, { data: snap.data, expiresAt: Date.now() + MODELS_CACHE_TTL_MS });
      return Promise.resolve(snap.data);
    }
    if (age <= DISK_SNAPSHOT_MAX_AGE_MS) {
      // 旧快照先用，后台刷新（inFlight 去重防风暴）；失败静默——调用方手里已有可用列表。
      const generationAtBgStart = state.generation;
      const bg = Promise.resolve().then(loader)
        .then((data) => {
          if (state.generation === generationAtBgStart && state.inFlight.get(cwd) === bg) {
            state.entries.set(cwd, { data, expiresAt: Date.now() + MODELS_CACHE_TTL_MS });
            writeSnapshot(cwd, data, activeSnapshotDir);
          }
          return data;
        })
        .catch(() => snap.data) // 刷新失败保底旧快照（仅本次后台调用，不影响上面的立即响应）
        .finally(() => {
          if (state.inFlight.get(cwd) === bg) state.inFlight.delete(cwd);
        });
      state.inFlight.set(cwd, bg);
      return Promise.resolve(snap.data);
    }
    // 快照太老 → 当作没有，走同步加载
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
