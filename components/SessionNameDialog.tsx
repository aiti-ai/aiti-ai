"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { apiUrl } from "@/lib/base-path";

interface Props {
  sessionId: string;
  /** Seed value for the input: current stored name, or the first message as fallback. */
  defaultName: string;
  onClose: () => void;
  /** Called with the saved (trimmed) name after a successful PATCH. */
  onSaved: (name: string) => void;
}

/**
 * Manual rename dialog for sessions owned by a TUI bridge — the one path where
 * auto-title generation is unavailable (no local runtime to run the naming
 * turn), but a manual name can still be pushed through the bridge handle via
 * `set_session_name` (PATCH /api/sessions/[id]).
 */
export function SessionNameDialog({ sessionId, defaultName, onClose, onSaved }: Props) {
  const { t } = useI18n();
  const isMobile = useIsMobile();

  const [value, setValue] = useState(defaultName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus + select-all once mounted so the user can type straight over the seed.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, []);

  const submit = useCallback(async () => {
    const name = value.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) {
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      onSaved(name);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }, [value, busy, sessionId, onSaved, onClose]);

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
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        style={{
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          boxShadow: "0 12px 40px rgba(0,0,0,0.3)",
          width: isMobile ? "100%" : 440,
          maxWidth: "100%",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>{t("title.renameDialog")}</span>
          <button
            type="button"
            onClick={onClose}
            title={t("sidebar.cancel")}
            style={{ marginLeft: "auto", border: "none", background: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 16, padding: "0 4px" }}
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: "14px", display: "flex", flexDirection: "column", gap: 10 }}>
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
            {t("title.bridgedHint")}
          </p>
          <input
            ref={inputRef}
            type="text"
            value={value}
            maxLength={120}
            disabled={busy}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
              if (e.key === "Escape" && !busy) onClose();
            }}
            style={{
              width: "100%",
              boxSizing: "border-box",
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              color: "var(--text)",
              fontSize: 13,
              padding: "8px 10px",
              outline: "none",
            }}
          />
          {error && <span style={{ fontSize: 12, color: "#dc2626" }}>{error}</span>}
        </div>

        {/* Footer */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 14px", borderTop: "1px solid var(--border)" }}>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            style={{
              padding: "5px 12px",
              fontSize: 12,
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--text-muted)",
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            {t("sidebar.cancel")}
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !value.trim()}
            style={{
              padding: "5px 14px",
              fontSize: 12,
              borderRadius: 6,
              border: "none",
              background: "var(--accent)",
              color: "white",
              cursor: busy || !value.trim() ? "not-allowed" : "pointer",
              opacity: busy || !value.trim() ? 0.6 : 1,
            }}
          >
            {t("agents.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
