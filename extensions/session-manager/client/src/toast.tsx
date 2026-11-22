/**
 * toast —— 轻量非模态提示（ToastHost + showToast）。
 *
 * 用途：桥占用无法自动命名等「操作已降级但用户需要知道原因」的场景——
 * 右上角浮现一条原因说明，自动消失，不打断操作（区别于 confirm-dialog 的模态）。
 *
 * 模块级状态 + 常驻宿主模式（同 confirm-dialog / tag-popover）：showToast 任意组件调用；
 * ToastHost 在 entry.tsx dialogs 槽挂一份。新 toast 顶掉旧 toast；超时用 id 守卫，
 * 不会把后到的 toast 提前清掉。
 */
import { useState, useEffect } from "react";
import { getCtx } from "./host-shim";

const toastState = {
  current: null as null | { id: number; text: string },
  subs: new Set<() => void>(),
};
function notify() { for (const l of toastState.subs) l(); }

let toastSeq = 0;

/**
 * 弹出非模态提示（右上角，ms 毫秒后自动消失，默认 3s）。
 * 宿主有统一 `pi-web.toast` 服务时优先走它（单渲染器，多扩展共存不叠加）；
 * 旧宿主未提供时回落本地 ToastHost（fallback，保底可用）。
 */
export function showToast(text: string, ms = 3000): void {
  const host = getCtx()?.getExtService?.("pi-web.toast") as
    { show?: (t: string, o?: { ms?: number }) => unknown } | undefined;
  if (host?.show) {
    try { host.show(text, { ms }); return; } catch { /* 回落本地 */ }
  }
  toastSeq += 1;
  toastState.current = { id: toastSeq, text };
  notify();
  setTimeout(() => {
    if (toastState.current?.id === toastSeq) {
      toastState.current = null;
      notify();
    }
  }, ms);
}

export function ToastHost() {
  const [cur, setCur] = useState(toastState.current);
  useEffect(() => {
    const l = () => setCur(toastState.current);
    toastState.subs.add(l);
    return () => { toastState.subs.delete(l); };
  }, []);
  if (!cur) return null;
  return (
    <div
      style={{
        position: "fixed", top: 14, right: 14, zIndex: 2147483700,
        display: "flex", alignItems: "center", gap: 8,
        maxWidth: "min(420px, calc(100vw - 28px))",
        background: "rgba(24,24,27,0.95)", border: "1px solid rgba(255,255,255,0.14)",
        borderRadius: 10, boxShadow: "0 10px 32px rgba(0,0,0,0.4)",
        padding: "9px 12px", fontSize: 12, color: "rgba(255,255,255,0.95)",
        lineHeight: 1.45, cursor: "default",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <span style={{ fontSize: 13, flexShrink: 0 }}>ℹ️</span>
      <span style={{ minWidth: 0 }}>{cur.text}</span>
      <button
        aria-label="close"
        title="关闭"
        onClick={(e) => { e.stopPropagation(); toastState.current = null; notify(); }}
        style={{
          background: "none", border: "none", color: "rgba(255,255,255,0.6)",
          cursor: "pointer", fontSize: 13, lineHeight: 1, padding: "2px 4px", flexShrink: 0,
        }}
      >✕</button>
    </div>
  );
}