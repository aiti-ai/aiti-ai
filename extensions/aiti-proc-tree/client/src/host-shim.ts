/**
 * host-shim — JSX client bundle host bridge (shared template, proc-tree copy).
 *
 * vite aliases react / react/jsx-runtime to this shim so JSX components compile
 * against the host rendering primitives passed via register(ctx).
 *
 * Usage: entry.tsx register(ctx) calls `__setCtx(ctx)` first (before any JSX render).
 */

// Module-level ctx (set at register time; read during component render).
let _ctx: Record<string, unknown> | null = null;
export function __setCtx(ctx: Record<string, unknown>): void { _ctx = ctx; }

function c<T = (...args: never[]) => unknown>(name: string): T {
  return (_ctx?.[name] as T) ?? (() => undefined as never);
}

// ---------- react-compatible exports (esbuild alias react → this shim) ----------
export const Fragment = (typeof Symbol !== "undefined" && Symbol.for) ? Symbol.for("react.fragment") : 0xacb;
export function createElement(...args: unknown[]): unknown {
  return c("h").call(null, ...args);
}
// Automatic runtime jsx(type, props, key) — merge the standalone key back into
// props (host h() = React.createElement whose 3rd param is children, not key).
function mergeKey(args: unknown[]): unknown[] {
  const [type, props, key, ...rest] = args;
  if (props && typeof props === "object") {
    const merged: Record<string, unknown> = { ...(props as Record<string, unknown>) };
    if (key !== undefined && key !== null) merged.key = key;
    return [type, merged, ...rest];
  }
  return args;
}
export const jsx = (...args: unknown[]) => createElement(...mergeKey(args));
export const jsxs = (...args: unknown[]) => {
  const props = (args as [unknown, { children?: unknown } | undefined, ...unknown[]])[1];
  const children = props?.children;
  if (Array.isArray(children)) {
    for (const ch of children) {
      if (ch && typeof ch === "object" && (ch as { _store?: { validated?: number } })._store) {
        (ch as { _store: { validated: number } })._store.validated = 1;
      }
    }
  }
  return createElement(...mergeKey(args));
};

// ---------- React hooks delegation ----------
export const useState = <T>(init: T | (() => T)) => c<(...a: unknown[]) => [T, (v: T | ((prev: T) => T)) => void]>("useState")(init);
export const useEffect = (fn: () => void | (() => void), deps?: unknown[]) => c("useEffect")(fn, deps);
export const useRef = <T>(v: T) => c<(...a: unknown[]) => { current: T }>("useRef")(v);
export const useCallback = <T extends (...args: never[]) => unknown>(fn: T, deps: unknown[]) => c<(...a: unknown[]) => T>("useCallback")(fn, deps);
export const useMemo = <T>(fn: () => T, deps: unknown[]) => c<(fn: () => T, deps: unknown[]) => T>("useMemo")(fn, deps);

// ---------- host util delegation ----------
/** apiUrl(p): join a relative path into the full API URL under the current basePath. */
export function apiUrl(p: string): string {
  const fn = _ctx?.apiUrl as ((p: string) => string) | undefined;
  return typeof fn === "function" ? fn(p) : p;
}
/** t(key, params?): extension i18n translation (ui.i18n tables in index.ts). */
export function t(key: string, params?: Record<string, unknown>): string {
  const fn = _ctx?.t as ((key: string, params?: Record<string, unknown>) => string) | undefined;
  return typeof fn === "function" ? fn(key, params) : key;
}
/** extFeatures(): the extension's feature-state map (id → value); empty on old hosts. */
export function extFeatures(): Record<string, unknown> {
  const fn = _ctx?.getFeatures as (() => Record<string, unknown>) | undefined;
  try { return (typeof fn === "function" && fn()) || {}; } catch { return {}; }
}
/** onFeatureChange(fn): subscribe to feature edits; returns an unsubscribe function. */
export function onFeatureChange(fn: () => void): () => void {
  const fn2 = _ctx?.onFeatureChange as ((cb: () => void) => () => void) | undefined;
  if (typeof fn2 === "function") { try { return fn2(fn); } catch { /* old host */ } }
  return () => {};
}

/** getExtService(key): cross-extension client service (DI plan P2). */
export function getExtService<T = any>(key: string): T | null {
  const fn = _ctx?.getExtService as ((k: string) => unknown) | undefined;
  try { return (typeof fn === "function" ? (fn(key) as T) : null) ?? null; } catch { return null; }
}

/** ensureMaterialized(extId): pull a lazy extension's client bundle in first. */
export function ensureMaterialized(extId: string): void {
  const fn = _ctx?.ensureMaterialized as ((id: string) => unknown) | undefined;
  try { if (typeof fn === "function") fn(extId); } catch { /* old host */ }
}

/** isMobile(): host-detected narrow layout (for compact rendering). */
export function isMobile(): boolean {
  const fn = _ctx?.useIsMobile as (() => boolean) | undefined;
  try { return typeof fn === "function" ? fn() : false; } catch { return false; }
}
