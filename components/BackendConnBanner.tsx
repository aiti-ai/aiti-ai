"use client";

import { useEffect, useRef, useState } from "react";
import { getBackendConnState, onBackendConnChange } from "@/lib/agent-running-events";
import { useI18n } from "@/hooks/useI18n";

/**
 * 后端断连/恢复横幅（数据源：running/events SSE broker 的存活判定）。
 *
 * 后端（pi-web）重启窗口内页面只剩散落的「HTTP 502」toast，没有任何指引——
 * 用户不知道该刷新。这里全页统一提示：
 *   - 断连（连续 2 次 SSE 失败）：琥珀色横幅「后端可能正在重启，请稍后刷新页面重试」；
 *   - 恢复（SSE 重连成功）：绿色横幅「服务已恢复」+「立即刷新」按钮 + ✕ 关闭。
 * 纯事件驱动（broker 既有重连循环），零轮询。
 */
export function BackendConnBanner() {
  const { t } = useI18n();
  const [offline, setOffline] = useState(false);
  const [recovered, setRecovered] = useState(false);
  // 恢复横幅只在前一遍历过断连时出现；ref 记录「曾断连」避免 state 时序依赖
  const wasOfflineRef = useRef(false);

  useEffect(() => {
    // 订阅前可能已错过 offline 广播（首帧错误早于 effect 挂载）——先查当前状态
    if (getBackendConnState() === "offline") {
      wasOfflineRef.current = true;
      setOffline(true);
    }
    return onBackendConnChange((state) => {
      if (state === "offline") {
        wasOfflineRef.current = true;
        setOffline(true);
        setRecovered(false);
      } else {
        setOffline(false);
        if (wasOfflineRef.current) {
          wasOfflineRef.current = false;
          setRecovered(true);
        }
      }
    });
  }, []);

  if (!offline && !recovered) return null;

  const pillBase: React.CSSProperties = {
    position: "fixed",
    top: 8,
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 950, // 全局提示态：高于页面内容，低于模态（RestartRecoveryWizard=1000）
    display: "flex",
    alignItems: "center",
    gap: 8,
    maxWidth: "calc(100vw - 20px)",
    padding: "7px 12px",
    borderRadius: 9,
    fontSize: 12.5,
    fontWeight: 550,
    lineHeight: 1.45,
    boxShadow: "0 4px 18px rgba(0,0,0,0.16)",
    pointerEvents: "auto",
  };

  if (offline) {
    return (
      <div
        role="alert"
        data-piwe-backend-banner="offline"
        style={{
          ...pillBase,
          color: "#b45309",
          background: "color-mix(in srgb, #f59e0b 12%, var(--bg, #fff))",
          border: "1px solid color-mix(in srgb, #f59e0b 45%, transparent)",
        }}
      >
        <span aria-hidden>⚠</span>
        <span>{t("backendConn.offline")}</span>
      </div>
    );
  }

  return (
    <div
      role="status"
      data-piwe-backend-banner="recovered"
      style={{
        ...pillBase,
        color: "#15803d",
        background: "color-mix(in srgb, #22c55e 11%, var(--bg, #fff))",
        border: "1px solid color-mix(in srgb, #22c55e 45%, transparent)",
      }}
    >
      <span aria-hidden>✓</span>
      <span>{t("backendConn.recovered")}</span>
      <button
        onClick={() => window.location.reload()}
        style={{
          flexShrink: 0,
          padding: "3px 10px",
          borderRadius: 6,
          fontSize: 12,
          fontWeight: 650,
          cursor: "pointer",
          color: "#fff",
          background: "#22c55e",
          border: "1px solid #16a34a",
        }}
      >
        {t("backendConn.refreshNow")}
      </button>
      <button
        onClick={() => setRecovered(false)}
        aria-label={t("chat.close")}
        style={{
          flexShrink: 0,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 22,
          height: 22,
          borderRadius: 6,
          cursor: "pointer",
          background: "transparent",
          color: "inherit",
          border: "none",
        }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}
