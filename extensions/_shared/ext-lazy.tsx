/**
 * _shared/ext-lazy.tsx — eager 扩展二次拆包的标准懒加载基建（方案
 * pi-web-eager-ext-split-plan.md §4.1）。
 *
 * 背景：eager 扩展批量包（宿主 lib/ext/client-bundle.ts v4）对「入口静态闭包含相对
 * 动态 import」的扩展（usesLazyChunks）把其静态相对 import 外置为文件 URL——扩展侧
 * 只要做「薄壳 entry + 动态 import 重模块」即可安全拆包，共享 entry chunk（host-shim、
 * _shared/*、dock 状态机）由 vite/rollup 收进共享 chunk，运行时单实例，无需 globalThis
 * 之类的兜底 hack（aiti-git-trace 旧 hack 不再需要）。
 *
 * 本模块提供两种标准接缝，扩展薄壳二选一或组合：
 *  1. createLazyModule(loader) —— 命令式接缝：用户交互处 `ref.load().then(m => m.api())`，
 *     渲染侧 `ref.useModule()` 订阅就绪（无轮询；load 幂等单例、失败复位可重试）。
 *  2. lazyExtView(opts) —— 声明式接缝：dialogs/pages 等**常挂插槽**的懒视图包装器，
 *     把「active 才 import」写死在实现里（active=false 渲染 null 且不 import）——
 *     这类插槽的 item 组件始终被渲染（关闭时返回 null），import 绝不能挂 mount（§3.3）。
 *
 * 约束（方案 §9）：
 *  - load 必须传**模块级稳定引用**（函数/同一 ref 对象）——单例缓存按引用身份（WeakMap）；
 *  - 懒 chunk 内 hooks 走共享 entry chunk 的 host-shim（rollup 自动提升，批量包已保证单实例）；
 *  - 等待一律 Promise/订阅，禁止轮询（全局规约）。
 */
import { useEffect, useState, createElement as h } from "react";

/* ── 单例 import（同 loader 引用共享一次 import；失败复位 → 下次 load 重试） ── */

const importSingletons = new WeakMap<object, { promise: Promise<Record<string, any>> | null }>();

function loadViaSingleton(key: object, load: () => Promise<Record<string, any>>): Promise<Record<string, any>> {
  let entry = importSingletons.get(key);
  if (!entry) {
    entry = { promise: null };
    importSingletons.set(key, entry);
  }
  if (!entry.promise) {
    // Promise.resolve().then 包一层：loader 里的 import() 同步抛错（路径非法等）也走异步拒绝路径
    entry.promise = Promise.resolve()
      .then(load)
      .catch((e) => {
        entry!.promise = null; // 失败复位：下次 load() 重新 import（允许重试）
        throw e;
      });
  }
  return entry.promise;
}

function defaultOnError(e: unknown): void {
  try { console.error("[ext-lazy] 懒 chunk 加载失败（下次门控开启时重试）", e); } catch { /* ignore */ }
}

/* ── 命令式接缝：懒模块引用（load 幂等 + 就绪订阅 + useModule hook） ── */

export interface LazyModuleRef<T extends Record<string, any>> {
  /** 触发加载（幂等；已就绪直接 resolve 同一模块实例；失败后调用即重试）。 */
  load(): Promise<T>;
  /** 已加载的模块实例；未就绪返回 null（同步，渲染安全）。 */
  current(): T | null;
  /** 是否已就绪。 */
  ready(): boolean;
  /** 就绪订阅：模块到达时回调（已就绪时订阅不会立即回调——调用方先查 current()）。 */
  subscribe(cb: () => void): () => void;
  /** React hook：订阅就绪状态，返回模块（未就绪 null）。必须组件顶层调用。 */
  useModule(): T | null;
}

