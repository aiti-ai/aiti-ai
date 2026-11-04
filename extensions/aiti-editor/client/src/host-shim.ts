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
export const useRef = <T>(v: T) => c<(...a: unknown[]) => { current: T }>("useRef")(v);
export const useCallback = <T extends (...args: never[]) => unknown>(fn: T, deps?: unknown[]) => c<(...a: unknown[]) => T>("useCallback")(fn, deps);
export const useMemo = <T>(fn: () => T, deps?: unknown[]) => c<(...a: unknown[]) => T>("useMemo")(fn, deps);

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

// ---------- 路径票据（安全基线：文件路径不进 URL，access log 不泄露路径） ----------
// 服务端票据 1h 滑动过期且扩展 reload 即整体失效——客户端缓存不能无限期复用，
// 按 expiresIn 提前 5min 过期（保守值；服务端滑动续期只会长不会短）。
type EditorTicketEntry = { ticket: string; exp: number };
const EDITOR_TICKET_CLIENT_TTL_MARGIN_MS = 5 * 60 * 1000;
const _editorTicketCache = new Map<string, EditorTicketEntry>();
const _editorTicketInflight = new Map<string, Promise<string>>();
/** aiti-editor 扩展 API 基地址（basePath 感知）。 */
export function editorBase(): string {
  return apiUrl("/api/extensions/aiti-editor");
}
/** 为文件签发/复用路径票据（服务端滑动续期 TTL 1h；force=强制换新）。 */
export async function ensureEditorTicket(filePath: string, root?: string, force = false): Promise<string> {
  if (!force) {
    const hit = _editorTicketCache.get(filePath);
    if (hit && hit.exp > Date.now()) return hit.ticket;
    if (hit) _editorTicketCache.delete(filePath);
    const inflight = _editorTicketInflight.get(filePath);
    if (inflight) return inflight;
  }
  const pr = fetch(editorBase() + "/ticket", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(root ? { filePath, root } : { filePath }),
  })
    .then((r) => r.json())
    .then((d: { ticket?: string; error?: string; expiresIn?: number }) => {
      if (!d.ticket) throw new Error(d.error || "ticket 签发失败");
      const ttl = (typeof d.expiresIn === "number" && d.expiresIn > 0 ? d.expiresIn * 1000 : 3600_000)
        - EDITOR_TICKET_CLIENT_TTL_MARGIN_MS;
      _editorTicketCache.set(filePath, { ticket: d.ticket, exp: Date.now() + Math.max(ttl, 60_000) });
      _editorTicketInflight.delete(filePath);
      return d.ticket as string;
    })
    .catch((e) => { _editorTicketInflight.delete(filePath); throw e; });
  if (!force) _editorTicketInflight.set(filePath, pr);
  return pr;
}
/** 把含 ?filePath= 的旧式端点路径改写为 /t/<ticket>/<endpoint>（其余 query 原样保留）。 */
export async function ticketedEditorPath(p: string): Promise<string> {
  const qIdx = p.indexOf("?");
  const qs = new URLSearchParams(qIdx >= 0 ? p.slice(qIdx + 1) : "");
  const path = qIdx >= 0 ? p.slice(0, qIdx) : p;
  const fp = qs.get("filePath") || qs.get("archivePath") || "";
  if (!fp) return p;
  qs.delete("filePath");
  qs.delete("archivePath");
  const ticket = await ensureEditorTicket(fp);
  const rest = qs.toString();
  return `/t/${ticket}${path}${rest ? "?" + rest : ""}`;
}
