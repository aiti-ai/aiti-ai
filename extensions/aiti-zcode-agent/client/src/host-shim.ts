/**
 * host-shim — host bridge for the JSX client bundle (shared-template generic version).
 *
 * Why it exists: browsers do not understand JSX, so an extension client written in JSX must be
 * pre-built by esbuild (vite lib mode). esbuild's automatic JSX runtime (jsx: "automatic")
 * emits `jsx(type, props)` calls that target React by default. But a pi-web extension client
 * is not React — the host passes its own rendering primitives (h / useState / useEffect /
 * apiUrl…) into register(ctx).
 *
 * So vite's resolve.alias redirects react / react/jsx-runtime to this shim:
 *   components importing react hooks → this shim's createElement/useState/… → delegated to ctx.
 * The bundle carries zero React references, the host keeps a single renderer instance, and npm
 * ecosystem components (as long as they use standard react hooks) can be bundled directly.
 *
 * Usage: the first thing entry.tsx's register(ctx) does is call `__setCtx(ctx)` (before any JSX
 * rendering). Add one delegation line here per field you need (apiUrl/t/useRef/useMemo…).
 */

// Module-level ctx (set by entry.tsx register; read at component render time)
let _ctx: Record<string, unknown> | null = null;
export function __setCtx(ctx: Record<string, unknown>): void { _ctx = ctx; }

/** DI plan P2: cross-extension client service read (shim over ctx.getExtService; lazy/absent provider → undefined, consumers must degrade) */
export function extSvc<T = unknown>(key: string): T | undefined {
  return (_ctx as any)?.getExtService?.(key) as T | undefined;
}

/** DI plan P2: register a cross-extension client service (shim over ctx.registerExtService; returns a disposer, legacy hosts return null) */
export function regSvc(key: string, impl: unknown): (() => void) | null {
  const c = _ctx as any;
  return typeof c?.registerExtService === "function" ? c.registerExtService(key, impl) : null;
}
function c<T = (...args: never[]) => unknown>(name: string): T {
  return (_ctx?.[name] as T) ?? (() => undefined as never);
}

// ---------- react-compatible exports (esbuild alias react → this shim) ----------
// React's Fragment type is Symbol.for("react.fragment") — passing it to the host h produces a real Fragment.
export const Fragment = (typeof Symbol !== "undefined" && Symbol.for) ? Symbol.for("react.fragment") : 0xacb;
export function createElement(...args: unknown[]): unknown {
  return c("h").call(null, ...args);
}
// The automatic runtime jsx(type, props, key) takes key as a separate third argument; the host's
// h() = React.createElement whose third argument is **children**. Passing it through would treat
// key as a child (element key lost + the key value overwriting props.children as content). Key
// must therefore be merged back into props.
function mergeKey(args: unknown[]): unknown[] {
  const [type, props, key, ...rest] = args;
  if (props && typeof props === "object") {
    // key is always merged into props; createElement always receives (type, config):
    // with key → config.key is read by React as the element key; undefined/null key → the third
    // argument must still be dropped — otherwise createElement(type, config, undefined) applies
    // legacy semantics (third arg = children) and undefined overwrites props.children, wiping the
    // element content (observed: aiti-editor ⋯ menu items with key=undefined all rendered blank).
    const merged: Record<string, unknown> = { ...(props as Record<string, unknown>) };
    if (key !== undefined && key !== null) merged.key = key;
    return [type, merged, ...rest];
  }
  return args;
}
export const jsx = (...args: unknown[]) => createElement(...mergeKey(args));
export const jsxs = (...args: unknown[]) => {
  // React automatic-runtime semantics: jsxs (static multi-child) calls validateChildKeys on each
  // child at creation → marks _store.validated = 1 ("already validated, skip the warning"). The
  // host's h() is React.createElement, which only creates the element and does not set that flag —
  // without patching it, static sibling lists like `<div><A/><B/></div>` (no key needed in JSX;
  // the automatic runtime would normally suppress the warning) get a false "Each child in a list
  // should have a unique key" from React (dev-only, deduped once per owner). The value must be 1
  // (2 is a different flag that still warns).
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

// ---------- Host utility delegation (add/remove as needed) ----------
/** apiUrl(p): resolve a relative path into the full API URL under the current basePath (multi-instance /dev prefix safe). */
export function apiUrl(p: string): string {
  const fn = _ctx?.apiUrl as ((p: string) => string) | undefined;
  return typeof fn === "function" ? fn(p) : p;
}
/** t(key, params?): extension i18n lookup (entries from index.ts ui.i18n). */
export function t(key: string, params?: Record<string, unknown>): string {
  const fn = _ctx?.t as ((key: string, params?: Record<string, unknown>) => string) | undefined;
  return typeof fn === "function" ? fn(key, params) : key;
}
