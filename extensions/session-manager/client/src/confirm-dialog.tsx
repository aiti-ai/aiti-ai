/**
 * 自绘确认弹窗（ConfirmDialogHost + showConfirm）——替换浏览器原生 window.confirm/alert。
 *
 * 模块级状态 + 常驻宿主模式（同 tag-ui / archive-menu）：
 *   - showConfirm(opts) 任意组件调用；ConfirmDialogHost 在 entry.tsx dialogs 槽挂一份。
 *   - opts: { title?, message, confirmLabel?, danger?, info?, onConfirm? }
 *   - info 模式：只有「知道了」按钮（替代 alert）；confirm 模式：取消 / 确认。
 *   - onConfirm 可返回 Promise；失败 throw 时错误显示在弹窗内、弹窗不关闭。
 *   - onConfirm 期间再次 showConfirm（如批量删除后的结果提示）不会被随后的关闭覆盖
 *     （以 seq 递增判断）。
 */
import { useState, useEffect, useRef } from "react";
import { t, getCtx } from "./host-shim";
import { dismissOnBack } from "../../../_shared/overlay-back-client";
import { ensureReadability } from "./helpers";

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  /** info 模式（替代 alert）：只有「知道了」按钮，无取消/确认。 */
  info?: boolean;
  onConfirm?: () => void | Promise<void>;
}

const confirmState = {
  pending: null as null | (ConfirmOptions & { seq: number }),
  subs: new Set<() => void>(),
};
function notify() { for (const l of confirmState.subs) l(); }
export function showConfirm(opts: ConfirmOptions) {
  confirmState.pending = { ...opts, seq: (confirmState.pending?.seq ?? 0) + 1 };
  notify();
}
export function closeConfirm() {
  confirmState.pending = null;
  notify();
}

export function ConfirmDialogHost() {
  const [pending, setPending] = useState(confirmState.pending);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const l = () => setPending(confirmState.pending);
    confirmState.subs.add(l);
    return () => { confirmState.subs.delete(l); };
  }, []);

  // 小屏系统返回 = 关闭确认弹窗（等同取消/知道了；busy 中不关，避免打断异步确认）
  const busyRef = useRef(busy);
  useEffect(() => { busyRef.current = busy; }, [busy]);
  useEffect(() => {
    if (!pending) return;
    return dismissOnBack(
      () => (getCtx() as any)?.getExtService?.("pi-web.overlayBack"),
      () => { if (!busyRef.current) closeConfirm(); },
    );
  }, [pending]);

  if (!pending) return null;
  const { title, message, confirmLabel, danger, info, onConfirm } = pending;

  const confirm = async () => {
    if (busy) return;
    if (!onConfirm) { closeConfirm(); return; } // info 模式：点击即关
    setBusy(true);
    setErr(null);
    try {
      await onConfirm();
      // onConfirm 期间可能已弹新弹窗（seq 递增，如批量删除结果提示）——不覆盖
      if (confirmState.pending?.seq === pending.seq) closeConfirm();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      onClick={() => { if (!busy) closeConfirm(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 2147483600,
        background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(380px, 92vw)", background: "var(--bg-panel)", border: "1px solid var(--border)",
          borderRadius: 12, boxShadow: "0 16px 50px rgba(0,0,0,0.45)", padding: "16px 18px",
          display: "flex", flexDirection: "column", gap: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 700, color: "var(--text)" }}>
          <span style={{ fontSize: 15 }}>{danger ? "🗑️" : info ? "ℹ️" : "⚠️"}</span>
          <span style={{ flex: 1 }}>{title ?? (danger ? (t("sm.deleteTitle") ?? "确认删除") : (t("sm.confirmTitle") ?? "确认操作"))}</span>
          {!busy && (
            <button
              onClick={closeConfirm}
              aria-label={t("sm.close") ?? "关闭"}
              title={t("sm.close") ?? "关闭"}
              style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 14, lineHeight: 1, padding: "2px 6px" }}
            >✕</button>
          )}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{message}</div>
        {err && (
          <div style={{ padding: "6px 9px", borderRadius: 6, fontSize: 11, background: "rgba(239,68,68,0.08)", color: ensureReadability("var(--danger, #f87171)") }}>{err}</div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          {!info && (
            <button
              onClick={closeConfirm}
              disabled={busy}
              style={{
                padding: "6px 14px", fontSize: 12, borderRadius: 8, border: "1px solid var(--border)",
                background: "none", color: "var(--text-muted)", cursor: busy ? "default" : "pointer",
              }}
            >{t("files.cancel") ?? "取消"}</button>
          )}
          <button
            onClick={() => void confirm()}
            disabled={busy}
            style={{
              padding: "6px 14px", fontSize: 12, fontWeight: 700, borderRadius: 8, border: "none",
              background: info ? "var(--bg-hover)" : (danger ? ensureReadability("var(--danger, #f87171)") : "#6366f1"),
              color: info ? "var(--text)" : "#fff",
              cursor: busy ? "default" : "pointer",
              opacity: busy ? 0.5 : 1,
            }}
          >{busy ? "…" : (info ? (t("sm.gotIt") ?? "知道了") : (confirmLabel ?? (t("sm.confirmOk") ?? "确认")))}</button>
        </div>
      </div>
    </div>
  );
}
