"use client";
/**
 * New-session welcome page "top/bottom widget" zones + customize panel.
 *
 * - The `newSessionWidgets` slot has one registration point and two render
 *   points: extension/builtin entries are unified through resolveWidgetLayout
 *   (lib/new-session-widgets.ts), which resolves the top/bottom render order.
 *   Grid = 4 columns on mobile / 8 on desktop ("1×4" fills a mobile row,
 *   half a desktop row).
 * - Builtin entries (builtin: prefix keeps the namespace reserved) share the
 *   same customize/persist experience as extension entries; the builtin
 *   "recent sessions" widget opens a session on click (delegating to the
 *   host session service's open).
 * - Empty-state discipline: when no entries are registered, both zones render
 *   zero placeholders (bottom keeps the original filler, top renders null) —
 *   visually identical to this component being absent. Hooks still run, so
 *   lazy extension materialization is unaffected by the early return.
 * - extra only carries data { cwd, isMobile, area } (slot-extra red line);
 *   panel actions only write localStorage prefs + dispatch events (no
 *   polling).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { apiUrl } from "@/lib/base-path";
import { ExtSlot, useExtMetas, useExtSlotItems } from "./ExtSlots";
import {
  normalizeWidgetItem,
  resolveWidgetLayout,
  readNewSessionWidgetPref,
  writeNewSessionWidgetPref,
  resetNewSessionWidgetPref,
  subscribeNewSessionWidgetPref,
  type NewSessionWidgetItem,
  type NewSessionWidgetPref,
  type NswArea,
} from "@/lib/new-session-widgets";
import type { NewSessionWidgetMeta } from "@/lib/ext/types";
import type { SessionInfo } from "@/lib/types";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { openSessionById } from "@/lib/pi-web-session-store";

/** Grid row-height baseline (minimum single-row height for h=1; content can grow taller). */
const GRID_ROW_MIN = 64;
/** Max content height for the top zone (scrolls internally so the composer stays visible on the welcome page). */
const TOP_ZONE_MAX_HEIGHT = "min(300px, 38vh)";

// ── Builtin entries ──

/** Builtin widget definitions (builtin: prefix keeps the namespace reserved — extension-registered ids with the same name are ignored). */
function builtinWidgetItems(t: (key: string) => string): NewSessionWidgetItem[] {
  return [
    normalizeWidgetItem({
      id: "builtin:recent",
      title: t("nsw.recentTitle"),
      defaultArea: "top",
      priority: 0,
      w: 4,
      h: 1,
    }),
  ];
}

// ── Data hooks ──

/** Slot items + builtin entries → normalized layout input (extension ids colliding with builtin: are ignored). */
function useNewSessionWidgetItems(): NewSessionWidgetItem[] {
  const extItems = useExtSlotItems("newSessionWidgets");
  const { t } = useI18n();
  return useMemo(() => {
    const out: NewSessionWidgetItem[] = builtinWidgetItems(t);
    for (const it of extItems) {
      if (it.id.startsWith("builtin:")) continue;
      const meta = (it.meta ?? {}) as NewSessionWidgetMeta;
      out.push(
        normalizeWidgetItem({
          id: it.id,
          extId: it.extId,
          title: meta.title ?? (typeof it.meta?.label === "string" ? it.meta.label : undefined) ?? it.id,
          areas: meta.areas,
          defaultArea: meta.defaultArea,
          w: meta.w,
          h: meta.h,
          priority: meta.priority,
        }),
      );
    }
    return out;
  }, [extItems, t]);
}

function emptyPref(): NewSessionWidgetPref {
  return { top: [], bottom: [], hidden: [] };
}

/** Reactive preference (writes on this page + cross-tab storage feedback). */
function useNewSessionWidgetPref(): NewSessionWidgetPref {
  const [pref, setPref] = useState<NewSessionWidgetPref>(() => readNewSessionWidgetPref() ?? emptyPref());
  useEffect(
    () => subscribeNewSessionWidgetPref(() => setPref(readNewSessionWidgetPref() ?? emptyPref())),
    [],
  );
  return pref;
}

// ── Builtin "recent sessions" widget ──

const RECENT_LIMIT = 8;

function cwdLabel(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  const base = trimmed.split(/[\\/]/).pop();
  return base || trimmed;
}

