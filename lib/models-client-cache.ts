/**
 * 客户端模型列表缓存（localStorage，按 cwd 分槽）。
 *
 * 动机：/api/models 的结果在首屏与切换会话时都要重新加载，而浏览器主线程常被
 * 扩展脚本/首帧渲染占满——请求发出晚（实测页面加载后 3.7s 才发）、响应到达更晚
 * （外网实测单次 0.6~5.8s），模型名/默认模型迟迟不显示。
 * 这里缓存最近一次成功响应：`loadModels` 挂载时先同步回放缓存
 * （stale-while-revalidate），网络结果到达后再覆盖刷新——模型名列即挂即显，
 * 无需等待请求往返。
 *
 * 缓存内容仅为模型 id/名称/provider/thinking 档位等展示数据（与 /api/models
 * 响应同形，无 key 无本地路径）。best-effort：存储不可用/超限/损坏全部静默降级
 * （与 workspace-memory 同风格）；单一 cwd 槽位超 MAX_BYTES 不写（异常膨胀防御）。
 *
 * 失效：写满 MAX_ENTRIES 按最后写入时间 LRU 淘汰；超过 MAX_AGE_MS 的槽位读取时
 * 视为不存在（并顺手删除）；模型配置变更（`pi-web:models-changed`）由调用方
 * `clearCachedModels()` 全清。
 */

const KEY_PREFIX = "pi-web:models-cache:";
const INDEX_KEY = `${KEY_PREFIX}__index__`;
/** 槽位超过此年龄视为无效（与 /api/models 服务端磁盘快照的上限一致）。 */
export const MODELS_CLIENT_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** 最多保留的 cwd 槽位数（LRU 淘汰）。 */
export const MODELS_CLIENT_CACHE_MAX_ENTRIES = 8;
/** 单槽位序列化上限：超过不写（防御异常膨胀把 localStorage 填满）。 */
export const MODELS_CLIENT_CACHE_MAX_BYTES = 256 * 1024;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 缓存条目的最小结构校验：不足即视为无缓存（调用方拿到的一定是可用形状）。 */
interface CachedModelsShape {
  models: Record<string, string>;
  modelList: unknown[];
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function cacheKeyFor(cwd: string): string {
  // 空 cwd（服务端 process.cwd() 语义）也占一个稳定槽位。
  return `${KEY_PREFIX}${cwd || "@default"}`;
}

function readIndex(storage: StorageLike): Record<string, number> {
  try {
    const raw = storage.getItem(INDEX_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function removeSlot(storage: StorageLike, cwd: string, index: Record<string, number>): void {
  try {
    storage.removeItem(cacheKeyFor(cwd));
  } catch {
    // ignore
  }
  delete index[cwd];
}

function pruneIndex(storage: StorageLike, index: Record<string, number>): void {
  const keys = Object.keys(index);
  if (keys.length <= MODELS_CLIENT_CACHE_MAX_ENTRIES) return;
  keys
    .sort((a, b) => (index[a] ?? 0) - (index[b] ?? 0))
    .slice(0, keys.length - MODELS_CLIENT_CACHE_MAX_ENTRIES)
    .forEach((key) => removeSlot(storage, key, index));
}

/**
 * 读取并回放某 cwd 的缓存。不存在/过期/损坏 → null（过期槽位顺手删除）。
 */
export function readCachedModels<T>(cwd: string, storage: StorageLike | null = getBrowserStorage()): T | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(cacheKeyFor(cwd));
    if (!raw) return null;
    const entry = JSON.parse(raw) as { savedAt?: unknown; data?: unknown };
    const savedAt = typeof entry?.savedAt === "number" ? entry.savedAt : 0;
    if (!entry?.data || typeof entry.data !== "object") return null;
    if (Date.now() - savedAt > MODELS_CLIENT_CACHE_MAX_AGE_MS) {
      const index = readIndex(storage);
      removeSlot(storage, cwd, index);
      try {
        storage.setItem(INDEX_KEY, JSON.stringify(index));
      } catch {
        // ignore
      }
      return null;
    }
    const data = entry.data as Partial<CachedModelsShape>;
    // 形状校验不足即弃：让调用方永远拿到可用结构（models 映射 + modelList 数组）。
    if (!data.models || typeof data.models !== "object" || !Array.isArray(data.modelList)) return null;
    return data as T;
  } catch {
    return null;
  }
}

/**
 * 写入某 cwd 的缓存（覆盖旧值）。超限/损坏/存储不可用静默忽略。
 */
export function writeCachedModels(cwd: string, data: unknown, storage: StorageLike | null = getBrowserStorage()): void {
  if (!storage) return;
  try {
    const payload = JSON.stringify({ savedAt: Date.now(), data });
    if (payload.length > MODELS_CLIENT_CACHE_MAX_BYTES) return;
    storage.setItem(cacheKeyFor(cwd), payload);
    const index = readIndex(storage);
    index[cwd] = Date.now();
    pruneIndex(storage, index);
    storage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    // quota / 隐私模式 / 不可用 —— 缓存是 best-effort
  }
}

/**
 * 最近写入缓存的 cwd（LRU 最新的槽位），无缓存/索引损坏 → null。
 * 供 AppShell 在真实 cwd 就绪前预热模型列表（用户绝大多数访问都回到上次的项目）。
 */
export function readMostRecentCachedCwd(storage: StorageLike | null = getBrowserStorage()): string | null {
  if (!storage) return null;
  try {
    const index = readIndex(storage);
    let best: string | null = null;
    let bestAt = -1;
    for (const [cwd, at] of Object.entries(index)) {
      if (at > bestAt) {
        bestAt = at;
        best = cwd;
      }
    }
    if (best === null) return null;
    return best;
  } catch {
    return null;
  }
}

/**
 * 清空所有槽位（模型配置变更广播时调用，避免下次回放过期列表）。
 */
export function clearCachedModels(storage: StorageLike | null = getBrowserStorage()): void {
  if (!storage) return;
  try {
    const index = readIndex(storage);
    for (const cwd of Object.keys(index)) {
      try {
        storage.removeItem(cacheKeyFor(cwd));
      } catch {
        // ignore
      }
    }
    storage.removeItem(INDEX_KEY);
  } catch {
    // ignore
  }
}
