/**
 * 页面级统一 toast 服务（pi-web.toast，2026-09-13）。
 *
 * 背景：扩展此前各自造 toast（每份组件内 state + setTimeout），宿主无统一通道。
 * 本服务让宿主（AppShell）持有右上角轻提示队列，扩展经
 * `ctx.getExtService("pi-web.toast")` 的 `show(text, opts?)` 消费——与
 * `pi-web.session` 同款「宿主提供、扩展消费」契约。
 *
 * 语义：
 *   - show(text, { ms })：入队一条 toast，默认 3s 自动消失，返回 id；
 *   - 队列支持并发多条（各自独立计时），渲染方逐个 ✕ 可关；
 *   - 渲染与订阅归宿主组件 HostToastHost（AppShell 挂载）——扩展只管 show，不管渲染。
 *
 * 注册：AppShell 模块顶层 `registerExtClientService("pi-web", "pi-web.toast", …)`
 * ——早于任何扩展 client materialize（模块顶层副作用先于 effect 阶段）。
 */

export interface HostToastOptions {
  /** 自动消失毫秒数，默认 3000。传 0 表示不自动消失（手动 ✕ 关闭）。 */
  ms?: number;
}

export interface HostToastItem {
  id: number;
  text: string;
  ms: number;
}

export interface HostToastService {
  /** 入队一条 toast，返回 id。 */
  show(text: string, opts?: HostToastOptions): number;
  /** 立即移除指定 toast（渲染方 ✕ 按钮用）。 */
  dismiss(id: number): void;
}

let toasts: HostToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of [...listeners]) {
    try { l(); } catch { /* 订阅方错误不阻断 */ }
  }
}

/** 当前 toast 队列（渲染方 useSyncExternalStore 快照；返回引用，变化时整体换新数组）。 */
export function getToasts(): HostToastItem[] {
  return toasts;
}

/** 订阅队列变化（增/减）；返回退订函数。 */
export function subscribeToasts(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** 移除指定 toast（不存在时无害）。 */
export function dismissToast(id: number): void {
  if (!toasts.some((t) => t.id === id)) return;
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

/** ctx 服务实现（AppShell 注册 key `pi-web.toast` 用）。 */
export const piWebToastService: HostToastService = {
  show(text, opts) {
    const ms = opts?.ms ?? 3000;
    const id = nextId++;
    toasts = [...toasts, { id, text, ms }];
    emit();
    if (ms > 0) {
      setTimeout(() => dismissToast(id), ms);
    }
    return id;
  },
  dismiss: dismissToast,
};
