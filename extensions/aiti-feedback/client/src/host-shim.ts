/**
 * host-shim — host bridge for JSX client bundles (shared template file).
 *
 * Why it exists: browsers don't understand JSX, so an extension client must be
 * precompiled by esbuild (vite lib mode). esbuild's automatic JSX runtime
 * (jsx: "automatic") generates `jsx(type, props)` calls that point at React by
 * default — but pi-web extension clients are NOT React: the host passes its own
 * rendering primitives (h / useState / useEffect / apiUrl…) via register(ctx).
 *
 * So vite resolve.alias redirects react / react/jsx-runtime to this shim:
 * hooks imported from "react" in components → this shim's createElement /
 * useState / … → delegated to ctx. The bundle references zero React; the host
 * keeps a single renderer instance, and npm components written with standard
 * react hooks can be bundled in directly.
 *
 * Usage: register(ctx) in entry.tsx must call `__setCtx(ctx)` first (before any
 * JSX renders). Add fields as needed (apiUrl/t/useRef/useMemo…) as one-line
 * delegations below.
 */

// Module-level ctx (set in entry.tsx register; read at render time)
let _ctx: Record<string, unknown> | null = null;
export function __setCtx(ctx: Record<string, unknown>): void { _ctx = ctx; }

/** DI P2: read a cross-extension client service (lazy provider / absent → undefined; consumers must degrade) */
export function extSvc<T = unknown>(key: string): T | undefined {
  return (_ctx as any)?.getExtService?.(key) as T | undefined;
}

/** DI P2: register a cross-extension client service (returns disposer; null on old hosts) */
export function regSvc(key: string, impl: unknown): (() => void) | null {
  const c = _ctx as any;
  return typeof c?.registerExtService === "function" ? c.registerExtService(key, impl) : null;
}
function c<T = (...args: never[]) => unknown>(name: string): T {
  return (_ctx?.[name] as T) ?? (() => undefined as never);
}

// ---------- react-compatible exports (esbuild alias react → this shim) ----------
// React's Fragment type is Symbol.for("react.fragment") — passing it to host h()
// produces a real Fragment.
export const Fragment = (typeof Symbol !== "undefined" && Symbol.for) ? Symbol.for("react.fragment") : 0xacb;
export function createElement(...args: unknown[]): unknown {
  return c("h").call(null, ...args);
}
// Automatic runtime jsx(type, props, key) — key is a separate third argument;
// host h() = React.createElement whose third argument is **children**. Passing
// key through would treat it as a child (lost element key + key value clobbering
// props.children as real content). So merge key back into props.
function mergeKey(args: unknown[]): unknown[] {
  const [type, props, key, ...rest] = args;
  if (props && typeof props === "object") {
    // Key always merges into props; createElement always receives (type, config):
    // with key → config.key is read as the element key; undefined/null keys must
    // also strip the third argument — otherwise createElement(type, config,
    // undefined) follows legacy semantics (third arg = children) and undefined
    // clobbers props.children, wiping the whole element content (proven in the
    // field: aiti-editor ⋯ menu items with key=undefined all rendered blank).
    const merged: Record<string, unknown> = { ...(props as Record<string, unknown>) };
    if (key !== undefined && key !== null) merged.key = key;
    return [type, merged, ...rest];
  }
  return args;
}
export const jsx = (...args: unknown[]) => createElement(...mergeKey(args));
export const jsxs = (...args: unknown[]) => {
  // React automatic-runtime semantics: jsxs (static multi-children) calls
  // validateChildKeys on each child → marks _store.validated = 1 ("validated,
  // don't warn again"). Host h() = React.createElement only creates elements and
  // does not mark them — without this, static sibling children like
  // `<div><A/><B/></div>` (no key needed in JSX; the automatic runtime would
  // normally suppress the warning) trigger React's "Each child in a list should
  // have a unique key" (dev-only, deduped per owner). The value must be 1
  // (2 is a different marker and still warns).
  const props = (args as [unknown, { children?: unknown } | undefined, ...unknown[]])[1];
  const children = props?.children;
  if (Array.isArray(children)) {
    for (const c of children) {
      if (c && typeof c === "object" && (c as { _store?: { validated?: number } })._store) {
        (c as { _store: { validated: number } })._store.validated = 1;
      }
    }
  }
  return createElement(...mergeKey(args));
};

// ---------- React hooks delegation (add/remove as needed) ----------
export const useState = <T>(init: T | (() => T)) => c<(...a: unknown[]) => [T, (v: T | ((prev: T) => T)) => void]>("useState")(init);
export const useEffect = (fn: () => unknown, deps?: unknown[]) => c("useEffect")(fn, deps);
export const useRef = <T>(v: T) => c<(...a: unknown[]) => { current: T }>("useRef")(v);
export const useCallback = <T extends (...args: never[]) => unknown>(fn: T, deps?: unknown[]) => c<(...a: unknown[]) => T>("useCallback")(fn, deps);
export const useMemo = <T>(fn: () => T, deps?: unknown[]) => c<(...a: unknown[]) => T>("useMemo")(fn, deps);

// ---------- host utility delegation (add/remove as needed) ----------
/** apiUrl(p): resolve a relative path to the full API URL under the current basePath (multi-instance /dev prefix safe). */
export function apiUrl(p: string): string {
  const fn = _ctx?.apiUrl as ((p: string) => string) | undefined;
  return typeof fn === "function" ? fn(p) : p;
}
/** t(key, params?): extension i18n translation (entries from ui.i18n in index.ts). */
export function t(key: string, params?: Record<string, unknown>): string {
  const fn = _ctx?.t as ((key: string, params?: Record<string, unknown>) => string) | undefined;
  return typeof fn === "function" ? fn(key, params) : key;
}