function RecentSessionsWidget() {
  const { t } = useI18n();
  const [sessions, setSessions] = useState<Pick<SessionInfo, "id" | "cwd" | "name" | "firstMessage">[] | null>(null);
  // One-shot fetch (same data source as the top-bar history, no polling);
  // only fires when the welcome page mounts.
  useEffect(() => {
    let alive = true;
    void fetch(apiUrl("/api/sessions"))
      .then((r) => (r.ok ? (r.json() as Promise<{ sessions?: SessionInfo[] }>) : null))
      .then((d) => {
        if (!alive) return;
        const list = (d?.sessions ?? [])
          .slice()
          .sort((a, b) => (b.modified ?? "").localeCompare(a.modified ?? ""))
          .slice(0, RECENT_LIMIT);
        setSessions(list);
      })
      .catch(() => {
        if (alive) setSessions([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  const mutedStyle = { fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)", padding: "6px 2px" } as const;

  if (sessions === null) return <span style={mutedStyle}>…</span>;
  if (sessions.length === 0) return <span style={mutedStyle}>{t("nsw.recentEmpty")}</span>;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        overflowX: "auto",
        overflowY: "hidden",
        scrollbarWidth: "none",
        height: "100%",
        padding: "2px 0",
      }}
    >
      {sessions.map((s) => (
        <button
          key={s.id}
          type="button"
          onClick={() => openSessionById(s.id)}
          title={`${s.name || s.firstMessage || s.id}${s.cwd ? ` · ${s.cwd}` : ""}`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            flexShrink: 0,
            maxWidth: 220,
            border: "1px solid var(--border)",
            borderRadius: 999,
            background: "transparent",
            color: "var(--text)",
            padding: "5px 12px",
            fontSize: 12,
            fontFamily: "var(--font-mono)",
            cursor: "pointer",
            lineHeight: 1.3,
          }}
        >
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {s.name || s.firstMessage || s.id}
          </span>
          {s.cwd && (
            <span style={{ color: "var(--text-muted)", flexShrink: 0 }}>{cwdLabel(s.cwd)}</span>
          )}
        </button>
      ))}
    </div>
  );
}

// ── Render zones ──

export function NewSessionWidgetZone({
  area,
  cwd,
  onEdit,
}: {
  area: NswArea;
  /** Target cwd for the new session (passed through in slot extra; null = extensions degrade on their own). */
  cwd: string | null;
  /** Open the customize panel (ChatWindow owns the panel state). */
  onEdit: () => void;
}) {
  const isMobile = useIsMobile();
  const { t } = useI18n();
  const items = useNewSessionWidgetItems();
  const pref = useNewSessionWidgetPref();
  const layout = useMemo(() => resolveWidgetLayout(items, pref), [items, pref]);
  const byId = useMemo(() => new Map(items.map((it) => [it.id, it])), [items]);
  const cols = isMobile ? 4 : 8;
  const ids = layout[area];

  const editButton = (
    <button
      type="button"
      onClick={onEdit}
      title={t("nsw.customize")}
      aria-label={t("nsw.customize")}
      style={{
        position: "absolute",
        top: 0,
        right: 10,
        zIndex: 5,
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        opacity: 0.35,
        border: "none",
        background: "transparent",
        color: "var(--text-muted)",
        fontSize: 11,
        padding: "3px 6px",
        cursor: "pointer",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.opacity = "1";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.opacity = "0.35";
      }}
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
      </svg>
      {t("nsw.edit")}
    </button>
  );

  const grid = (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gridAutoRows: `minmax(${GRID_ROW_MIN}px, auto)`,
        gap: 8,
        maxWidth: "var(--chat-content-max-width, 820px)",
        margin: "0 auto",
        padding: "0 16px",
      }}
    >
      {ids.map((id) => {
        const item = byId.get(id);
        if (!item) return null;
        const span = Math.min(item.w, cols);
        return (
          <div
            key={id}
            style={{
              gridColumn: `span ${span}`,
              gridRow: item.h > 1 ? `span ${Math.min(item.h, 3)}` : undefined,
              minWidth: 0,
              minHeight: 0,
              overflow: "hidden",
            }}
          >
            {id === "builtin:recent" ? (
              <RecentSessionsWidget />
            ) : (
              <ExtSlot name="newSessionWidgets" extra={{ cwd, isMobile, area }} only={id} />
            )}
          </div>
        );
      })}
    </div>
  );

  // No entries registered: render zero placeholders (bottom keeps the
  // original filler, top renders nothing). All hooks have already run, so
  // lazy extension materialization effects are unaffected by the early
  // return (returning null is not the same as unmounting).
  if (items.length === 0) {
    return area === "bottom" ? <div className="min-h-0 flex-1" /> : null;
  }

  const visibleCount = layout.top.length + layout.bottom.length;

  // No visible entries in this zone: bottom always keeps the original
  // filler; top shows a ghost guide tile when everything is empty.
  if (ids.length === 0) {
    if (area === "bottom") return <div className="min-h-0 flex-1" />;
    if (visibleCount === 0) {
      return (
        <div className="w-full shrink-0" style={{ paddingTop: 8, paddingBottom: 4 }}>
          <div style={{ maxWidth: "var(--chat-content-max-width, 820px)", margin: "0 auto", padding: "0 16px" }}>
            <button
              type="button"
              onClick={onEdit}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                border: "1px dashed var(--border)",
                borderRadius: 10,
                background: "transparent",
                color: "var(--text-dim)",
                fontSize: 12,
                padding: "13px 0",
                cursor: "pointer",
              }}
            >
              <span style={{ fontSize: 14, lineHeight: 1 }}>＋</span>
              {t("nsw.add")}
            </button>
          </div>
        </div>
      );
    }
    return null;
  }

  return (
    <div
      className={`relative w-full ${area === "bottom" ? "min-h-0 flex-1" : "shrink-0"}`}
      style={area === "top" ? { maxHeight: TOP_ZONE_MAX_HEIGHT, overflowY: "auto", paddingTop: 8 } : { overflowY: "auto", paddingTop: 8 }}
    >
      {editButton}
      {grid}
    </div>
  );
}

