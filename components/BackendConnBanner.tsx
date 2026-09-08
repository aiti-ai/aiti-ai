"use client";

import { useEffect, useState } from "react";
import { getBackendConnState, onBackendConnChange } from "@/lib/agent-running-events";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";

/**
 * 后端断连横幅（数据源：running/events SSE broker 的存活判定）。
 *
 * 后端（pi-web）重启窗口内页面只剩散落的「HTTP 502」toast，没有任何指引——
 * 用户不知道发生了什么。这里全页统一提示：断连（连续 2 次 SSE 失败）时显示
 * 琥珀色横幅「后端可能正在重启」。
 *
 * 恢复不弹横幅：页面的实时通道在 SSE 重连后都能自主补齐——会话事件流重连时
 * 服务端重放全量快照（agent-event-stream）、运行状态有兜底快照、会话列表走
 * since/rev 增量同步（过旧自动全量降级）——刷新并非必要，绿色「服务已恢复+
 * 立即刷新」横幅反而是打扰。断连横幅自行消失即恢复信号。纯事件驱动（broker
 * 既有重连循环），零轮询。
 */
export function BackendConnBanner() {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    // 订阅前可能已错过 offline 广播（首帧错误早于 effect 挂载）——先查当前状态
    if (getBackendConnState() === "offline") setOffline(true);
    return onBackendConnChange((state) => setOffline(state === "offline"));
  }, []);

  if (!offline) return null;

  return (
    <div
      role="alert"
      data-piwe-backend-banner="offline"
      style={{
        position: "fixed",
        // 桌面：视口顶部居中 pill（shrink-to-fit 收缩到内容宽）。
        // 小屏：改双锚定拉伸——居中 pill 依赖 shrink-to-fit，手机上收缩失准会把
        // 文本挤成一字列（竖排）；且 top:8 会盖住顶栏按钮，改停在顶栏下方。
        ...(isMobile
          ? {
              top: "calc(40px + env(safe-area-inset-top))", // 顶栏 36px + 4px 间距
              left: 10,
              right: 10,
            }
          : {
              top: 8,
              left: "50%",
              transform: "translateX(-50%)",
              maxWidth: "calc(100vw - 20px)",
            }),
        zIndex: 950, // 全局提示态：高于页面内容，低于模态（RestartRecoveryWizard=1000）
        display: "flex",
        alignItems: isMobile ? "flex-start" : "center",
        gap: 8,
        padding: "7px 12px",
        borderRadius: 9,
        fontSize: 12.5,
        fontWeight: 550,
        lineHeight: 1.45,
        boxShadow: "0 4px 18px rgba(0,0,0,0.16)",
        pointerEvents: "auto",
        color: "#b45309",
        background: "color-mix(in srgb, #f59e0b 12%, var(--bg, #fff))",
        border: "1px solid color-mix(in srgb, #f59e0b 45%, transparent)",
      }}
    >
      <span aria-hidden>⚠</span>
      <span style={isMobile ? { flex: 1, minWidth: 0, textWrap: "balance" } : undefined}>{t("backendConn.offline")}</span>
    </div>
  );
}
