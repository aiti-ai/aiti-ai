"use client";

import { useSyncExternalStore } from "react";
import { getToasts, subscribeToasts, dismissToast } from "@/lib/pi-web-toast-store";

/**
 * Host-level toast rendering (top-right queue, non-modal, auto-dismiss).
 * Consumers = the host itself (e.g. when the bridge is busy and cannot auto-name) plus messages
 * shown by extensions via the `pi-web.toast` service.
 * Supports multiple concurrent toasts (each timed independently); each can be dismissed manually
 * with the ✕ button; styled consistently with chat.clearedToast.
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
            title="Close"
            onClick={() => dismissToast(toast.id)}
            style={{ background: "none", border: "none", color: "rgba(255,255,255,0.6)", cursor: "pointer", fontSize: 13, lineHeight: 1, padding: "2px 4px", flexShrink: 0 }}
          >✕</button>
        </div>
      ))}
    </div>
  );
}