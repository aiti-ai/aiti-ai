/**
 * StickyRouter — 通用粘性路由器（pi-models-combo v0.3）。
 *
 * 一套状态机服务两层粘性（同一 ProxyServer）：
 *   - 组合层：client+虚拟模型 → 扁平化槽位索引（成员×key）
 *   - key 层：client → apiKeys 索引
 *
 * 键 = per-session 关联键（shortClient(runToken)，与多 key 的 client 归属一致）。
 * 语义：命中且目标健康且 TTL 内 → 沿用；否则清除并由调用方重新选择。
 * LRU 上限防内存增长；过期清理是惰性的（请求时顺带），无定时器——遵守无轮询约定。
 */
export class StickyRouter {
  #ttlMs: number;
  #cap: number;
  #map = new Map<string, { idx: number; lastUsed: number }>();

  constructor({ ttlMin = 15, cap = 1000 }: { ttlMin?: number; cap?: number } = {}) {
    const t = Number(ttlMin);
    this.#ttlMs = (Number.isFinite(t) && t > 0 ? t : 15) * 60_000;
    this.#cap = Math.max(1, Math.floor(cap) || 1000);
  }

  /** 取走指针：命中返回 {idx}；TTL 过期或不健康则清除并返回原指针（prevIdx，
   *   switch 事件归因需要「从哪切走」）与清除原因。 */
  take(client: string, healthy: (idx: number) => boolean): { idx?: number; prevIdx?: number; clearReason?: "ttl" | "unhealthy" } {
    const e = this.#map.get(client);
    if (!e) return {};
    const expired = Date.now() - e.lastUsed > this.#ttlMs;
    const unfit = !healthy(e.idx);
    if (expired || unfit) {
      this.#map.delete(client);
      return { prevIdx: e.idx, clearReason: !expired && unfit ? "unhealthy" : "ttl" };
    }
    return { idx: e.idx };
  }

  /** 命中返回粘住的索引（TTL 内 + healthy(idx) 为真），否则清除指针并返回 undefined。 */
  get(client: string, healthy: (idx: number) => boolean): number | undefined {
    return this.take(client, healthy).idx;
  }

  /** 只读查看最近指针（不判健康/TTL、不清除）——switch 事件归因用。 */
  peek(client: string): number | undefined {
    return this.#map.get(client)?.idx;
  }

  /** 记录/刷新指针（delete+set 维持 LRU 新鲜度）。 */
  set(client: string, idx: number): void {
    this.#map.delete(client);
    this.#map.set(client, { idx, lastUsed: Date.now() });
    while (this.#map.size > this.#cap) {
      const oldest = this.#map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#map.delete(oldest);
    }
  }

  get size(): number {
    return this.#map.size;
  }

  /** 活跃指针分布（idx → 绑定数；容量内全部键）。状态面板「当前粘住」画像用。 */
  bindings(): Map<number, number> {
    const out = new Map<number, number>();
    for (const [, v] of this.#map) {
      out.set(v.idx, (out.get(v.idx) ?? 0) + 1);
    }
    return out;
  }

  /** 清空全部指针（config 变更后槽位索引可能位移，粘性指向不再可靠——直接重置最安全）。 */
  clear(): void {
    this.#map.clear();
  }
}
