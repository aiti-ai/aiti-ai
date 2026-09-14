/**
 * home 目录的客户端单例（跨扩展共享，开页请求去重）。
 *
 * 开页有多个消费面会拉 `/api/home`（宿主回退侧栏、session-manager、aiti-folder…），
 * 此前各自 fetch（有的只做扩展内 dedupe，跨扩展仍是多次网络请求）。这里收口为
 * 进程内单例：一次 fetch + 结果缓存 + 订阅广播；宿主经 `pi-web.home` 客户端服务
 * 下发给扩展（`ctx.getExtService("pi-web.home")`），扩展不再自己发请求。
 *
 * 「用到才拉」：只有 `ensure()` 被调用（首个真的需要 ~ 缩写的消费面）才发请求。
 */
import { apiUrl } from "./base-path";

/** 客户端服务暴露形状（扩展侧消费）。 */
export interface HomeDirService {
  /** 同步读已缓存值（未就绪返回 null）。 */
  get(): string | null;
  /** 拉取一次（in-flight 合流）；失败返回 null（调用方回退完整路径展示）。 */
  ensure(): Promise<string | null>;
}

let homeDir: string | null = null;
let inflight: Promise<string | null> | null = null;
const subs = new Set<(dir: string | null) => void>();

export function getHomeDir(): string | null {
  return homeDir;
}

export function ensureHomeDir(): Promise<string | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (homeDir) return Promise.resolve(homeDir);
  if (inflight) return inflight;
  const p = fetch(apiUrl("/api/home"))
    .then((r) => (r.ok ? r.json() : null))
    .then((j: { home?: unknown } | null) => {
      if (j && typeof j.home === "string" && j.home) {
        homeDir = j.home;
        for (const cb of [...subs]) {
          try { cb(homeDir); } catch { /* 订阅方错误不影响其他 */ }
        }
      }
      return homeDir;
    })
    .catch(() => null)
    .finally(() => { inflight = null; });
  inflight = p;
  return p;
}

/** 订阅 home 目录到位（返回退订；未触发 ensure——是否需要由消费方决定）。 */
export function subscribeHomeDir(cb: (dir: string | null) => void): () => void {
  subs.add(cb);
  return () => { subs.delete(cb); };
}

/** 下发给扩展的客户端服务实现。 */
export const homeDirService: HomeDirService = { get: getHomeDir, ensure: ensureHomeDir };
