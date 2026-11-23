/**
 * aiti-models-import · client entry
 *
 * register(ctx):
 *   1. toolbar button (icons/import.svg, opens the import dialog manually)
 *   2. a permanently mounted dialogs slot entry (ImportDialogSlot; the extension state controls
 *      visibility)
 *   3. first-run auto-open: one /status fetch at register time (event driven, no polling) —
 *      firstRun (no completedAt / dismissedAt) with at least one available source → open the dialog
 *      (interrupts the user only once)
 */
import { __setCtx, t } from "./host-shim";
import { ImportDialogSlot, setDialogOpen } from "./import-app";

export default function register(ctx: Record<string, unknown>) {
  __setCtx(ctx); // must run before any JSX render

  function ImportButton() {
    return (
      <button type="button" title={t("mi.shell.title")}
        onClick={() => setDialogOpen(true)}
        style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, padding: 0, background: "none", borderTop: "none", borderRight: "1px solid var(--border)", color: "var(--text-muted)", cursor: "pointer", fontSize: 15 }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <path d="m7 10 5 5 5-5" />
          <path d="M12 15V3" />
        </svg>
      </button>
    );
  }

  ctx.registerItems?.("toolbar", [{ id: "aiti-models-import-open", render: ImportButton, meta: { label: "i18n:mi.open.label", icon: "icons/import.svg" } }]);
  ctx.registerItems?.("dialogs", [{ id: "aiti-models-import-dialog", render: ImportDialogSlot, meta: { label: "i18n:it.import.label" } }]);

  // Cross-extension open service (consumed by the quickstart card's "Import from an agent…"; the
  // ext-services route is the sanctioned one). Consumers probe it as a soft dependency: when this
  // extension is absent or too old to expose the service, they simply render no entry.
  try {
    ctx.registerExtService?.("aiti-models-import.open", { open: () => setDialogOpen(true) });
  } catch { /* ignore */ }

  // First-run decision: at most one /status per page load; firstRun with available sources → auto-open
  // (never again once the user closed or imported)
  try {
    const base = typeof (ctx as any).apiUrl === "function" ? (ctx as any).apiUrl("/api/extensions/aiti-models-import/status") : "/api/extensions/aiti-models-import/status";
    fetch(base, { cache: "no-store" })
      .then((r) => r.json())
      .then((st) => {
        if (st && st.ok && st.firstRun && Array.isArray(st.sources) && st.sources.some((s: any) => s.available)) {
          setDialogOpen(true);
        }
      })
      .catch(() => { /* no status, no auto-open (the manual entry stays) */ });
  } catch { /* defensive against hostile environments */ }
}
