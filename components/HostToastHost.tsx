"use client";

import { useSyncExternalStore } from "react";
import { getToasts, subscribeToasts, dismissToast } from "@/lib/pi-web-toast-store";

/**
 * 宿主统一 toast 渲染（右上角队列，非模态，自动消失）。
 * 消费方 = 宿主自身（如桥占用无法自动命名）+ 扩展经 `pi-web.toast` 服务 show 的消息。
 * 支持并发多条（各自计时）；每条可 ✕ 手动关闭；样式与 chat.clearedToast 同风格。
 */
export function HostToastHost() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  if (toasts.length === 0) return null;
  return (
    <div style={{ position: "fixed", top: 14, right: 14, zIndex: 120, display: "flex", flexDirection: "column", gap: 8 }}>
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="status"
          style={{
            display: "flex", alignItems: "center", gap: 8,
            maxWidth: "min(420px, calc(100vw - 28px))",
            background: "rgba(24,24,27,0.95)", border: "1px solid rgba(255,255,255,0.14)",
            borderRadius: 10, boxShadow: "0 10px 32px rgba(0,0,0,0.4)",
            padding: "9px 12px", fontSize: 12, color: "rgba(255,255,255,0.95)",
            lineHeight: 1.45,
          }}
        >
          <span style={{ fontSize: 13, flexShrink: 0 }}>ℹ️</span>
          <span style={{ minWidth: 0 }}>{toast.text}</span>
          <button
            type="button"
            aria-label="close"
            title="关闭"
            onClick={() => dismissToast(toast.id)}
            style={{ background: "none", border: "none", color: "rgba(255,255,255,0.6)", cursor: "pointer", fontSize: 13, lineHeight: 1, padding: "2px 4px", flexShrink: 0 }}
          >✕</button>
        </div>
      ))}
    </div>
  );
}