"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { apiUrl } from "@/lib/base-path";

interface SelfAlertState {
  exposing: boolean;
  unauthenticated: boolean;
}

/** 新/老会话加载完成后延迟拉一次（ms）。 */
const LOAD_DELAY_MS = 1000;
/** 回到前台 / focus / online 后的防抖延迟刷新（ms）。 */
const RESUME_DELAY_MS = 500;

/**
 * 自暴露无认证（expose self 不带秘）的页面顶部红色 🔴 告警。
 *
 * 事件驱动、不轮询：
 * - AppShell 在每次 ChatWindow（新/老会话）重挂载时变化 sessionLoadedKey →
 *   延迟 ~1s 拉一次 GET /api/service-tunnels?self-only=1（初始 mount 也由
 *   sessionLoadedKey 首值触发，未选会话同样检查）；
 * - 页面回到可见 / focus / online 时防抖延迟刷新（后台标签暂停，零请求）；
 * - 点击条幅 → 原因弹窗（为什么危险 + 怎么换 expose 方法）→
 *   「去更换暴露方式」打开服务对话框 Self 页 /「立即停止暴露」/「本次会话不再提示」。
 */
export function SelfExposeAlert({ sessionLoadedKey, onOpenServices }: {
  /** 会话加载完成信号：ChatWindow 重挂载 / 会话 id 确立时变化。 */
  sessionLoadedKey: string;
  /** 打开「服务」对话框（并停在 Self 页）。 */
  onOpenServices: () => void;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<SelfAlertState | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const resumeTimerRef = useRef<number | null>(null);

  const load = useCallback(() => {
    fetch(apiUrl("/api/service-tunnels?self-only=1"))
      .then((r) => r.json())
      .then((d: { self?: SelfAlertState; error?: string }) => {
        // fail-safe：接口失败 / 无 self 字段 → 不告警（宁缺毋滥不误报）
        if (d.error || !d.self) { setState(null); return; }
        setState({ exposing: Boolean(d.self.exposing), unauthenticated: Boolean(d.self.unauthenticated) });
      })
      .catch(() => setState(null));
  }, []);

  // 新/老会话加载完成后延迟拉一次（含初始 mount）
  useEffect(() => {
    const timer = setTimeout(load, LOAD_DELAY_MS);
    return () => clearTimeout(timer);
  }, [sessionLoadedKey, load]);

  // 切到新会话（sessionLoadedKey 变化）时恢复提示——「本次会话不再提示」只对
  // 当前会话生效，而不是一直隐藏到页面刷新。
  useEffect(() => {
    setDismissed(false);
  }, [sessionLoadedKey]);

  // 后台标签暂停；回到可见 / focus / online 时防抖 + 延迟刷新
  useEffect(() => {
    const schedule = () => {
      if (document.visibilityState !== "visible") return;
      if (resumeTimerRef.current) window.clearTimeout(resumeTimerRef.current);
      resumeTimerRef.current = window.setTimeout(load, RESUME_DELAY_MS);
    };
    const onVisibility = () => { if (document.visibilityState === "visible") schedule(); };
    window.addEventListener("focus", schedule);
    window.addEventListener("online", schedule);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", schedule);
      window.removeEventListener("online", schedule);
      document.removeEventListener("visibilitychange", onVisibility);
      if (resumeTimerRef.current) window.clearTimeout(resumeTimerRef.current);
    };
  }, [load]);

  const show = Boolean(state?.exposing && state.unauthenticated && !dismissed);

  const stopNow = () => {
    setStopping(true);
    fetch(apiUrl("/api/service-tunnels"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "self-stop" }),
    })
      .then((r) => r.json())
      .then((d: { error?: string }) => {
        if (d.error) return;
        setState((prev) => (prev ? { ...prev, exposing: false, unauthenticated: false } : prev));
        setReasonOpen(false);
      })
      .catch(() => {})
      .finally(() => setStopping(false));
  };

  if (!show) return null;

  return (
    <>
      {/* 页面顶部红色 🔴 条幅：点击（除 × 外）弹原因 */}
      <div
        onClick={() => setReasonOpen(true)}
        role="alert"
        style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "5px 12px", flexShrink: 0,
          background: "rgba(248,113,113,0.12)",
          borderBottom: "1px solid rgba(248,113,113,0.5)",
          fontSize: 12, color: "#f87171", cursor: "pointer",
        }}
      >
        <span style={{ fontSize: 13, flexShrink: 0 }}>🔴</span>
        <b style={{ flexShrink: 0 }}>{t("services.selfNoAuth")}</b>
        <span style={{ color: "#fca5a5", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
          {t("services.selfNoAuthSummary")}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ flexShrink: 0, fontWeight: 600 }}>{t("services.selfNoAuthReason")} ›</span>
        <button
          onClick={(e) => { e.stopPropagation(); setDismissed(true); }}
          title={t("services.selfNoAuthDismiss")}
          aria-label={t("services.selfNoAuthDismiss")}
          style={{ flexShrink: 0, background: "none", border: "none", color: "#f87171", cursor: "pointer", fontSize: 14, padding: "0 2px" }}
        >
          ×
        </button>
      </div>

      {/* 原因弹窗：为什么危险 + 换 expose 方法 */}
      {reasonOpen && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 1100, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => setReasonOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: 480, maxWidth: "calc(100vw - 32px)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, padding: "14px 16px", boxShadow: "0 8px 32px rgba(0,0,0,0.2)" }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, color: "#f87171", marginBottom: 8 }}>🔴 {t("services.selfNoAuth")}</div>
            <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.7 }}>{t("services.selfNoAuthBody")}</div>
            <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.7, marginTop: 8 }}>
              {t("services.selfNoAuthSuggest").split("\n").map((line, i) => <div key={i}>• {line}</div>)}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
              <button
                onClick={() => { setReasonOpen(false); onOpenServices(); }}
                style={{ padding: "5px 14px", background: "var(--accent)", border: "none", borderRadius: 6, color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
              >
                {t("services.selfNoAuthOpen")}
              </button>
              <button
                onClick={stopNow}
                disabled={stopping}
                style={{ padding: "5px 14px", background: "#dc2626", border: "none", borderRadius: 6, color: "#fff", cursor: stopping ? "default" : "pointer", fontSize: 12, fontWeight: 600 }}
              >
                {stopping ? "…" : t("services.selfNoAuthStop")}
              </button>
              <button
                onClick={() => { setReasonOpen(false); setDismissed(true); }}
                style={{ padding: "5px 14px", background: "none", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-muted)", cursor: "pointer", fontSize: 12 }}
              >
                {t("services.selfNoAuthDismiss")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
