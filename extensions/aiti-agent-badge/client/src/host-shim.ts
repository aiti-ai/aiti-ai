/**
 * host-shim — JSX runtime bridge for this extension's client bundle.
 *
 * The host passes its own render primitives (h / hooks / apiUrl / t) through
 * register(ctx); vite aliases react and react/jsx-runtime here so the bundle
 * contains no React import and shares the host's single renderer.
 */
let _ctx: any = null;

export function __setCtx(ctx: any): void {
  _ctx = ctx;
}

export function getCtx() {
  return _ctx;
}

function call(name: string): any {
  return _ctx?.[name] ?? (() => undefined);
}

export const Fragment = (typeof Symbol !== "undefined" && Symbol.for) ? Symbol.for("react.fragment") : 0xacb;

export function createElement(...args: any[]): any {
  return call("h")(...args);
}

function mergeKey(args: any[]): any[] {
  const [type, props, key, ...rest] = args;
  if (props && typeof props === "object") {
    const merged = { ...props };
    if (key !== undefined && key !== null) merged.key = key;
    return [type, merged, ...rest];
  }
  return args;
}

export const jsx = (...args: any[]): any => createElement(...mergeKey(args));
export const jsxs = (...args: any[]): any => {
  const props = args[1];
  const children = props?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      if (child && typeof child === "object" && child._store) child._store.validated = 1;
    }
  }
  return createElement(...mergeKey(args));
};

export const useState = (init: any): any => call("useState")(init);
export const useEffect = (fn: any, deps?: any): any => call("useEffect")(fn, deps);
export const useLayoutEffect = (fn: any, deps?: any): any => call("useLayoutEffect")(fn, deps);
export const useRef = (init: any): any => call("useRef")(init);
export const useCallback = (fn: any, deps?: any): any => call("useCallback")(fn, deps);
export const useMemo = (fn: any, deps?: any): any => call("useMemo")(fn, deps);

export function apiUrl(path: string): string {
  const fn = _ctx?.apiUrl;
  return typeof fn === "function" ? fn(path) : path;
}

export function t(key: string, params?: Record<string, unknown>): string {
  const fn = _ctx?.t;
  return typeof fn === "function" ? fn(key, params) : key;
}

export function getLocale(): string {
  try {
    return String(_ctx?.getLocale?.() ?? "en");
  } catch {
    return "en";
  }
}

export function extSvc<T = any>(key: string): T | undefined {
  return _ctx?.getExtService?.(key);
}

export function showToast(text: string): void {
  try {
    extSvc("pi-web.toast")?.show?.(text);
  } catch {
    /* the host toast queue is best-effort */
  }
}
