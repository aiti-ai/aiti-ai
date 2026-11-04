/**
 * host-shim —— 客户端 bundle 的宿主桥。
 *
 * 宿主（pi-web ExtSlots）把 h/useState/useEffect/.../apiUrl 经 register(ctx)
 * 传入。本 shim 在模块级持有 ctx，react 导入、useI18n、useIsMobile、apiUrl、
 * copyText 全部委托 ctx——组件源码与 pi-web 内版本零改动。
 *
 * i18n：扩展自带 messages（server/i18n.ts 打包进来），t() 按宿主语言
 * （localStorage pi-locale / document lang / 浏览器）查表 + {param} 插值。
 */

// 模块级 ctx（entry.ts register 时设置；组件 render 时读取）
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
// 的第三参是 **children**。直接透传会把 key 当子元素：① 元素 key 丢失（React 报
// missing-key 警告）；② key 值覆盖 props.children 成为真实内容（tab 按钮显示
// “ports/self/users” 而非翻译文案）。因此必须把 key 合并回 props（createElement
// 从 config.key 读 key）。
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
  // React 自动运行时语义：jsxs（静态多子元素）创建时对每个子元素调用
  // validateChildKeys → _store.validated = 1（“已校验，勿再告警”）。宿主 h() 是
  // createElement，不做此标记——不补的话 `<>{a}{b}</>` 这类 fragment 数组每次
  // 渲染都会报 “Each child in a list should have a unique key”（dev-only，按
  // owner 去重一次）。注意值必须是 1（2 是另一个特殊标记，warnForMissingKey
  // 对 2 仍然告警）。只标记直接子元素（isValidElement 语义：跳过嵌套数组），
  // 真实 keyless map 列表的警告仍然保留（map 结果数组不是 valid element）。
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
export const useState = <T>(init: T | (() => T)) => c<(...a: unknown[]) => [T, (v: T) => void]>("useState")(init);
export const useEffect = (fn: () => unknown, deps?: unknown[]) => c("useEffect")(fn, deps);
export const useRef = <T>(v: T) => c<(...a: unknown[]) => { current: T }>("useRef")(v);
export const useCallback = <T extends (...args: never[]) => unknown>(fn: T, deps?: unknown[]) => c<(...a: unknown[]) => T>("useCallback")(fn, deps);
export const useMemo = <T>(fn: () => T, deps?: unknown[]) => c<(...a: unknown[]) => T>("useMemo")(fn, deps);

// ---------- apiUrl / BASE_PATH ----------
// apiUrl 直接委托宿主 ctx（宿主 build 期内联 NEXT_PUBLIC_BASE_PATH，最准确）。
export function apiUrl(path: string): string {
  return c<(p: string) => string>("apiUrl")(path);
}
export const BASE_PATH: string = (() => {
  // 宿主 basePath 部署时页面 URL 首段即部署前缀（如 /dev/）。无法在扩展 bundle
  // 读构建期常量；用当前路径首段推断（/api、/extensions 等自身路径除外）。
  try {
    const pathname = window.location.pathname;
    const seg = pathname.split("/")[1] ?? "";
    if (seg && !["api", "extensions", "_next", "sw.js", "manifest.webmanifest"].includes(seg)) {
      return "/" + seg;
    }
  } catch { /* ignore */ }
  return "";
})();

// ---------- copyText（宿主 lib/clipboard 语义） ----------
export function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    return Promise.resolve();
  } catch {
    return Promise.reject();
  }
}

// ---------- i18n（扩展自带表 + 宿主语言） ----------
import { I18N } from "../../server/i18n";

export type Locale = "en" | "zh-CN";
export function currentLocale(): Locale {
  try {
    const stored = window.localStorage.getItem("pi-locale");
    if (stored === "en" || stored === "zh-CN") return stored;
  } catch { /* ignore */ }
  try {
    const lang = document.documentElement.lang || window.navigator.language;
    if (lang.toLowerCase().startsWith("zh")) return "zh-CN";
  } catch { /* ignore */ }
  return "en";
}

export function translate(key: string, params?: Record<string, string | number>): string {
  const table = I18N[currentLocale()] ?? I18N.en ?? {};
  let message = table[key];
  if (message === undefined && currentLocale() !== "en") message = I18N.en?.[key];
  if (message === undefined) return key;
  if (params) {
    message = message.replace(/\{([\w.-]+)\}/g, (token, name: string) => {
      const value = params[name];
      return value === undefined ? token : String(value);
    });
  }
  return message;
}

export interface I18nValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
  supportedLocales: Array<{ id: string }>;
}
export function useI18n(): I18nValue {
  return {
    locale: currentLocale(),
    setLocale: () => {},
    t: translate,
    supportedLocales: [],
  };
}

// ---------- useIsMobile（宿主 useIsMobile 语义，640px 断点） ----------
export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia("(max-width: 640px)");
    setMobile(mql.matches);
    const onChange = () => setMobile(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return mobile;
}

// ---------- 宿主文件打开（宿主公共接口 ctx.openFile 优先；无则回退 aiti_open_file postMessage） ----------
export function openFileInHost(filePath: string, fileName?: string): void {
  try {
    const openFile = _ctx?.openFile as ((p: string, n?: string) => unknown) | undefined;
    if (typeof openFile === "function") { void openFile(filePath, fileName); return; }
    window.postMessage({ __dbg: 1, type: "aiti_open_file", payload: { filePath, fileName: fileName ?? filePath.split("/").pop() ?? filePath } }, "*");
  } catch { /* ignore */ }
}
