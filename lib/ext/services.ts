/**
 * ExtServicesRegistry — ctx.services 定位器内核（依赖注入方案 §4-A，2026-09-06 拍板）。
 *
 * 简单服务定位器：Map<key, {extId, impl}> + up/down 事件 + require 事件等待。
 * 不做拓扑排序 / PENDING fiber / 生命周期反卷内核（§2 评审结论——扩展可被用户
 * 随时禁用，缺席是一等公民；get + 降级是常态路径）。
 *
 * - key 契约："<extId>.<name>"，provide 时 core 校验前缀（防冒充；core 预置服务
 *   用 extId "core"）。同 key 重复 provide = 原扩展内替换（同扩展重提供）。
 * - reload 反卷：扩展 shutdown 时 registry 调 revokeExt(ext.id) 注销其全部服务并
 *   广播 down；waiters 不因 down 拒绝（服务可能回来），只有超时才拒绝。
 * - require 事件驱动：命中即返；未命中挂 waiter，provide 时 resolve——零轮询。
 */
export type ServicePhase = "up" | "down";
export type ServiceChangeListener = (key: string, phase: ServicePhase) => void;

export interface ServiceRecord {
  extId: string;
  impl: unknown;
}

/** 服务清单一行（registry.status 服务可见性 §7-7，extman 面板消费）。 */
export interface ServiceListEntry {
  key: string;
  extId: string;
}

interface Waiter {
  resolve: (impl: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_REQUIRE_TIMEOUT_MS = 5000;

export class ExtServicesRegistry {
  private services = new Map<string, ServiceRecord>();
  private listeners = new Set<ServiceChangeListener>();
  private waiters = new Map<string, Set<Waiter>>();

  /**
   * 提供服务。key 必须以 "<extId>." 开头（否则抛错，防冒充）。
   * 返回 disposer（幂等；仅当槽位仍是本次注册的 impl 才移除——防竞态顶掉后来者）。
   */
  provide(extId: string, key: string, impl: unknown): () => void {
    assertServiceKey(extId, key);
    const wasAbsent = !this.services.has(key);
    this.services.set(key, { extId, impl });
    if (wasAbsent) this.emit(key, "up");
    this.resolveWaiters(key);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const cur = this.services.get(key);
      if (cur && cur.extId === extId && cur.impl === impl) {
        this.services.delete(key);
        this.emit(key, "down");
      }
    };
  }

  /** 软依赖：缺席 undefined。 */
  get<T = unknown>(key: string): T | undefined {
    return this.services.get(key)?.impl as T | undefined;
  }

  /** 硬依赖：命中即返；未命中挂 waiter 等 provide（事件驱动），超时拒绝。 */
  require<T = unknown>(key: string, timeoutMs: number = DEFAULT_REQUIRE_TIMEOUT_MS): Promise<T> {
    const cur = this.services.get(key);
    if (cur) return Promise.resolve(cur.impl as T);
    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter = { resolve: resolve as (impl: unknown) => void, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.get(key)?.delete(waiter);
        reject(new Error(`[ext.services] require("${key}") 超时（${timeoutMs}ms）——服务未被 provide`));
      }, timeoutMs);
      if (!this.waiters.has(key)) this.waiters.set(key, new Set());
      this.waiters.get(key)!.add(waiter);
    });
  }

  /** 订阅 up/down。返回退订函数。 */
  onChange(cb: ServiceChangeListener): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** reload 反卷：注销某扩展提供的全部服务（逐个广播 down）。返回被注销的 key 列表。 */
  revokeExt(extId: string): string[] {
    const removed: string[] = [];
    for (const [key, rec] of this.services) {
      if (rec.extId === extId) removed.push(key);
    }
    for (const key of removed) {
      this.services.delete(key);
      this.emit(key, "down");
    }
    return removed;
  }

  /** 全量清空（registry.shutdown 重载周期收尾用）：逐个广播 down；waiters 保留（超时兜底）。 */
  clear(): void {
    for (const key of [...this.services.keys()]) {
      this.services.delete(key);
      this.emit(key, "down");
    }
  }

  /** 服务清单（key + 提供者；status 服务可见性 §7-7）。 */
  list(): ServiceListEntry[] {
    return [...this.services.entries()].map(([key, rec]) => ({ key, extId: rec.extId }));
  }

  private resolveWaiters(key: string): void {
    const set = this.waiters.get(key);
    if (!set || set.size === 0) return;
    const impl = this.services.get(key)?.impl;
    if (impl === undefined) return;
    for (const waiter of [...set]) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(impl);
    }
    this.waiters.delete(key);
  }

  private emit(key: string, phase: ServicePhase): void {
    for (const cb of [...this.listeners]) {
      try { cb(key, phase); } catch { /* 监听方错误不阻断 */ }
    }
  }
}

/** key 契约校验：必须 "<extId>.<name>" 前缀（防冒充）。core 预置服务 extId = "core"。 */
export function assertServiceKey(extId: string, key: string): void {
  if (typeof key !== "string" || key.length === 0 || !key.startsWith(extId + ".") || key === extId + ".") {
    throw new Error(`[ext.services] key 必须以 "<extId>." 前缀开头（防冒充）：${extId} 试图 provide "${key}"`);
  }
}
