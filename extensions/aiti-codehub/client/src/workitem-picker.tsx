/**
 * Cross-extension service: pick a work item, returned formatted with the paste
 * template.
 *
 * Consumer: `getExtService("aiti-codehub.pickWorkItem")?.open()` →
 * Promise<PickResult | null>. aiti-folder's commit / group-commit dialogs use
 * it to prepend a `#id type title` header to the commit message.
 *
 * The overlay hosts the real work-items surface (WorkItemsPanel) instead of a
 * stripped copy: rows keep opening the detail — rendered inside this overlay,
 * so nothing can cover it — each row gains an inline "Select" action, and the
 * detail toolbar gains a primary Select. While a pick is active the same
 * Select actions appear on every surface (docked panel / detail float), so the
 * user can also pick from there without touching the overlay.
 */
import { useEffect, useState, t } from "./host-shim";
import { createPortal } from "./host-shim";
import { addRecent, getWorkItem, markUsage, type WorkItem } from "./api";
import { aliasOf, loadConfig, platformLabelOf } from "./store";
import { WorkItemsPanel } from "./workitems";
import { DetailBody, type DetailTarget } from "./detail";
import { formatWorkItemText } from "../../server/format.ts";
import { S } from "./ui";
import { PICK_DIALOG_ID } from "./keys";

export interface PickResult {
  /** Formatted with the paste template (e.g. `#123 Bug Fix login timeout`). */
  text: string;
  /** Instance id the item came from. */
  provider: string;
  item: WorkItem;
}

interface PickRequest { resolve: (r: PickResult | null) => void }

let request: PickRequest | null = null;
/** Detail view inside the overlay (pick-scoped; null = list view). */
let detailTarget: DetailTarget | null = null;
const listeners = new Set<() => void>();
/** Surfaces re-render on this to show/hide their inline Select actions. */
const modeListeners = new Set<() => void>();

function emit(): void {
  for (const l of [...listeners]) {
    try { l(); } catch { /* ignore */ }
  }
}

function emitMode(): void {
  for (const l of [...modeListeners]) {
    try { l(); } catch { /* ignore */ }
  }
}

/** Open the picker; resolves with the formatted header text, or null on cancel. */
export function pickWorkItem(): Promise<PickResult | null> {
  return new Promise((resolve) => {
    request = { resolve };
    detailTarget = null;
    emit();
    emitMode();
  });
}

function settle(r: PickResult | null): void {
  const req = request;
  request = null;
  detailTarget = null;
  emit();
  emitMode();
  try { req?.resolve(r); } catch { /* ignore */ }
}

function closePick(): void {
  settle(null);
}

/* ── pick mode shared with the other surfaces ── */

export function isPickMode(): boolean {
  return !!request;
}

export function onPickModeChange(cb: () => void): () => void {
  modeListeners.add(cb);
  return () => { modeListeners.delete(cb); };
}

/** Reactive flag: surfaces render their inline Select actions while true. */
export function usePickMode(): boolean {
  const [on, setOn] = useState(isPickMode());
  useEffect(() => onPickModeChange(() => setOn(isPickMode())), []);
  return on;
}

/** Complete an active pick from any surface (no-op when none is active).
 * Formats with the paste template, feeds the ✎ badge and the recents list. */
export async function submitPick(item: WorkItem, provider: string): Promise<void> {
  if (!request) return;
  let tpl = "#{id} {type} {title}";
  try {
    const c = await loadConfig();
    tpl = (c as any)?.global?.templates?.paste || tpl;
  } catch { /* default template */ }
  const text = formatWorkItemText(item, platformLabelOf(provider), tpl, aliasOf(provider));
  void markUsage(provider, item.id, "paste").catch(() => { /* badge only */ });
  void addRecent(provider, "workitem", item.id, `#${item.key} ${item.title}`, item.scope?.label || "").catch(() => { /* recents only */ });
  settle({ text, provider, item });
}

/** Open a work-item detail inside the overlay (pick mode keeps list + detail
 * in one stacking context, so the overlay can never cover the detail). */
export function openPickDetail(tgt: DetailTarget): void {
  if (!request) return;
  detailTarget = tgt;
  emit();
}

function backToList(): void {
  detailTarget = null;
  emit();
}

/* ── overlay face (always-mounted host via the dialogs slot) ── */

export function WorkItemPickFace() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  if (!request) return null;
  return createPortal(
    <div
      onClick={() => closePick()}
      style={{ position: "fixed", inset: 0, zIndex: 2147483600, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }}
    >
      <div
        onClick={(e: any) => e.stopPropagation()}
        style={{ width: 900, maxWidth: "94vw", height: 680, maxHeight: "88vh", display: "flex", flexDirection: "column", borderRadius: 10, background: "var(--bg, #1a1a1a)", border: "1px solid var(--border, #3a3a3a)", boxShadow: "0 14px 36px color-mix(in srgb, var(--text) 16%, transparent)", fontSize: 12.5, color: "var(--text, #ddd)", overflow: "hidden" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderBottom: "1px solid var(--border, #3a3a3a)", fontWeight: 600, flexShrink: 0 }}>
          {t("ch.pick.title")}
          <span style={{ ...S.dim, fontWeight: 400 }}>{t("ch.pick.pickHint")}</span>
          <span style={{ flex: 1 }} />
          <button type="button" onClick={() => closePick()} style={{ border: "none", background: "none", color: "var(--text-dim, #888)", cursor: "pointer", fontSize: 12, padding: "2px 4px" }}>✕</button>
        </div>
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          {detailTarget
            ? <DetailBody target={detailTarget} onBack={backToList} />
            : <WorkItemsPanel />}
        </div>
      </div>
    </div>,
    document.body,
  );
}
