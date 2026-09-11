/**
 * 恢复项提供者注册表（契约类型见 lib/composer/types.ts）。
 *
 * P2 草稿簇等把「残留输入」作为恢复项并入队列恢复对话框：扩展注册 provider，
 * ChatWindow 合成 recoveryItems 时经 useRecoveryProviderItems() 并入（≤5 行接入）。
 * 订阅语义与 React useSyncExternalStore 对齐：getItems 需稳定引用（内容不变时
 * 返回同一数组），subscribe 在 items 可能变化时通知。
 */
import { useSyncExternalStore } from "react";
import type { RecoveryItemsProvider } from "./types";

export type { RecoveryItemsProvider };

const providers: RecoveryItemsProvider[] = [];
const listeners = new Set<() => void>();
let cached: unknown[] = [];

function invalidate(): void {
  const out: unknown[] = [];
  for (const p of providers) {
    try {
      out.push(...p.getItems());
    } catch (e) {
      console.warn(`[composer] recovery provider "${p.id}" getItems failed:`, e);
    }
  }
  cached = out;
  for (const l of listeners) l();
}

/** 注册恢复项提供者；返回 disposer。items 变化时自动重聚合。 */
export function registerRecoveryItemsProvider(p: RecoveryItemsProvider): () => void {
  providers.push(p);
  const unsub = p.subscribe?.(() => invalidate());
  invalidate();
  return () => {
    const i = providers.indexOf(p);
    if (i >= 0) providers.splice(i, 1);
    unsub?.();
    invalidate();
  };
}

/** 全部提供者的 items 扁平聚合（ChatWindow 合成恢复列表用）。 */
export function getRecoveryProviderItems(): unknown[] {
  return cached;
}

/** React 订阅：providers 或其 items 变化时重渲染。 */
export function useRecoveryProviderItems(): readonly unknown[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => cached,
    () => [],
  );
}

/** 测试辅助：清空全部状态（生产代码勿调）。 */
export function resetRecoveryProvidersForTests(): void {
  providers.length = 0;
  listeners.clear();
  cached = [];
}

/**
 * 用户决议路由：把 id 按前缀分发给拥有它的 provider（kept/discarded）。
 * ChatWindow 的恢复对话框对未知来源的 id 调这里；无人认领的 id 原样返回。
 */
export function routeRecoveryResolve(kept: string[], discarded: string[]): { kept: string[]; discarded: string[] } {
  const byOwner = (id: string) => providers.find((p) => id.startsWith(`${p.id}:`));
  const groups = new Map<RecoveryItemsProvider, { kept: string[]; discarded: string[] }>();
  const bucket = (id: string, kind: "kept" | "discarded") => {
    const owner = byOwner(id);
    if (!owner?.onResolve) return false;
    let g = groups.get(owner);
    if (!g) { g = { kept: [], discarded: [] }; groups.set(owner, g); }
    g[kind].push(id);
    return true;
  };
  const rest = { kept: kept.filter((id) => !bucket(id, "kept")), discarded: discarded.filter((id) => !bucket(id, "discarded")) };
  for (const [p, g] of groups) {
    try {
      p.onResolve!(g.kept, g.discarded);
    } catch (e) {
      console.warn(`[composer] recovery provider "${p.id}" onResolve failed:`, e);
    }
  }
  return rest;
}
