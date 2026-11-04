// 加载窗口级 fetch 去重（方案 docs/pi-web-load-duplicate-requests-analysis.md §3.1/§3.4；pi-web 宿主侧同款在 pi-web lib/dedupe-fetch.ts）。
//
// 只读 GET 的「单飞 + 微缓存」：同 URL 并发请求共享 in-flight promise；成功响应在
// ttlMs 内直接复用。覆盖的是组件重挂/桌面移动双实例/多消费面在秒级窗口内的重复
// 请求——不改变任何轮询/SSE 契约（SSE 仍是权威源，兜底快照旧 2~3s 无碍）。
//
// 只套「只读、no-store、幂等」的 GET（/api/home、/api/agent/running、*/status 类）；
// 带写语义或每次必须新鲜的请求不要走这里。

const DEFAULT_TTL_MS = 2_500;

interface CacheEntry {
  /** 解决到**未消费**的原始 Response——clone 分支从这里 tee 出去 */
  promise: Promise<Response>;
  /** 缓存过期时刻（成功响应才设置；0 = 还在飞/失败不缓存） */
  freshUntil: number;
}

const inflight = new Map<string, CacheEntry>();

export interface DedupeFetchOptions extends RequestInit {
  /** 成功响应的微缓存时长（默认 2.5s，仅覆盖加载窗口） */
  ttlMs?: number;
}

/**
 * dedupeFetch(url, {ttlMs})：同 URL 并发共享一次网络请求，每个调用方拿各自的
 * Response 克隆（原始 body 永不直接外泄，谁先 .json() 都不影响别人）。
 * - in-flight 合流：第二个并发调用者与首个共享同一次网络往返；
 * - TTL 微缓存：成功（res.ok）响应在 ttlMs 内的新调用零网络直接复用；
 * - 失败响应不缓存（下一个调用者立即重试），只解除 in-flight。
 */
export function dedupeFetch(url: string, options?: DedupeFetchOptions): Promise<Response> {
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  const hit = inflight.get(url);
  // 仍在飞（freshUntil=0）或缓存新鲜 → 共享；过期才真拉新请求
  if (hit && (hit.freshUntil === 0 || Date.now() < hit.freshUntil)) return hit.promise.then((r) => r.clone());
  const promise = fetch(url, options).then((res) => {
    const entry = inflight.get(url);
    if (entry && entry.promise === promise) {
      // 成功：标记缓存到期时刻；失败：不留缓存（下次调用真拉）
      if (res.ok) entry.freshUntil = Date.now() + ttlMs;
      else inflight.delete(url);
    }
    return res;
  }).catch((err) => {
    const entry = inflight.get(url);
    if (entry && entry.promise === promise) inflight.delete(url);
    throw err;
  });
  inflight.set(url, { promise, freshUntil: 0 });
  return promise.then((r) => r.clone());
}

/** 测试钩子：清空全部缓存态。 */
export function resetDedupeFetch(): void {
  inflight.clear();
}
