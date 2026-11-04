/**
 * host-shim —— JSX client bundle 的宿主桥（共享模板通用版，aiti-ai-input 同款）。
 * esbuild 自动 JSX runtime → react alias → 本 shim → 委托 ctx。
 */
let _ctx: Record<string, unknown> | null = null;
export function __setCtx(ctx: Record<string, unknown>): void { _ctx = ctx; }

/** DI 方案 P2：跨扩展客户端服务读取（ctx.getExtService 的 shim 封装；提供方懒加载/缺席 → undefined，消费方必须降级） */
export function extSvc<T = unknown>(key: string): T | undefined {
  return (_ctx as any)?.getExtService?.(key) as T | undefined;
}

/** DI 方案 P2：注册跨扩展客户端服务（ctx.registerExtService 的 shim 封装；返回 disposer，旧宿主返回 null） */
export function regSvc(key: string, impl: unknown): (() => void) | null {
  const c = _ctx as any;
  return typeof c?.registerExtService === "function" ? c.registerExtService(key, impl) : null;
}
function c<T = (...args: never[]) => unknown>(name: string): T {
  return (_ctx?.[name] as T) ?? (() => undefined as never);
}

export const Fragment = (typeof Symbol !== "undefined" && Symbol.for) ? Symbol.for("react.fragment") : 0xacb;
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
// dev 模式 JSX 运行时（esbuild development 推断时发射；多余参数忽略，委托宿主 h）
export function jsxDEV(type: unknown, props: unknown, key: unknown): unknown {
  return c("h").call(null, type, { ...(props as Record<string, unknown>), key }, undefined);
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

export const useState = <T>(init: T | (() => T)) => c<(...a: unknown[]) => [T, (v: T | ((prev: T) => T)) => void]>("useState")(init);
export const useEffect = (fn: () => unknown, deps?: unknown[]) => c("useEffect")(fn, deps);
export const useRef = <T>(v: T) => c<(...a: unknown[]) => { current: T }>("useRef")(v);
export const useCallback = <T extends (...args: never[]) => unknown>(fn: T, deps?: unknown[]) => c<(...a: unknown[]) => T>("useCallback")(fn, deps);
export const useMemo = <T>(fn: () => T, deps?: unknown[]) => c<(...a: unknown[]) => T>("useMemo")(fn, deps);
export const useLayoutEffect = (fn: () => unknown, deps?: unknown[]) => c("useLayoutEffect")(fn, deps);
export function createPortal(children: unknown, container: Element | DocumentFragment): unknown {
  const fn = _ctx?.createPortal as ((c: unknown, el: Element | DocumentFragment) => unknown) | undefined;
  return typeof fn === "function" ? fn(children, container) : children;
}

/** apiUrl(p)：把相对路径拼成当前 basePath 下的完整 API URL（多实例 /dev 前缀安全）。 */
export function apiUrl(p: string): string {
  const fn = _ctx?.apiUrl as ((p: string) => string) | undefined;
  return typeof fn === "function" ? fn(p) : p;
}
/** t(key, params?)：扩展 i18n 翻译。 */
export function t(key: string, params?: Record<string, unknown>): string {
  const fn = _ctx?.t as ((key: string, params?: Record<string, unknown>) => string) | undefined;
  return typeof fn === "function" ? fn(key, params) : key;
}
