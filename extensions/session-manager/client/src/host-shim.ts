/**
 * host-shim —— JSX client bundle 的宿主桥（共享模板通用版）。
 *
 * 为什么需要它：浏览器不认识 JSX，扩展 client 要写 JSX 必须经过 esbuild 预编译
 * （vite lib mode）。esbuild 的 JSX 自动运行时（jsx: "automatic"）会生成
 * `jsx(type, props)` 调用，默认指向 React。但 pi-web 的扩展 client 不是 React——
 * 宿主经 register(ctx) 传入的是自己的渲染原语（h / useState / useEffect / apiUrl…）。
 *
 * 所以这里用 vite 的 resolve.alias 把 react / react/jsx-runtime 重定向到本 shim：
 *   组件里 import react 的 hooks → 本 shim 的 createElement/useState/… → 委托 ctx。
 * 产物里零 React 引用，宿主保持单渲染实例，npm 生态组件（只要用标准 react hooks）
 * 也能直接打包进来用。
 *
 * 使用：entry.tsx 的 register(ctx) 里第一件事调 `__setCtx(ctx)`（任何 JSX 渲染前）。
 * 需要的字段（apiUrl/t/useRef/useMemo…）按需在这里加一行委托即可。
 */

// 模块级 ctx（entry.tsx 的 register 时设置；组件渲染时读取）
let _ctx: Record<string, unknown> | null = null;
export function __setCtx(ctx: Record<string, unknown>): void { _ctx = ctx; }
/** 当前 ctx（宿主注册时注入；渲染前始终已设置）。 */
export function getCtx(): Record<string, unknown> | null { return _ctx; }
function c<T = (...args: never[]) => unknown>(name: string): T {
  return (_ctx?.[name] as T) ?? (() => undefined as never);
}