// ── Customize panel ──

const PANEL_BTN_STYLE = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 24,
  height: 24,
  flexShrink: 0,
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "transparent",
  color: "var(--text)",
  cursor: "pointer",
  padding: 0,
} as const;

function PanelIcon({ path }: { path: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}

const ICON_UP = "M18 15l-6-6-6 6";
const ICON_DOWN = "M6 9l6 6 6-6";
const ICON_EYE = "M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12Z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z";
const ICON_EYE_OFF = "M17.94 17.94A10.07 10.07 0 0 1 12 19c-7 0-11-7-11-7a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 5c7 0 11 7 11 7a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24M1 1l22 22";
const ICON_SWAP = "M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4";

export function NewSessionWidgetsCustomize({ onClose }: { onClose: () => void }) {
  const isMobile = useIsMobile();
  const { t } = useI18n();
  const metas = useExtMetas();
  const items = useNewSessionWidgetItems();
  const pref = useNewSessionWidgetPref();
  const layout = useMemo(() => resolveWidgetLayout(items, pref), [items, pref]);
  const byId = useMemo(() => new Map(items.map((it) => [it.id, it])), [items]);

  // Every operation first materializes the effective order into a complete
  // preference, then mutates it — so entries not yet in the preference can
  // be moved too.
  const write = useCallback(
    (mut: (p: NewSessionWidgetPref) => void) => {
      const p: NewSessionWidgetPref = {
        top: [...layout.top],
        bottom: [...layout.bottom],
        hidden: [...layout.hidden],
      };
      mut(p);
      writeNewSessionWidgetPref(p);
    },
    [layout],
  );

  const move = useCallback(
    (id: string, area: NswArea, delta: -1 | 1) =>
      write((p) => {
        const list = p[area];
        const i = list.indexOf(id);
        const j = i + delta;
        if (i < 0 || j < 0 || j >= list.length) return;
        [list[i], list[j]] = [list[j], list[i]];
      }),
    [write],
  );

  const moveTo = useCallback(
    (id: string, target: NswArea) =>
      write((p) => {
        p.top = p.top.filter((x) => x !== id);
        p.bottom = p.bottom.filter((x) => x !== id);
        p[target].push(id);
      }),
    [write],
  );

  const toggleHidden = useCallback(
    (id: string) =>
      write((p) => {
        if (p.hidden.includes(id)) {
          p.hidden = p.hidden.filter((x) => x !== id);
          const item = byId.get(id);
          const area = item && item.areas.includes(item.defaultArea) ? item.defaultArea : item?.areas[0];
          p[area ?? "top"].push(id);
        } else {
          p.top = p.top.filter((x) => x !== id);
          p.bottom = p.bottom.filter((x) => x !== id);
          p.hidden.push(id);
        }
      }),
    [write, byId],
  );

  const row = (id: string, area: NswArea) => {
    const item = byId.get(id);
    if (!item) return null;
    const idx = layout[area].indexOf(id);
    const list = layout[area];
    const other: NswArea = area === "top" ? "bottom" : "top";
    const canMoveAcross = item.areas.includes(other);
    const extMeta = item.extId ? metas[item.extId] : null;
    return (
      <div key={id} style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 8px 3px 4px" }}>
        <button type="button" onClick={() => move(id, area, -1)} disabled={idx <= 0} title={t("nsw.moveUp")} aria-label={t("nsw.moveUp")} style={{ ...PANEL_BTN_STYLE, opacity: idx <= 0 ? 0.35 : 1 }}>
          <PanelIcon path={ICON_UP} />
        </button>
        <button type="button" onClick={() => move(id, area, 1)} disabled={idx >= list.length - 1} title={t("nsw.moveDown")} aria-label={t("nsw.moveDown")} style={{ ...PANEL_BTN_STYLE, opacity: idx >= list.length - 1 ? 0.35 : 1 }}>
          <PanelIcon path={ICON_DOWN} />
        </button>
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text)", minWidth: 0, padding: "0 2px" }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.title}</span>
          <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0, fontFamily: "var(--font-mono)" }}>
            {item.w}×{item.h}
          </span>
          {extMeta && (
            <span title={extMeta.name ?? item.extId} style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>
              {t("nsw.fromExtension")}
            </span>
          )}
        </div>
        {canMoveAcross && (
          <button type="button" onClick={() => moveTo(id, other)} title={other === "top" ? t("nsw.moveToTop") : t("nsw.moveToBottom")} aria-label={other === "top" ? t("nsw.moveToTop") : t("nsw.moveToBottom")} style={PANEL_BTN_STYLE}>
            <PanelIcon path={ICON_SWAP} />
          </button>
        )}
        <button type="button" onClick={() => toggleHidden(id)} title={t("nsw.hide")} aria-label={t("nsw.hide")} style={PANEL_BTN_STYLE}>
          <PanelIcon path={ICON_EYE} />
        </button>
      </div>
    );
  };

  const section = (area: NswArea) => (
    <>
      <div style={{ padding: "8px 14px 4px", fontSize: 11, fontWeight: 700, color: "var(--text-muted)" }}>
        {area === "top" ? t("nsw.top") : t("nsw.bottom")}
      </div>
      {layout[area].length === 0 ? (
        <div style={{ padding: "2px 14px 6px", fontSize: 11, color: "var(--text-dim)" }}>{t("nsw.emptyArea")}</div>
      ) : (
        layout[area].map((id) => row(id, area))
      )}
    </>
  );

  return createPortal(
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 130 }} onClick={onClose} />
      <div
        role="dialog"
        aria-label={t("nsw.customize")}
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          zIndex: 131,
          width: 360,
          maxWidth: "calc(100vw - 24px)",
          maxHeight: "min(560px, 82dvh)",
          overflowY: "auto",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          boxShadow: "0 8px 24px rgba(0,0,0,0.16)",
          padding: "10px 0 0",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 14px 8px", borderBottom: "1px solid var(--border)" }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>{t("nsw.customize")}</span>
          <button type="button" onClick={onClose} aria-label={t("nsw.close")} style={{ ...PANEL_BTN_STYLE, border: "none", width: 22, height: 22 }}>
            <PanelIcon path="M18 6L6 18M6 6l12 12" />
          </button>
        </div>
        <div style={{ overflowY: "auto", flex: 1, minHeight: 0, paddingBottom: 8 }}>
          {section("top")}
          {section("bottom")}
          {layout.hidden.length > 0 && (
            <>
              <div style={{ padding: "8px 14px 4px", fontSize: 11, fontWeight: 700, color: "var(--text-muted)" }}>
                {t("nsw.hidden")}
              </div>
              {layout.hidden.map((id) => {
                const item = byId.get(id);
                if (!item) return null;
                const extMeta = item.extId ? metas[item.extId] : null;
                return (
                  <div key={id} style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 8px 3px 4px", opacity: 0.55 }}>
                    <button type="button" onClick={() => toggleHidden(id)} title={t("nsw.show")} aria-label={t("nsw.show")} style={PANEL_BTN_STYLE}>
                      <PanelIcon path={ICON_EYE_OFF} />
                    </button>
                    <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text)", minWidth: 0, padding: "0 2px" }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.title}</span>
                      {extMeta && (
                        <span title={extMeta.name ?? item.extId} style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>
                          {t("nsw.fromExtension")}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
        <div style={{ position: "sticky", bottom: 0, display: "flex", justifyContent: "flex-end", gap: 8, padding: "8px 14px", borderTop: "1px solid var(--border)", background: "var(--bg)" }}>
          <button
            type="button"
            onClick={() => resetNewSessionWidgetPref()}
            style={{
              border: "1px solid var(--border)",
              borderRadius: 6,
              background: "transparent",
              color: "var(--text)",
              fontSize: 12,
              padding: "5px 12px",
              cursor: "pointer",
            }}
          >
            {t("nsw.reset")}
          </button>
        </div>
      </div>
    </>,
    document.body,
  );
}
