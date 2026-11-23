/**
 * aiti-models-import · import dialog (mounted permanently in the dialogs slot; the extension state
 * controls visibility)
 *
 * Contract: panel root carries data-ext-float="1" (aiti-float owns dragging / maximize / small-screen
 * fullscreen data-ext-float-full) + a ✕ at the top right (the AI button is injected by the host).
 * Opening triggers GET /scan (a user action; no polling).
 * Sizing: data-ext-float-autoh (height follows content, capped at 86vh) — expanding the preview grows
 * the panel; a fixed height would only turn that growth into inner scrolling.
 * Preview: a provider row's "👁 N models" expands the list of models to import (context / output /
 * reasoning / input + new|existing). The data arrives with the /scan payload, so expanding costs no
 * extra request; the label only wraps "☑ + provider name" — clicking the preview must not toggle it.
 * Import: POST /import {saves, completed:true} (the server routes through the wizard's saveBatch) →
 * on success dispatch "pi-web:models-changed" so the model selector refreshes immediately.
 *
 * All user-facing text goes through t() (index.ts ui.i18n, zh-CN / en / zh-TW); server messages
 * arrive as "i18n:key|{params}" envelopes and are resolved by tsrv().
 */
import { useEffect, useMemo, useState } from "react";
import { apiUrl, extSvc, t, tsrv, tsrvList } from "./host-shim";

const api = (p: string, init?: RequestInit) =>
  fetch(apiUrl("/api/extensions/aiti-models-import" + p), { cache: "no-store", ...init });

// ---------- module-level open state (the dialogs slot stays mounted; the toolbar and the first-run
// auto-open share it) ----------
let dialogOpen = false;
const openListeners = new Set<() => void>();
export function setDialogOpen(v: boolean) {
  dialogOpen = v;
  for (const l of openListeners) l();
}
function useDialogOpen(): boolean {
  const [open, setOpen] = useState(dialogOpen);
  useEffect(() => {
    const l = () => setOpen(dialogOpen);
    openListeners.add(l);
    return () => { openListeners.delete(l); };
  }, []);
  return open;
}

/** Source state → i18n key + badge colors (unknown states render no badge). */
const STATE_BADGE: Record<string, { key: string; color: string; bg: string }> = {
  "available-new": { key: "mi.state.available", color: "#1d4ed8", bg: "rgba(59,130,246,.14)" },
  changed: { key: "mi.state.changed", color: "#b45309", bg: "color-mix(in srgb, var(--warn, #f59e0b) 16%, transparent)" },
  unchanged: { key: "mi.state.unchanged", color: "var(--text-muted, #6b7280)", bg: "rgba(107,114,128,.14)" },
  "source-gone": { key: "mi.state.gone", color: "var(--text-muted, #6b7280)", bg: "rgba(107,114,128,.14)" },
};

/** Default selection: everything new or changed, nothing unchanged. */
function defaultChecked(sources: any[]): Set<string> {
  const set = new Set<string>();
  for (const s of sources || []) {
    if (s.state === "available-new" || s.state === "changed") for (const d of s.drafts || []) set.add(s.id + ":" + d.key);
  }
  return set;
}

