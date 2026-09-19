"use client";

import { useEffect, useState } from "react";
import { getBackendConnState, onBackendConnChange } from "@/lib/agent-running-events";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";

/**
 * Backend-disconnection banner (data source: liveness of the running/events SSE broker).
 *
 * During a backend (pi-web) restart window the page only shows scattered "HTTP 502"
 * toasts with no guidance -- the user has no idea what happened. This component shows a
 * single page-wide notice: an amber banner reading "the backend may be restarting" once
 * the connection drops (2 consecutive SSE failures).
 *
 * No banner on recovery: the page's realtime channels all self-heal after SSE
 * reconnects -- the agent event stream replays a full snapshot on reconnect
 * (agent-event-stream), running state has a fallback snapshot, and the session list uses
 * since/rev incremental sync (auto-degrading to a full fetch when too stale) -- so a
 * refresh is never required, and a green "service restored, refresh now" banner would
 * be pure noise. The disconnect banner disappearing by itself is the recovery signal.
 * Purely event-driven (the broker's existing reconnect loop); zero polling.
 */
export function BackendConnBanner() {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    // The offline broadcast may have been missed before subscribing (a first-frame error
    // can precede effect mount) -- check the current state first
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
        // Desktop: centered pill at the top of the viewport (shrink-to-fit hugs content width).
        // Small screens: switch to dual-anchor stretching -- the centered pill relies on
        // shrink-to-fit, which mis-measures on phones and squeezes the text into a single
        // vertical column; top:8 would also cover the top-bar buttons, so park it below the bar.
        ...(isMobile
          ? {
              top: "calc(40px + env(safe-area-inset-top))", // top bar 36px + 4px gap
              left: 10,
              right: 10,
            }
          : {
              top: 8,
              left: "50%",
              transform: "translateX(-50%)",
              maxWidth: "calc(100vw - 20px)",
            }),
        zIndex: 950, // global notice layer: above page content, below modals (RestartRecoveryWizard=1000)
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
