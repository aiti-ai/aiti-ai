/**
 * session-manager · export a session as one portable JSON file.
 *
 * Shared by every entry point that can hand a session to another agent:
 *   - external-session viewer (ExtViewer) and archived viewer (ArchivedViewer) headers
 *   - external-source row ⋮ menu (All Sessions panel)
 *   - live pi row ⋮ menu (row-menu.tsx, shared with the sidebar dock rows)
 *
 * The client only sends { id, dir, filename } — the server resolves the session
 * (external adapter / .pwarc archive / live pi file) and writes the JSON, which is
 * then opened in the host file viewer so the user can @-reference it from any session.
 */
import { useEffect, useState } from "react";
import { apiUrl, createPortal, openFile, t } from "./host-shim";
import { ensureReadability, ghostBtn, inputStyle } from "./helpers";
import { showToast } from "./toast";
import { createLazyModule, lazyExtView } from "../../../_shared/ext-lazy";

const dirPickerRef = createLazyModule(() => import("./sidebar/directory-picker"));

export interface ExportTarget {
  /** Session id: external composite (`agent:sid`), archived pi id, or live pi id. */
  id: string;
  /** Row / viewer data used only for the default file name + folder. */
  name?: string;
  cwd?: string;
  agent?: string;
}

const state = { target: null as ExportTarget | null, subs: new Set<() => void>() };

export function openExportDialog(target: ExportTarget) {
  state.target = target;
  for (const l of state.subs) l();
}

export function closeExportDialog() {
  if (!state.target) return;
  state.target = null;
  for (const l of state.subs) l();
}

export function subscribeExportDialog(fn: () => void): () => void {
  state.subs.add(fn);
  return () => { state.subs.delete(fn); };
}

/** Default file name: <agent>-<session-slug>-<yyyyMMdd-HHmm>.json */
function defaultExportName(target: ExportTarget): string {
  const agent = String(target.agent || "session");
  const raw = String(target.name || "").trim();
  const slug = raw.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  return `${agent}${slug ? `-${slug}` : ""}-${stamp}.json`;
}

function ExportDialog(props: { target: ExportTarget; onClose: () => void }) {
  const [dir, setDir] = useState<string>(() => String(props.target.cwd || ""));
  const [name, setName] = useState<string>(() => defaultExportName(props.target));
  const [pickOpen, setPickOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const doExport = async () => {
    if (busy) return;
    const targetDir = dir.trim();
    const filename = name.trim();
    if (!targetDir) { setErr(t("sm.export.noDir")); return; }
    if (!filename) { setErr(t("sm.export.noName")); return; }
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl("/api/extensions/session-manager/export-json"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: props.target.id, dir: targetDir, filename }),
      });
      const d = await res.json().catch(() => ({} as { ok?: boolean; path?: string; filename?: string; error?: string }));
      if (!res.ok || d?.ok !== true) {
        setErr(`${t("sm.export.failed")}：${d?.error ?? `HTTP ${res.status}`}`);
        return;
      }
      // Open the exported JSON right away (editor tab); the path stays in the toast for @-reference.
      try { openFile(String(d.path), String(d.filename || filename)); } catch { /* open failure must not hide the export */ }
      showToast(`${t("sm.export.done")}：${d.path}`);
      props.onClose();
    } catch (e) {
      setErr(`${t("sm.export.failed")}：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const picker = lazyExtView({
    active: pickOpen,
    load: dirPickerRef,
    pick: "DirectoryPicker",
    props: {
      initialPath: dir || undefined,
      onCancel: () => setPickOpen(false),
      onSelect: (path: string) => { setDir(path); setPickOpen(false); },
    },
  });

  const close = () => { if (!busy) props.onClose(); };
  // Portal to <body> + a z-index above the aiti-float raise ceiling (2147483000), same
  // ordering as row-menu (3500) / confirm (3600) / toast (3700): the All Sessions panel
  // is itself a float overlay, so a locally-scoped z-index landed BEHIND it. While the
  // DirectoryPicker (its own body portal, z 1000) is open we drop below it so it stays
  // clickable on top of this dialog.
  const overlay = (
    <>
      <div
        style={{ position: "fixed", inset: 0, zIndex: pickOpen ? 900 : 2147483560, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center" }}
        onClick={close}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          className="sm-export-dialog"
          role="dialog"
          aria-label={t("sm.export.title")}
          style={{ width: "min(520px, 94vw)", display: "flex", flexDirection: "column", gap: 10, padding: 16, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 12, boxShadow: "0 18px 60px rgba(0,0,0,0.4)" }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <strong style={{ fontSize: 13 }}>{t("sm.export.title")}</strong>
            <button onClick={close} disabled={busy} aria-label={t("sm.close")} title={t("sm.close")}
              style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--text-muted)", cursor: busy ? "default" : "pointer", fontSize: 15, lineHeight: 1, padding: "2px 6px" }}>✕</button>
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.6 }}>{t("sm.export.hint")}</div>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("sm.export.dir")}</span>
            <div style={{ display: "flex", gap: 6 }}>
              <input value={dir} onChange={(e) => setDir(e.target.value)} spellCheck={false} disabled={busy} style={inputStyle as React.CSSProperties} />
              <button onClick={() => setPickOpen(true)} disabled={busy} style={ghostBtn as React.CSSProperties}>{t("sm.export.browse")}</button>
            </div>
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("sm.export.name")}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} disabled={busy} style={inputStyle as React.CSSProperties} />
          </label>
          {err && (
            <div style={{ padding: "6px 10px", borderRadius: 6, background: "color-mix(in srgb, var(--danger, #ef4444) 8%, transparent)", color: ensureReadability("var(--danger, #f87171)"), fontSize: 11 }}>{err}</div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button onClick={close} disabled={busy} style={ghostBtn as React.CSSProperties}>{t("i18n.cancel")}</button>
            <button onClick={() => void doExport()} disabled={busy} style={{ ...ghostBtn, color: ensureReadability("var(--accent)"), borderColor: "var(--accent)66" } as React.CSSProperties}>
              {busy ? "…" : t("sm.export.do")}
            </button>
          </div>
        </div>
      </div>
      {picker}
    </>
  );
  const body = typeof document !== "undefined" ? document.body : null;
  return body ? (createPortal(overlay, body) as React.ReactElement) : overlay;
}

/** Always-mounted host (entry `dialogs` slot); renders nothing until a target is set. */
export function SessionExportHost() {
  const [target, setTarget] = useState<ExportTarget | null>(state.target);
  useEffect(() => subscribeExportDialog(() => setTarget(state.target)), []);
  if (!target) return null;
  return <ExportDialog key={`${target.id}:${target.name ?? ""}`} target={target} onClose={closeExportDialog} />;
}
