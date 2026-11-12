"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { AppInstallMode, AppUpdateResponse } from "@/lib/api-types";

interface Props {
  update: AppUpdateResponse;
  onClose: () => void;
}

// Step-sheet copy per install mode; every mode gets its own i18n block so
// translations can phrase the stop → update → start rhythm natively.
const INSTALL_TYPE_KEY: Record<AppInstallMode, string> = {
  archive: "appUpdate.installTypeArchive",
  "npm-global": "appUpdate.installTypeNpmGlobal",
  npx: "appUpdate.installTypeNpx",
  docker: "appUpdate.installTypeDocker",
  git: "appUpdate.installTypeGit",
  other: "appUpdate.installTypeOther",
};

const STEPS_KEY: Record<AppInstallMode, string> = {
  archive: "appUpdate.stepsArchive",
  "npm-global": "appUpdate.stepsNpmGlobal",
  npx: "appUpdate.stepsNpx",
  docker: "appUpdate.stepsDocker",
  git: "appUpdate.stepsGit",
  other: "appUpdate.stepsOther",
};

/**
 * Update guide for the new-session header banner: shows the stop → update →
 * start commands for the detected install mode (v1 is guidance-only — the
 * server never executes the update itself, so managed deployments keep the
 * launch/restart authority).
 */
export function UpdateGuideDialog({ update, onClose }: Props) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [copied, setCopied] = useState(false);

  const mode = update.install?.mode ?? "other";
  const steps = t(STEPS_KEY[mode]);
  const showManagedNote = update.install?.supported === true;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copySteps = async () => {
    try {
      await navigator.clipboard.writeText(steps);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (permissions/insecure context): text stays selectable.
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 110,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.45)",
        padding: isMobile ? 8 : 24,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          boxShadow: "0 12px 40px rgba(0,0,0,0.3)",
          width: isMobile ? "100%" : 520,
          maxWidth: "100%",
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>{t("appUpdate.dialogTitle")}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("sidebar.cancel")}
            style={{ marginLeft: "auto", border: "none", background: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 16, padding: "0 4px" }}
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10, overflow: "auto" }}>
          <span style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
            {t(INSTALL_TYPE_KEY[mode])}
          </span>
          <div
            style={{
              position: "relative",
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: "10px 12px",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              lineHeight: 1.6,
              whiteSpace: "pre-line",
              color: "var(--text)",
              userSelect: "text",
            }}
          >
            {steps}
            <button
              type="button"
              onClick={() => void copySteps()}
              style={{
                position: "absolute",
                top: 6,
                right: 6,
                padding: "2px 8px",
                fontSize: 11,
                borderRadius: 5,
                border: "1px solid var(--border)",
                background: "var(--bg)",
                color: copied ? "var(--accent)" : "var(--text-muted)",
                cursor: "pointer",
              }}
            >
              {copied ? "✓" : t("i18n.copy")}
            </button>
          </div>
          {showManagedNote && (
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {t("appUpdate.managedNote")}
            </p>
          )}
          {update.releaseUrl && (
            <a
              href={update.releaseUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: 12, color: "var(--accent)", textDecoration: "none" }}
            >
              {t("appUpdate.releaseNotesLink")} ↗
            </a>
          )}
        </div>

        {/* Footer */}
        <div style={{ display: "flex", justifyContent: "flex-end", padding: "10px 14px", borderTop: "1px solid var(--border)" }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: "5px 14px",
              fontSize: 12,
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
            {t("sidebar.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