export function ImportDialogSlot() {
  const open = useDialogOpen();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [scan, setScan] = useState<any>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const doScan = async () => {
    setLoading(true);
    setError("");
    try {
      const r = await api("/scan");
      const j = await r.json();
      if (!j.ok) throw new Error(tsrv(j.error) || t("mi.err.unknown"));
      setScan(j);
      setChecked(defaultChecked(j.sources));
    } catch (e: any) {
      setError(tsrv((e && e.message) || e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Rescan on every open: source configs may have changed (state badges / drafts must be fresh);
    // scan, selection and result state reset with the open/close cycle
    if (open) void doScan();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const doImport = async () => {
    const saves = [...checked].map((k) => {
      const i = k.indexOf(":");
      return { sourceId: k.slice(0, i), key: k.slice(i + 1) };
    });
    if (!saves.length) return;
    setImporting(true);
    setResult(null);
    try {
      const r = await api("/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ saves, completed: true }) });
      const j = await r.json();
      if (!j.ok) throw new Error(tsrv(j.error) || t("mi.err.importFailed"));
      const okN = j.imported || 0;
      const warn = tsrvList(j.warnings).join(t("mi.src.listSep"));
      setResult({ ok: true, text: t(warn ? "mi.ok.importedWithWarnings" : "mi.ok.imported", { count: okN, warn }) });
      try { window.dispatchEvent(new CustomEvent("pi-web:models-changed")); } catch { /* ignored when the host does not listen */ }
      setChecked(new Set());
      await doScan();
    } catch (e: any) {
      setResult({ ok: false, text: tsrv((e && e.message) || e) });
    } finally {
      setImporting(false);
    }
  };

  const doClose = async () => {
    // Closing records a dismiss (server-side idempotent: skipped once an import completed) — no more
    // auto-open afterwards; the toolbar entry can still open it manually
    try { await api("/dismiss", { method: "POST" }); } catch { /* ignore */ }
    setDialogOpen(false);
  };

  // Footer "Configure models" entry: close this dialog, then open the 🧙 model wizard (management page).
  // The service channel wins (lazy implementation registered at shell boot + the direct one once
  // WizardDialog mounts); the window global is a fallback during the two-track transition.
  const openModelWizard = () => {
    const w = extSvc<() => void>("aiti-model-wizard.open") || (window as any).__aitiModelWizardOpen;
    if (typeof w !== "function") {
      setResult({ ok: false, text: t("mi.err.wizardMissing") });
      return;
    }
    setDialogOpen(false);
    setTimeout(() => { try { void w(); } catch { /* a failed open must not block */ } }, 30); // close this dialog first so the two never stack
  };

  const toggle = (k: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  };

  const importableSources = useMemo(() => (scan?.sources || []).filter((s: any) => s.kind === "importable"), [scan]);
  const otherSources = useMemo(() => (scan?.sources || []).filter((s: any) => s.kind !== "importable"), [scan]);
  const checkedCount = checked.size;

  if (!open) return null;
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 300, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={doClose}>
      <div
        data-ext-float="1"
        data-ext-float-w={880}
        data-ext-float-autoh="1"
        data-ext-float-full="1"
        style={{
          width: 880, maxWidth: "94vw", maxHeight: "86vh", display: "flex", flexDirection: "column",
          padding: 16, borderRadius: 10, background: "var(--bg-panel)", border: "1px solid var(--border)", color: "var(--text)",
        }}
        onClick={(e: any) => e.stopPropagation()}
      >
        {/* Title bar (first child = the aiti-float drag handle) */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, cursor: "move" }}>
          <div style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>{t("mi.shell.title")}</div>
          <button onClick={() => void doScan()} disabled={loading} title={t("mi.shell.rescanTitle")}
            style={{ background: "none", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-muted)", cursor: "pointer", fontSize: 11, padding: "3px 8px" }}>
            {loading ? t("mi.shell.scanning") : "↻ " + t("mi.shell.rescan")}
          </button>
          <button onClick={() => void doClose()} aria-label={t("mi.shell.close")} title={t("mi.shell.close")}
            style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 15, lineHeight: 1, padding: "2px 6px" }}>✕</button>
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 10 }}>
          {t("mi.shell.intro")}
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, paddingRight: 2 }}>
          {error && <div style={{ fontSize: 12, color: "#dc2626" }}>{t("mi.list.scanFailedDetail", { error })}</div>}
          {result && (
            <div style={{ fontSize: 12, color: result.ok ? "#059669" : "#dc2626", padding: "6px 8px", borderRadius: 6, background: result.ok ? "color-mix(in srgb, var(--ok, #10b981) 10%, transparent)" : "rgba(220,38,38,.08)" }}>
              {result.text}
            </div>
          )}
          {!scan && !error && loading && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("mi.shell.scanningList")}</div>}
          {scan && importableSources.length === 0 && (
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("mi.list.empty")}</div>
          )}
          {importableSources.map((s: any) => <SourceCard key={s.id} s={s} checked={checked} toggle={toggle} />)}
          {otherSources.length > 0 && (
            <div style={{ fontSize: 11, color: "var(--text-muted)", borderTop: "1px dashed var(--border)", paddingTop: 6 }}>
              {otherSources.map((s: any) => (
                <div key={s.id} style={{ marginBottom: 2 }}>{t("mi.list.otherRow", { label: s.label, reason: tsrv(s.reason) })}</div>
              ))}
            </div>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
          <button onClick={openModelWizard} title={t("mi.act.wizardTitle")}
            onMouseEnter={(e: any) => { e.currentTarget.style.borderColor = "var(--accent, #3b82f6)"; }}
            onMouseLeave={(e: any) => { e.currentTarget.style.borderColor = "var(--border)"; }}
            style={{ background: "none", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", cursor: "pointer", fontSize: 12, padding: "6px 12px", transition: "border-color 0.12s" }}>
            {t("mi.act.wizard")}
          </button>
          <div style={{ flex: 1, fontSize: 11, color: "var(--text-muted)" }}>
            {scan?.firstRun && !scan?.completed ? t("mi.shell.firstRunHint") : ""}
          </div>
          <button onClick={() => void doClose()} style={{ background: "none", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", cursor: "pointer", fontSize: 12, padding: "6px 12px" }}>
            {t("mi.act.later")}
          </button>
          <button onClick={() => void doImport()} disabled={importing || checkedCount === 0}
            style={{ background: "var(--accent)", color: "#fff", border: "none", borderRadius: 6, cursor: checkedCount ? "pointer" : "not-allowed", fontSize: 12, padding: "6px 14px", opacity: checkedCount ? 1 : 0.5 }}>
            {importing ? t("mi.act.importing") : t("mi.act.importCount", { count: checkedCount })}
          </button>
        </div>
      </div>
    </div>
  );
}

function SourceCard({ s, checked, toggle }: { s: any; checked: Set<string>; toggle: (k: string) => void }) {
  const badge = STATE_BADGE[s.state] || null;
  const [expanded, setExpanded] = useState(true);
  const notes = tsrvList(s.notes);
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, background: "var(--bg-panel)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }} onClick={() => setExpanded(!expanded)}>
        <div style={{ fontSize: 13, fontWeight: 700, flex: 1 }}>
          {s.label}
          <span style={{ fontSize: 11, fontWeight: 400, color: "var(--text-muted)", marginLeft: 6 }}>
            {notes[0] || ""}
          </span>
        </div>
        {badge && <span style={{ fontSize: 11, padding: "1px 8px", borderRadius: 999, color: badge.color, background: badge.bg }}>{t(badge.key)}</span>}
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{expanded ? "▾" : "▸"}</span>
      </div>
      {expanded && (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
          {(s.drafts || []).map((d: any) => (
            <DraftRow key={d.key} s={s} d={d} checked={checked} toggle={toggle} />
          ))}
          {(s.drafts || []).length === 0 && (
            <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{notes.join(t("mi.src.listSep")) || t("mi.src.noProviders")}</div>
          )}
        </div>
      )}
    </div>
  );
}

const fmtTok = (n: any) => (!n ? "" : n >= 1000000 ? Math.round(n / 100000) / 10 + "M" : Math.round(n / 1000) + "k");

const KNOWN_MODALITIES = new Set(["text", "image", "video", "audio"]);
/** Modality id → localized label (unknown ids pass through; the table holds no id → text map). */
const modalityLabel = (id: string) => (KNOWN_MODALITIES.has(id) ? t("mi.modality." + id) : id);

const GRID_COLS = "minmax(0, 1.5fr) 54px 54px minmax(0, 1.1fr)";

/** Provider row with a preview expansion: the checkbox only wraps "☑ + provider name"; every badge and
 *  the preview button sit outside the label (clicking the preview must not toggle the checkbox). */
function DraftRow({ s, d, checked, toggle }: { s: any; d: any; checked: Set<string>; toggle: (k: string) => void }) {
  const ck = s.id + ":" + d.key;
  const isOn = checked.has(ck);
  const [showModels, setShowModels] = useState(false);
  const warnings = tsrvList(d.warnings);
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "6px 8px", opacity: s.state === "unchanged" ? 0.75 : 1 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input type="checkbox" checked={isOn} onChange={() => toggle(ck)} />
          <span style={{ fontSize: 12, fontWeight: 600 }}>{d.key}</span>
        </label>
        <span style={{ fontSize: 11, color: "var(--text-muted)", flex: 1, minWidth: 100, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {d.baseUrl} · {d.api}
        </span>
        <span style={{ fontSize: 11, color: d.hasKey ? "#059669" : "var(--text-muted)" }}>
          {d.hasKey ? "key" + d.keyHint : d.apiKeyEnv ? "env:" + d.apiKeyEnv : t("mi.row.noKey")}
        </span>
        <button
          onClick={() => setShowModels(!showModels)}
          aria-expanded={showModels}
          title={t("mi.row.previewTitle")}
          style={{
            background: showModels ? "rgba(59,130,246,.12)" : "none",
            border: "1px solid " + (showModels ? "rgba(59,130,246,.4)" : "var(--border)"),
            borderRadius: 6, color: showModels ? "#1d4ed8" : "var(--text-muted)", cursor: "pointer", fontSize: 11, padding: "2px 8px", whiteSpace: "nowrap",
          }}
        >
          {showModels ? "▾" : "▸"} {t("mi.row.models", { count: d.modelsCount })}
        </button>
        {d.conflict === "override" && (
          <span style={{ fontSize: 11, color: "#b45309", background: "color-mix(in srgb, var(--warn, #f59e0b) 14%, transparent)", padding: "1px 6px", borderRadius: 999 }} title={t("mi.row.overrideTitle", { fields: d.overrideFields.join(", ") })}>
            {t("mi.row.override", { fields: d.overrideFields.join("/") })}
          </span>
        )}
        {d.conflict === "merge" && (
          <span style={{ fontSize: 11, color: "#1d4ed8", background: "rgba(59,130,246,.12)", padding: "1px 6px", borderRadius: 999 }} title={t("mi.row.mergeTitle")}>
            {t("mi.row.merge")}
          </span>
        )}
      </div>
      {warnings.length > 0 && (
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3, paddingLeft: 24 }}>
          {warnings.map((w: string, i: number) => <div key={i}>⚠ {w}</div>)}
        </div>
      )}
      {showModels && <ModelPreview d={d} />}
    </div>
  );
}

/** Models that will be imported (the data already arrived with /scan — expanding costs no request). */
function ModelPreview({ d }: { d: any }) {
  const models: any[] = d.models || [];
  const cell = { fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const };
  if (!models.length) {
    return <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6, paddingLeft: 24 }}>{t("mi.prev.noModels")}</div>;
  }
  const known = models.length - (d.newModelsCount || 0);
  const noMeta = models.every((m: any) => !m.contextWindow && !m.maxTokens && m.reasoning == null && !m.input);
  return (
    <div style={{ marginTop: 6, marginLeft: 24, border: "1px solid var(--border)", borderRadius: 6, padding: "6px 8px", background: "rgba(0,0,0,.02)" }}>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
        {t("mi.prev.intro", { count: models.length })}
        {known > 0 ? t("mi.prev.introKnown", { added: models.length - known, known }) : ""}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: GRID_COLS, gap: 6, fontSize: 10, color: "var(--text-muted)", borderBottom: "1px solid var(--border)", paddingBottom: 3, marginBottom: 3 }}>
        <div>{t("mi.prev.colModel")}</div><div style={{ textAlign: "right" }}>{t("mi.prev.colContext")}</div><div style={{ textAlign: "right" }}>{t("mi.prev.colOutput")}</div><div>{t("mi.prev.colStatus")}</div>
      </div>
      <div style={{ maxHeight: 220, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 }}>
        {models.map((m: any) => (
          <div key={m.id} style={{ display: "grid", gridTemplateColumns: GRID_COLS, gap: 6, alignItems: "center" }}>
            <div style={cell} title={m.id}>
              <span style={{ fontSize: 11 }}>{m.name || m.id}</span>
              {m.name && m.name !== m.id && <span style={{ fontSize: 10, color: "var(--text-muted)", marginLeft: 5 }}>{m.id}</span>}
            </div>
            <div style={{ ...cell, textAlign: "right", color: "var(--text-muted)" }}>{fmtTok(m.contextWindow) || "—"}</div>
            <div style={{ ...cell, textAlign: "right", color: "var(--text-muted)" }}>{fmtTok(m.maxTokens) || "—"}</div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
              {m.reasoning && <span style={{ fontSize: 10, color: "#1d4ed8", background: "rgba(59,130,246,.1)", padding: "0 5px", borderRadius: 999 }}>{t("mi.prev.reasoning")}</span>}
              {(m.input || []).filter((x: string) => x && x !== "text").map((x: string) => (
                <span key={x} style={{ fontSize: 10, color: "var(--text-muted)", background: "rgba(107,114,128,.12)", padding: "0 5px", borderRadius: 999 }}>{modalityLabel(x)}</span>
              ))}
              <span style={{ fontSize: 10, color: m.existing ? "#b45309" : "#059669" }}>{m.existing ? t("mi.prev.existing") : t("mi.prev.new")}</span>
            </div>
          </div>
        ))}
      </div>
      {noMeta && (
        <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 4 }}>{t("mi.prev.noMeta")}</div>
      )}
    </div>
  );
}
