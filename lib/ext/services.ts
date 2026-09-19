/**
 * ExtServicesRegistry — the ctx.services locator kernel (dependency-injection plan §4-A,
 * decided 2026-09-06).
 *
 * A simple service locator: Map<key, {extId, impl}> + up/down events + event-driven
 * require waits. No topological sorting / PENDING fibers / lifecycle-rollback kernel
 * (§2 review conclusion — extensions can be disabled by the user at any time, absence
 * is a first-class citizen; get + degrade is the normal path).
 *
 * - Key contract: "<extId>.<name>"; core validates the prefix on provide
 *   (anti-impersonation; core presets use extId "core"). Re-providing the same key
 *   = replacement within the same extension.
 * - Reload rollback: when an extension shuts down, the registry calls revokeExt(ext.id)
 *   to unregister all of its services and broadcast down; waiters are not rejected on
 *   down (the service may come back) — only timeout rejects.
 * - require is event-driven: hit returns immediately; a miss suspends a waiter that
 *   provide resolves — zero polling.
 */
export type ServicePhase = "up" | "down";
export type ServiceChangeListener = (key: string, phase: ServicePhase) => void;

export interface ServiceRecord {
  extId: string;
  impl: unknown;
}

/** One row of the service listing (registry.status service visibility §7-7; consumed by the extension-manager panel). */
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
   * Provide a service. The key must start with "<extId>." (otherwise throws, anti-impersonation).
   * Returns a disposer (idempotent; removes only if the slot still holds this registration's
   * impl — guards against a stale disposer clobbering a later registrant).
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

  /** Soft dependency: undefined when absent. */
  get<T = unknown>(key: string): T | undefined {
    return this.services.get(key)?.impl as T | undefined;
  }

  /** Hard dependency: hit returns immediately; a miss suspends a waiter for provide (event-driven), timeout rejects. */
  require<T = unknown>(key: string, timeoutMs: number = DEFAULT_REQUIRE_TIMEOUT_MS): Promise<T> {
    const cur = this.services.get(key);
    if (cur) return Promise.resolve(cur.impl as T);
    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter = { resolve: resolve as (impl: unknown) => void, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.get(key)?.delete(waiter);
        reject(new Error(`[ext.services] require("${key}") timed out after ${timeoutMs}ms — service was never provided`));
      }, timeoutMs);
      if (!this.waiters.has(key)) this.waiters.set(key, new Set());
      this.waiters.get(key)!.add(waiter);
    });
  }

  /** Subscribe to up/down. Returns an unsubscribe function. */
  onChange(cb: ServiceChangeListener): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Reload rollback: unregister every service provided by one extension (broadcasting down per key). Returns the removed keys. */
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

  /** Clear everything (registry.shutdown end-of-reload-cycle): broadcast down per key; waiters are kept (timeout is the backstop). */
  clear(): void {
    for (const key of [...this.services.keys()]) {
      this.services.delete(key);
      this.emit(key, "down");
    }
  }

  /** Service listing (key + provider; status service visibility §7-7). */
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
      try { cb(key, phase); } catch { /* listener errors must not break the emit loop */ }
    }
  }
}

/** Key contract validation: must have the "<extId>.<name>" prefix (anti-impersonation). Core presets use extId = "core". */
export function assertServiceKey(extId: string, key: string): void {
  if (typeof key !== "string" || key.length === 0 || !key.startsWith(extId + ".") || key === extId + ".") {
    throw new Error(`[ext.services] key must start with the "<extId>." prefix (anti-impersonation): ${extId} attempted to provide "${key}"`);
  }
}