export function createLazyModule<T extends Record<string, any>>(load: () => Promise<T>): LazyModuleRef<T> {
  let mod: T | null = null;
  let promise: Promise<T> | null = null;
  const subs = new Set<() => void>();
  const ref: LazyModuleRef<T> = {
    load() {
      if (mod) return Promise.resolve(mod);
      if (!promise) {
        promise = (Promise.resolve().then(load) as Promise<T>).then(
          (m) => {
            mod = m;
            for (const cb of [...subs]) { try { cb(); } catch { /* noop */ } }
            return m;
          },
          (e) => {
            promise = null; // 失败复位：下次 load() 重试
            throw e;
          },
        );
      }
      return promise;
    },
    current: () => mod,
    ready: () => mod != null,
    subscribe(cb) {
      subs.add(cb);
      return () => { subs.delete(cb); };
    },
    useModule() {
      const [m, setM] = useState<T | null>(() => mod);
      useEffect(() => {
        let alive = true;
        if (mod) { setM(mod); return; } // 订阅晚于就绪：补齐一次
        const unsub = ref.subscribe(() => { if (alive) setM(mod); });
        return () => { alive = false; unsub(); };
      }, []);
      return m;
    },
  };
  return ref;
}

/* ── 声明式接缝：常挂插槽的懒视图包装器 ── */

export interface LazyExtViewOpts {
  /** 门控（useGate/usePresent/open 状态/feature）。false → 渲染 null 且绝不 import。 */
  active: boolean;
  /** 懒模块加载器：模块级稳定函数，或 createLazyModule 返回的 ref（共享同一单例）。 */
  load: (() => Promise<Record<string, any>>) | LazyModuleRef<Record<string, any>>;
  /** 模块导出里取哪个作为组件。 */
  pick: string;
  /** 可选 loading 占位（默认 null；加载失败后不再显示，失败态渲染 null）。 */
  fallback?: () => unknown;
  /** 加载失败回调（默认 console.error；失败复位，下次门控开启自动重试）。 */
  onError?: (e: unknown) => void;
  /** 透传给目标组件的 props（dialogs/pages 插槽宿主会带 props）。 */
  props?: Record<string, unknown>;
}

/**
 * 在**组件渲染体内**调用（内部使用 hooks，必须无条件调用），返回元素：
 *   active=false → null（且不 import）；active=true → 触发 load()（幂等单例），
 *   就绪后 h(mod[pick], props)；加载中 fallback()?.（）默认 null；失败 onError + null。
 */
export function lazyExtView(opts: LazyExtViewOpts): unknown {
  const { active, pick, fallback, onError, props } = opts;
  // 归一化 load → thunk（ref 用对象身份做单例 key；裸函数用函数身份）
  const thunk = typeof opts.load === "function"
    ? opts.load as () => Promise<Record<string, any>>
    : () => opts.load.load();
  const singletonKey = typeof opts.load === "function" ? thunk : opts.load;

  const [mod, setMod] = useState<Record<string, any> | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    setFailed(false); // 新一轮尝试：清失败态（门控 false→true 即重试）
    loadViaSingleton(singletonKey, thunk).then(
      (m) => { if (alive) setMod(m); },
      (e) => {
        if (!alive) return;
        setFailed(true);
        (onError ?? defaultOnError)(e);
      },
    );
    return () => { alive = false; };
    // 首次 active=true 与之后每次 false→true 都会重跑本 effect（失败重试挂在这）；
    // active 持续 true 期间失败不自动重试（拒绝轮询/循环）。
  }, [active]);

  if (!active) return null;
  if (mod) {
    const Comp = mod[pick];
    if (typeof Comp === "function") return h(Comp as any, props ?? {});
    // 导出缺失按失败处理（走 onError 通道），渲染 null
    (onError ?? defaultOnError)(new Error(`[ext-lazy] 模块导出缺少 "${pick}"`));
    return null;
  }
  if (failed) return null;
  return fallback ? fallback() : null;
}

/**
 * JSX 条件渲染场景的组件形态包装（lazyExtView 的组件版）：
 *   <LazyMount active={open} load={ref} pick="DirectoryPicker" initialPath={x} .../>
 * active=false 渲染 null 且不 import；其余语义同 lazyExtView。rest props 透传目标组件。
 */
export function LazyMount({ active, load, pick, fallback, onError, ...rest }: {
  active: boolean;
  load: (() => Promise<Record<string, any>>) | LazyModuleRef<Record<string, any>>;
  pick: string;
  fallback?: () => unknown;
  onError?: (e: unknown) => void;
} & Record<string, unknown>): unknown {
  return lazyExtView({ active, load, pick, fallback, onError, props: rest });
}