// ---------- react 兼容导出（esbuild alias react → 本 shim） ----------
// React 的 Fragment 类型是 Symbol.for("react.fragment")——传给宿主 h 即生成真 Fragment。
export const Fragment = (typeof Symbol !== "undefined" && Symbol.for) ? Symbol.for("react.fragment") : 0xacb;
export function createElement(...args: unknown[]): unknown {
  return c("h").call(null, ...args);
}
// 自动运行时 jsx(type, props, key)——key 是独立第三参；宿主 h() = React.createElement
// 的第三参是 **children**。直接透传会把 key 当子元素（元素 key 丢失 + key 值覆盖
// props.children 成为真实内容）。因此必须把 key 合并回 props。
function mergeKey(args: unknown[]): unknown[] {
  const [type, props, key, ...rest] = args;
  if (props && typeof props === "object") {
    // key 一律合并进 props，createElement 恒收 (type, config) 两参：
    // 有 key → config.key 由 React 读为元素 key；key 为 undefined/null → 也必须剥掉第三参——
    // 否则 createElement(type, config, undefined) 按 legacy 语义（第三参=children）用 undefined
    // 覆盖 props.children，元素内容整体丢失（实证：aiti-editor ⋯ 菜单 key=undefined 的项全部空白）。
    const merged: Record<string, unknown> = { ...(props as Record<string, unknown>) };
    if (key !== undefined && key !== null) merged.key = key;
    return [type, merged, ...rest];
  }
  return args;
}
export const jsx = (...args: unknown[]) => createElement(...mergeKey(args));
export const jsxs = (...args: unknown[]) => {
  // React 自动运行时语义：jsxs（静态多子元素）创建时会对每个子元素调用
  // validateChildKeys → 标记 _store.validated = 1（"已校验，勿再告警"）。宿主 h()
  // 是 React.createElement，但它只创建元素、不做这个标记——不补的话，
  // `<div><A/><B/></div>` 这类“静态兄弟元素”（JSX 里无需写 key，React 自动运行时
  // 本应抑制该警告）会被 React 误报 “Each child in a list should have a unique key”
  // （dev-only，按 owner 去重一次）。值必须是 1（2 是另一特殊标记，仍会告警）。
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

// ---------- React hooks 委托（按需增删） ----------
export const useState = <T>(init: T | (() => T)) => c<(...a: unknown[]) => [T, (v: T | ((prev: T) => T)) => void]>("useState")(init);
export const useEffect = (fn: () => unknown, deps?: unknown[]) => c("useEffect")(fn, deps);
export const useLayoutEffect = (fn: () => unknown, deps?: unknown[]) => c("useLayoutEffect")(fn, deps);
export const useRef = <T>(v: T) => c<(...a: unknown[]) => { current: T }>("useRef")(v);
export const useCallback = <T extends (...args: never[]) => unknown>(fn: T, deps?: unknown[]) => c<(...a: unknown[]) => T>("useCallback")(fn, deps);
export const useMemo = <T>(fn: () => T, deps?: unknown[]) => c<(...a: unknown[]) => T>("useMemo")(fn, deps);
// -- SidebarClone（宿主 SessionSidebar 复制版）及其宿主模块链所需：统一委托宿主真 hooks --
export const useContext = <T,>(ctx: T): T => c<(c: T) => T>("useContext")(ctx);
export const useReducer = (fn: (s: any, a: any) => any, init: any, initArg?: any) => c<(...a: unknown[]) => [any, (a: any) => void]>("useReducer")(fn, init, initArg);
export const useSyncExternalStore = (sub: () => () => void, get: () => unknown, getServer?: () => unknown) => c<(...a: unknown[]) => unknown>("useSyncExternalStore")(sub, get, getServer);
export const useImperativeHandle = (ref: unknown, fn: () => unknown, deps?: unknown[]) => c<(...a: unknown[]) => void>("useImperativeHandle")(ref, fn, deps);
export const useId = () => c<() => string>("useId")();
export function createContext<T>(defaultValue: T) {
  return { __smI18nCtx: true as const, defaultValue } as any;
}
export const forwardRef = <T,>(fn: T) => c<(f: T) => T>("forwardRef")(fn);
export const memo = <T,>(fn: T) => c<(f: T) => T>("memo")(fn);
export class Component<P = {}, S = any> {
  props: P = (undefined as unknown) as P;
  state: S = (undefined as unknown) as S;
  // react-dom mount class 实例时会把渲染器的 updater 挂到 instance.updater——
  // setState/forceUpdate 必须经它，否则跨 bundle class 组件的状态更新失效
  setState(partial: any, callback?: () => void): void {
    (this as any).updater?.enqueueSetState(this, partial, callback, "setState");
  }
  forceUpdate(callback?: () => void): void {
    (this as any).updater?.enqueueForceUpdate(this, callback, "forceUpdate");
  }
  render(_props: P, _state: S): unknown { return null; }
}
// react-dom 靠该标记区分 class/function 组件——缺失会被当函数调用（"cannot be invoked without new"）
(Component.prototype as any).isReactComponent = {};

/**
 * createPortal(children, container) —— React portal 委托（宿主 ctx.createPortal）。
 * 用于把 fixed 覆盖层（管理弹窗遮罩等）渲染到 document.body，彻底脱离下拉动画的
 * transform 祖先（containing block 会困住 position:fixed 子元素）。宿主缺省不提供
 * 时兑底返回 children（元素原地渲染，行为同无 portal——不崩）。
 */
export function createPortal(children: unknown, container: Element | DocumentFragment): unknown {
  const fn = _ctx?.createPortal as ((c: unknown, el: Element | DocumentFragment) => unknown) | undefined;
  return typeof fn === "function" ? fn(children, container) : children;
}

// ---------- 宿主工具委托（按需增删） ----------
/** apiUrl(p)：把相对路径拼成当前 basePath 下的完整 API URL（多实例 /dev 前缀安全）。 */
export function apiUrl(p: string): string {
  const fn = _ctx?.apiUrl as ((p: string) => string) | undefined;
  return typeof fn === "function" ? fn(p) : p;
}
/** t(key, params?)：扩展 i18n 翻译（index.ts ui.i18n 里的词条）。 */
export function t(key: string, params?: Record<string, unknown>): string {
  const fn = _ctx?.t as ((key: string, params?: Record<string, unknown>) => string) | undefined;
  return typeof fn === "function" ? fn(key, params) : key;
}
/** openFile(path, fileName)：宿主打开文件标签页（AppShell 原样能力，aiti-editor 接管渲染）。 */
export function openFile(path: string, fileName?: string): void {
  const fn = _ctx?.openFile as ((p: string, f?: string) => void) | undefined;
  if (typeof fn === "function") fn(path, fileName);
}
/** getLocale()：当前 UI 语言（Intl 相对时间等格式化用；跟随宿主语言设置）。 */
export function getLocale(): string {
  const fn = _ctx?.getLocale as (() => string) | undefined;
  return typeof fn === "function" ? fn() : (typeof navigator !== "undefined" ? navigator.language : "en");
}
/** renderSlot(name, props)：渲染宿主扩展插槽（返回宿主 ExtSlot 元素，嵌进本扩展树）。 */
export function renderSlot(name: string, props?: { currentSession?: unknown; extra?: Record<string, unknown> }): unknown {
  const fn = _ctx?.renderSlot as ((n: string, p?: unknown) => unknown) | undefined;
  return typeof fn === "function" ? fn(name, props) : null;
}
/** getExtProvides()：全部扩展 ui.provides 声明集合（session-delete 让位判断等）。 */
export function getExtProvides(): Set<string> {
  const fn = _ctx?.getExtProvides as (() => Set<string>) | undefined;
  return typeof fn === "function" ? fn() : new Set<string>();
}
/** getFeatures()：扩展声明的 features 当前生效状态（extman 开关即时反映；缺省空对象=全部视为启用）。 */
export function getFeatures(): Record<string, boolean | string> {
  const fn = _ctx?.getFeatures as (() => Record<string, boolean | string>) | undefined;
  return typeof fn === "function" ? fn() : {};
}
/** onFeatureChange(cb)：订阅 features 变更（extman 切换即触发；返回退订函数）。 */
export function onFeatureChange(cb: () => void): () => void {
  const fn = _ctx?.onFeatureChange as ((cb: () => void) => () => void) | undefined;
  return typeof fn === "function" ? fn(cb) : () => {};
}
/** getExtService(key)：读跨扩展客户端服务（缺席 undefined——提供方懒加载未就绪时降级）。 */
export function getExtService<T>(key: string): T | undefined {
  const fn = _ctx?.getExtService as ((k: string) => T | undefined) | undefined;
  return typeof fn === "function" ? fn(key) : undefined;
}
/** onExtServiceChange(cb)：订阅跨扩展服务上/下线（返回退订函数）。 */
export function onExtServiceChange(cb: (key: string, phase: "up" | "down") => void): () => void {
  const fn = _ctx?.onExtServiceChange as ((cb: (key: string, phase: "up" | "down") => void) => () => void) | undefined;
  return typeof fn === "function" ? fn(cb) : () => {};
}
/** ensureMaterialized(id)：确保某懒扩展 client 已物化（幂等；sidebarContent 挂载时拉起 aiti-folder）。 */
export function ensureMaterialized(id: string): Promise<boolean> {
  const fn = _ctx?.ensureMaterialized as ((id: string) => Promise<boolean>) | undefined;
  return typeof fn === "function" ? fn(id) : Promise.resolve(false);
}
