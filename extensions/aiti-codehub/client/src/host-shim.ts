/**
 * Host bridge for the JSX client bundle (vite alias maps react → this file).
 * No React is bundled: every hook / element factory is provided by pi-web.
 */
let _ctx: Record<string, any> | null = null;

export function __setCtx(ctx: Record<string, any>): void {
  _ctx = ctx;
}

function c<T = (...args: any[]) => any>(name: string): T {
  return (_ctx?.[name] as T) ?? ((() => undefined) as unknown as T);
}

/* ── React-compatible surface ── */
export const Fragment = typeof Symbol !== "undefined" && Symbol.for ? Symbol.for("react.fragment") : 0xacb;

export function createElement(...args: unknown[]): unknown {
  return c("h").call(null, ...args);
}

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
// jsxs (static multiple children): mark each child element as validated so React's
// dev runtime does not warn about keys for arrays passed through custom components
// (e.g. <Btn><Icon/> label</Btn>). Mirrors the automatic runtime's behavior.
export const jsxs = (...args: unknown[]) => {
  const props = (args as [unknown, { children?: unknown } | undefined, ...unknown[]])[1];
  const children = props?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      if (child && typeof child === "object" && (child as { _store?: { validated?: number } })._store) {
        (child as { _store: { validated: number } })._store.validated = 1;
      }
    }
  }
  return createElement(...mergeKey(args));
};

export const useState = <T>(init: T | (() => T)) => c<(...a: unknown[]) => [T, (v: T | ((p: T) => T)) => void]>("useState")(init);
export const useEffect = (fn: () => unknown, deps?: unknown[]) => c("useEffect")(fn, deps);
export const useLayoutEffect = (fn: () => unknown, deps?: unknown[]) => c("useLayoutEffect")(fn, deps);
export const useRef = <T>(v: T) => c<(...a: unknown[]) => { current: T }>("useRef")(v);
export const useCallback = <T extends (...args: any[]) => unknown>(fn: T, deps: unknown[]) => c<(...a: unknown[]) => T>("useCallback")(fn, deps);
export const useMemo = <T>(fn: () => T, deps: unknown[]) => c<(...a: unknown[]) => T>("useMemo")(fn, deps);
export const useSyncExternalStore = <T>(sub: (cb: () => void) => () => void, get: () => T) => c<(...a: unknown[]) => T>("useSyncExternalStore")(sub, get);

/* ── host utilities ── */
export function apiUrl(p: string): string {
  const fn = _ctx?.apiUrl as ((p: string) => string) | undefined;
  return typeof fn === "function" ? fn(p) : p;
}

export function t(key: string, params?: Record<string, unknown>): string {
  const fn = _ctx?.t as ((k: string, p?: Record<string, unknown>) => string) | undefined;
  return typeof fn === "function" ? fn(key, params) : key;
}

export function getLocale(): string {
  const fn = _ctx?.getLocale as (() => string) | undefined;
  return typeof fn === "function" ? fn() : "en";
}

export function createPortal(children: unknown, container: Element | null): unknown {
  const fn = _ctx?.createPortal as ((c: unknown, el: Element | null) => unknown) | undefined;
  return typeof fn === "function" ? fn(children, container) : children;
}

export function extSvc<T = unknown>(key: string): T | undefined {
  const fn = _ctx?.getExtService as ((k: string) => T | undefined) | undefined;
  if (typeof fn !== "function") return undefined;
  try {
    return fn(key);
  } catch {
    return undefined;
  }
}

export function regSvc<T = unknown>(key: string, impl: T): (() => void) | null {
  const fn = _ctx?.registerExtService as ((k: string, i: T) => () => void) | undefined;
  if (typeof fn !== "function") return null;
  try {
    return fn(key, impl);
  } catch {
    return null;
  }
}

export function ensureMaterialized(id: string): Promise<boolean> {
  const fn = _ctx?.ensureMaterialized as ((id: string) => Promise<boolean>) | undefined;
  if (typeof fn !== "function") return Promise.resolve(false);
  try {
    return Promise.resolve(fn(id)).catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

/** Subscribe to the shared event bus (null when the bus extension is absent). */
export function subscribeBus(handler: (frame: any) => void, topics: string[]): (() => void) | null {
  const svc = extSvc<(h: (f: any) => void, t: string[]) => { off: () => void }>("aiti-event-bus.subscribe-topics");
  if (typeof svc !== "function") return null;
  try {
    const sub = svc(handler, topics);
    return sub?.off ?? null;
  } catch {
    return null;
  }
}

/** Send a message through the host chat path (same hooks as user input). */
export function sendChat(text: string, mode: "steer" | "followUp" = "followUp"): boolean {
  const fn = _ctx?.sendChatMessage as ((t: string, m: string) => void) | undefined;
  if (typeof fn !== "function") return false;
  try { fn(text, mode); return true; } catch { return false; }
}

/** Prefill the composer through the host composer service (no send). The service
 * is a capability query ("get(name)") per host-ui-contract — fields are not
 * exposed as direct properties. */
export function setComposer(text: string): boolean {
  const svc = extSvc<{ get?: (name: string) => unknown }>("pi-web.composer");
  const setInput = svc?.get?.("setInputValue") as ((t: string) => void) | undefined;
  const focus = svc?.get?.("focusComposer") as (() => void) | undefined;
  if (typeof setInput !== "function") return false;
  try { setInput(text); focus?.(); return true; } catch { return false; }
}

/** Open a session through the host session service. */
export function openSession(id: string): void {
  const svc = extSvc<{ open?: (id: string) => void }>("pi-web.session");
  try { svc?.open?.(id); } catch { /* ignore */ }
}

/** Stage the fresh new-session composer for a cwd (the host New button's final action —
 * no session is created until the user sends). Returns false on hosts without the service. */
export function stageNewSession(cwd: string): boolean {
  const svc = extSvc<{ setCwd?: (p: string) => void }>("pi-web.newSession");
  if (typeof svc?.setCwd !== "function" || !cwd) return false;
  try { svc.setCwd(cwd); return true; } catch { return false; }
}

/** Current session cwd (authoritative host source, falling back to the page global).
 *  Also consults pi-web.newSession.getCwd: on the new-session welcome page there is no
 *  open session, but a staged workspace cwd is already selected. */
export function currentCwd(): string {
  try {
    const svc = extSvc<{ get?: () => { session?: { cwd?: string } | null } }>("pi-web.session");
    const cwd = svc?.get?.()?.session?.cwd;
    if (cwd) return cwd;
  } catch { /* ignore */ }
  try {
    const staged = extSvc<{ getCwd?: () => string | null }>("pi-web.newSession")?.getCwd?.();
    if (staged) return String(staged);
  } catch { /* ignore */ }
  try { return String((globalThis as any).__piWebCwd || ""); } catch { return ""; }
}

/** Open a folder in the host's right-panel folder viewer. */
export function openFolder(path: string, name?: string): boolean {
  const fn = _ctx?.openFolder as ((p: string, n?: string) => unknown) | undefined;
  if (typeof fn !== "function") return false;
  try { void fn(path, name); return true; } catch { return false; }
}

/** Open a file in the host editor (editing/saving handled by aiti-editor). */
export function openFile(path: string, name?: string): boolean {
  const fn = _ctx?.openFile as ((p: string, n?: string) => unknown) | undefined;
  if (typeof fn !== "function") return false;
  try { void fn(path, name); return true; } catch { return false; }
}
