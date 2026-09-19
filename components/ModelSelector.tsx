"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { ExtSlot } from "./ExtSlots";

export interface ModelSelectorOption {
  provider: string;
  modelId: string;
  name: string;
  /** Current availability (probed by the model-check extension / observed at runtime): ok/rl(429)/err/unprobed — display-only hint */
  status?: "ok" | "rl" | "err" | "unprobed";
  /** This provider is rate-limited as a whole (all its models currently 429) — group-header hint, no auto-disable */
  providerRL?: boolean;
}

interface ModelSelectorProps {
  options: ModelSelectorOption[];
  value?: { provider: string; modelId: string } | null;
  onChange: (provider: string, modelId: string) => void;
  onClear?: () => void;
  emptyLabel?: string;
  selectedLabel?: string;
  disabled?: boolean;
  busy?: boolean;
  /** Model switched mid-run but not yet in effect (takes effect next round) — shows the "next round" badge, does not lock the selector */
  pending?: boolean;
  isAutoSelection?: boolean;
  ariaLabel?: string;
  variant?: "toolbar" | "field";
  placement?: "up" | "auto";
  /** Hide the trigger button's leading icon (v4 16th review: save width in the narrow small-screen
      input bar / ⓘ sheet — the model name still truncates with
      ellipsis; the spinner still shows while busy switching, so in-progress feedback isn't lost). */
  hideIcon?: boolean;
  /** Manually refresh the model catalog (the "refresh model list" row in the dropdown header; not rendered when omitted — zero intrusion). */
  onRefresh?: () => void;
  /** Refresh in progress: the refresh row spins and is disabled, and the other options are disabled too to avoid mis-clicks. */
  refreshing?: boolean;
}

const MODEL_FILTER_THRESHOLD = 8;
export const RECENT_MODELS_KEY = "pi-web:recent-models";

// ── Panel geometry (fixed positioning baseline = layout viewport; key to coexisting with the
// mobile keyboard)──
// The mobile keyboard popping up/collapsing changes visualViewport and triggers the root height
// reflow of useViewportHeight (the composer moves with it); if the panel computed its geometry
// only once at open, it would be misplaced and resize erratically on later re-renders. So: while
// open, listen to viewport events to trigger re-renders; on every render re-measure the anchor
// and clamp the panel to the "visible area" (anchor hidden behind the keyboard → bottom edge
// pushed above the keyboard; space/caps computed from the visible height).
export interface PanelViewport {
  /** layout viewport height (the position:fixed baseline) */
  layoutHeight: number;
  /** Visible-area top/bottom edges (layout coordinates): compressed when the keyboard is up */
  visibleTop: number;
  visibleBottom: number;
}

/** Reads the current viewport snapshot (called during render) */
export function measurePanelViewport(): PanelViewport {
  const layoutHeight = window.innerHeight;
  const viewport = window.visualViewport;
  if (!viewport) return { layoutHeight, visibleTop: 0, visibleBottom: layoutHeight };
  return { layoutHeight, visibleTop: viewport.offsetTop, visibleBottom: viewport.offsetTop + viewport.height };
}

export interface PanelGeometry {
  openAbove: boolean;
  maxHeight: number;
  /** layout coordinates (either top or bottom) */
  top?: number;
  bottom?: number;
}

const PANEL_GAP = 6;
const PANEL_MIN_HEIGHT = 120;
const PANEL_MAX_HEIGHT_RATIO = 0.6;

/**
 * Computes panel geometry from the anchor rect + viewport snapshot (pure function; inputs/outputs
 * are all layout coordinates). Without the keyboard (visibleTop=0/visibleBottom=layoutHeight) it
 * matches the historical behavior of expanding above a fixed anchor; with the keyboard up, the
 * panel compresses into the visible area as a whole — no longer hidden behind the keyboard or
 * jumping across reflows.
 */
export function computePanelGeometry(
  anchor: { top: number; bottom: number },
  viewport: PanelViewport,
  placement: "up" | "auto",
): PanelGeometry {
  const visibleHeight = viewport.visibleBottom - viewport.visibleTop;
  const spaceAbove = anchor.top - viewport.visibleTop - PANEL_GAP;
  const spaceBelow = viewport.visibleBottom - anchor.bottom - PANEL_GAP;
  const openAbove = placement === "up" || spaceAbove > spaceBelow;
  if (openAbove) {
    // Desired bottom edge = a gap above the anchor; anchor hidden behind the keyboard (below the
    // visible bottom) → clamp to just above the visible bottom;
    // anchor scrolled out of the visible top (desired ≤ visibleTop) → the panel expands flush
    // with the bottom of the visible area.
    const desired = anchor.top - PANEL_GAP;
    const bottomEdge = desired <= viewport.visibleTop
      ? viewport.visibleBottom - PANEL_GAP
      : Math.min(desired, viewport.visibleBottom - PANEL_GAP);
    const maxHeight = Math.max(
      PANEL_MIN_HEIGHT,
      Math.min(bottomEdge - viewport.visibleTop - PANEL_GAP, visibleHeight * PANEL_MAX_HEIGHT_RATIO),
    );
    return { openAbove, maxHeight, bottom: viewport.layoutHeight - bottomEdge };
  }
  const desired = anchor.bottom + PANEL_GAP;
  const topEdge = desired >= viewport.visibleBottom
    ? viewport.visibleTop + PANEL_GAP
    : Math.max(desired, viewport.visibleTop + PANEL_GAP);
  const maxHeight = Math.max(
    PANEL_MIN_HEIGHT,
    Math.min(viewport.visibleBottom - PANEL_GAP - topEdge, visibleHeight * PANEL_MAX_HEIGHT_RATIO),
  );
  return { openAbove, maxHeight, top: topEdge };
}
export const RECENT_MODELS_LIMIT = 8;
const MODEL_OPTION_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export interface RecentModelEntry {
  provider: string;
  modelId: string;
  at: number;
}

/** Reads recently used models (persisted in localStorage; corrupt/invalid entries silently ignored) */
export function readRecentModels(): RecentModelEntry[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(RECENT_MODELS_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is RecentModelEntry =>
      !!entry && typeof entry === "object"
      && typeof (entry as RecentModelEntry).provider === "string"
      && typeof (entry as RecentModelEntry).modelId === "string"
    );
  } catch {
    return [];
  }
}

/** Records one model use: move-to-front + dedupe + truncate (LRU) */
export function rememberRecentModel(provider: string, modelId: string) {
  try {
    const rest = readRecentModels().filter((entry) => entry.provider !== provider || entry.modelId !== modelId);
    window.localStorage.setItem(RECENT_MODELS_KEY, JSON.stringify(
      [{ provider, modelId, at: Date.now() }, ...rest].slice(0, RECENT_MODELS_LIMIT),
    ));
  } catch {
    /* localStorage unavailable (private mode etc.) → silently degrade to no recents */
  }
}

/**
 * Recents → panel section entries: only when the panel is open and not filtering; ordered by
 * recorded time desc; only models still available are kept (deleted/removed ones disappear
 * automatically); deduped; truncated to RECENT_MODELS_LIMIT.
 * provider/modelId are joined field-wise as the Map key, never split — model ids containing "/"
 * are safe.
 */
export function pickRecentOptions(
  recentList: RecentModelEntry[],
  sortedOptions: ModelSelectorOption[],
  opts: { open: boolean; filter: string },
): ModelSelectorOption[] {
  if (!opts.open || opts.filter.trim()) return [];
  const byKey = new Map(sortedOptions.map((option) => [`${option.provider}/${option.modelId}`, option] as const));
  const picked: ModelSelectorOption[] = [];
  for (const entry of recentList) {
    if (picked.length >= RECENT_MODELS_LIMIT) break;
    const option = byKey.get(`${entry.provider}/${entry.modelId}`);
    if (option && !picked.includes(option)) picked.push(option);
  }
  return picked;
}

function compareModelOptions(a: ModelSelectorOption, b: ModelSelectorOption): number {
  return MODEL_OPTION_COLLATOR.compare(a.name || a.modelId, b.name || b.modelId)
    || MODEL_OPTION_COLLATOR.compare(a.provider, b.provider)
    || MODEL_OPTION_COLLATOR.compare(a.modelId, b.modelId);
}

export function filterModelOptions(options: ModelSelectorOption[], query: string): ModelSelectorOption[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return options;

  // provider participates in matching: the provider suffix is shown inline, so searching a provider name should hit its models
  return options.filter((option) => (
    `${option.provider} ${option.name} ${option.modelId}`
      .toLocaleLowerCase()
      .includes(normalizedQuery)
  ));
}

/**
 * Removes entries already shown in the "recents" section from the main list — the same model no
 * longer appears twice in the panel
 * (2026-09-14 user report: the zcode list showed two identical adjacent rows, the recents section
 * duplicating the grouped list below. Only removed in non-filtering mode: search must be able to
 * hit every model, including recents).
 * provider/modelId joined field-wise as the key; with no match / an empty recents section,
 * options are returned unchanged.
 */
export function excludeRecentOptions(
  options: ModelSelectorOption[],
  recentOptions: ModelSelectorOption[],
): ModelSelectorOption[] {
  if (recentOptions.length === 0) return options;
  const recentKeys = new Set(recentOptions.map((option) => `${option.provider}/${option.modelId}`));
  return options.filter((option) => !recentKeys.has(`${option.provider}/${option.modelId}`));
}

export function ModelSelector({
  options,
  value,
  onChange,
  onClear,
  emptyLabel,
  selectedLabel,
  disabled = false,
  busy = false,
  pending = false,
  isAutoSelection = false,
  ariaLabel,
  variant = "toolbar",
  placement = "up",
  hideIcon = false,
  onRefresh,
  refreshing = false,
}: ModelSelectorProps) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // Viewport change counter while the panel is open: only triggers re-renders; geometry is recomputed from live values at render time (see the effect below)
  const [viewportTick, setViewportTick] = useState(0);
  const [filter, setFilter] = useState("");
  const [recentList, setRecentList] = useState<RecentModelEntry[]>([]);
  const locked = disabled || busy;
  const sortedOptions = useMemo(() => [...options].sort(compareModelOptions), [options]);
  const filteredOptions = filterModelOptions(sortedOptions, filter);
  const showFilter = sortedOptions.length > MODEL_FILTER_THRESHOLD;

  // Re-read recents each time the panel opens (other windows / other ModelSelector instances may have updated them)
  useEffect(() => {
    if (open) setRecentList(readRecentModels());
  }, [open]);

  // Track the visible viewport while the panel is open: the mobile keyboard popping up/collapsing
  // (visualViewport resize/scroll + focus changes) compresses the visible area and triggers the
  // root height reflow; re-renders merged via rAF → the panel re-anchors in real time.
  useEffect(() => {
    if (!open) return;
    let frameId: number | null = null;
    const schedule = () => {
      if (frameId !== null) return;
      frameId = requestAnimationFrame(() => {
        frameId = null;
        setViewportTick((tick) => tick + 1);
      });
    };
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("focusin", schedule);
    window.addEventListener("focusout", schedule);
    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("focusin", schedule);
      window.removeEventListener("focusout", schedule);
    };
  }, [open]);

  // Recents → ordered by use time desc, keeping only models still available (deleted/removed ones disappear automatically)
  const recentOptions = useMemo(
    () => pickRecentOptions(recentList, sortedOptions, { open, filter }),
    [open, filter, sortedOptions, recentList],
  );
  // Entries already shown in the recents section are removed from the main list (each model appears once; while filtering recentOptions=[] so nothing is removed)
  const mainOptions = useMemo(
    () => excludeRecentOptions(filteredOptions, recentOptions),
    [filteredOptions, recentOptions],
  );
  const modelsByProvider: { provider: string; options: ModelSelectorOption[] }[] = [];

  for (const option of mainOptions) {
    const group = modelsByProvider.find((item) => item.provider === option.provider);
    if (group) group.options.push(option);
    else modelsByProvider.push({ provider: option.provider, options: [option] });
  }

  const currentName = selectedLabel ?? (value
    ? sortedOptions.find((option) => option.modelId === value.modelId && option.provider === value.provider)?.name ?? value.modelId
    : emptyLabel ?? (sortedOptions.length > 0 ? "Select model" : "No models"));

  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      if (
        rootRef.current && !rootRef.current.contains(event.target as Node)
        && panelRef.current && !panelRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
        setFilter("");
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, []);

  useEffect(() => {
    if (!locked) return;
    setOpen(false);
    setFilter("");
  }, [locked]);

  const buttonStyle: CSSProperties = variant === "field"
    ? {
        display: "flex",
        alignItems: "center",
        gap: 7,
        width: "100%",
        minWidth: 0,
        height: 34,
        padding: "0 9px",
        overflow: "hidden",
        border: "1px solid var(--border)",
        borderRadius: 5,
        background: locked ? "var(--bg-panel)" : "var(--bg)",
        color: locked ? "var(--text-dim)" : "var(--text)",
        cursor: locked ? "default" : "pointer",
        fontSize: 12,
        textAlign: "left",
      }
    : {
        display: "flex",
        alignItems: "center",
        justifyContent: isMobile ? "flex-start" : undefined,
        gap: 6,
        width: isMobile ? "100%" : undefined,
        maxWidth: isMobile ? "100%" : 220,
        height: 32,
        padding: isMobile ? "8px 10px" : "8px 12px",
        overflow: "hidden",
        border: "none",
        borderRadius: 9,
        background: open ? "var(--bg-hover)" : "none",
        color: "var(--text-muted)",
        cursor: locked ? "not-allowed" : "pointer",
        fontSize: 12,
        opacity: locked ? 0.5 : 1,
        transition: "background 0.12s, color 0.12s",
      };

  const choose = (option: ModelSelectorOption) => {
    if (refreshing) return; // no selection while refreshing (the button layer is also disabled; this guards keyboard/double-click)
    const active = option.modelId === value?.modelId && option.provider === value?.provider;
    rememberRecentModel(option.provider, option.modelId);
    setOpen(false);
    setFilter("");
    if (!active || isAutoSelection) onChange(option.provider, option.modelId);
  };

  return (
    <div
      ref={rootRef}
      className={`model-selector is-${variant}${locked ? " is-disabled" : ""}`}
      style={{ position: "relative", width: variant === "field" || isMobile ? "100%" : undefined, minWidth: 0, flex: variant === "toolbar" && isMobile ? "1 1 auto" : undefined }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.preventDefault();
        event.stopPropagation();
        setFilter("");
        setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-busy={busy || undefined}
        disabled={locked}
        title={busy ? "Switching model" : locked ? currentName : sortedOptions.length > 0 || onClear ? "Change model" : "No available models"}
        style={buttonStyle}
        onClick={() => {
          setOpen((current) => {
            if (current) setFilter("");
            return !current;
          });
        }}
        onMouseEnter={(event) => {
          if (locked) return;
          event.currentTarget.style.background = "var(--bg-hover)";
          event.currentTarget.style.color = "var(--text)";
        }}
        onMouseLeave={(event) => {
          if (locked) {
            event.currentTarget.style.background = variant === "field" ? "var(--bg-panel)" : "none";
            event.currentTarget.style.color = variant === "field" ? "var(--text-dim)" : "var(--text-muted)";
            return;
          }
          event.currentTarget.style.background = open ? "var(--bg-hover)" : variant === "field" ? "var(--bg)" : "none";
          event.currentTarget.style.color = variant === "field" ? "var(--text)" : "var(--text-muted)";
        }}
      >
        {busy ? (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" style={{ animation: "spin 0.8s linear infinite", flexShrink: 0 }} aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
          </svg>
        ) : hideIcon ? null : (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
            <rect x="4" y="4" width="16" height="16" rx="2" />
            <rect x="9" y="9" width="6" height="6" />
            <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
            <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
            <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
            <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
          </svg>
        )}
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{currentName}</span>
        {pending && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 3, flexShrink: 0, marginLeft: 4, fontSize: 10, color: "#d97706", whiteSpace: "nowrap", fontWeight: 600 }}>
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
            {t("chat.modelSwitchPendingBadge")}
          </span>
        )}
        {variant === "field" && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, color: "var(--text-dim)" }}>
            <polyline points="6 9 12 15 18 9" />
          </svg>
        )}
      </button>

      {open && (() => {
        void viewportTick; // viewport changes → the effect above triggers the re-render; re-measure anchor/viewport here on every render
        const anchor = buttonRef.current?.getBoundingClientRect();
        if (!anchor) return null;
        // v4 7th review (user decision): the small-screen model panel goes fullscreen full-height —
        // an anchored popup squashed by maxHeight is unusable on small screens;
        // desktop (!isMobile) keeps the original anchored geometry unchanged.
        const geometry = computePanelGeometry(anchor, measurePanelViewport(), placement);
        const horizontalPosition: CSSProperties = { left: anchor.left, width: "max-content", minWidth: anchor.width, maxWidth: Math.max(anchor.width, (window.visualViewport?.width ?? window.innerWidth) - anchor.left - 8) };

        return (
          <div
            ref={panelRef}
            role="listbox"
            aria-label={ariaLabel}
            data-input-overlay="1"
            style={isMobile ? {
              position: "fixed",
              inset: 0,
              zIndex: 500,
              display: "flex",
              flexDirection: "column",
              background: "var(--bg)",
              overflow: "hidden",
            } : {
              position: "fixed",
              ...(geometry.top !== undefined ? { top: geometry.top } : { bottom: geometry.bottom }),
              ...horizontalPosition,
              zIndex: 500,
              display: "flex",
              flexDirection: "column",
              maxHeight: geometry.maxHeight,
              overflow: "hidden",
              border: "1px solid var(--border)",
              borderRadius: 8,
              background: "var(--bg)",
              boxShadow: geometry.openAbove ? "0 -4px 16px rgba(0,0,0,0.10)" : "0 4px 16px rgba(0,0,0,0.10)",
            }}
          >
            {isMobile && (
              <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
                <span style={{ fontWeight: 600, fontSize: 13.5 }}>{ariaLabel ?? t("chat.sheetModel")}</span>
                <button
                  type="button"
                  aria-label={t("chat.collapseControls")}
                  onClick={() => setOpen(false)}
                  style={{ marginLeft: "auto", width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", borderRadius: 8, color: "var(--text-muted)", cursor: "pointer", fontSize: 15, lineHeight: 1 }}
                >
                  ✕
                </button>
              </div>
            )}
            {showFilter && (
              <div style={{ flexShrink: 0, padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
                <input
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder={t("chat.filterModels")}
                  aria-label={t("chat.filterModels")}
                  // No auto-focus on mobile: auto-focus immediately pops the keyboard, compressing
                  // the visible area and squeezing the just-opened list into a sliver; let the user
                  // browse first — the keyboard pops when they tap the filter box (the geometry
                  // tracking catches it)
                  autoFocus={!isMobile}
                  autoComplete="off"
                  spellCheck={false}
                  style={{
                    boxSizing: "border-box",
                    width: "100%",
                    minWidth: isMobile ? 0 : 220,
                    padding: "5px 8px",
                    border: "1px solid var(--border)",
                    borderRadius: 5,
                    outline: "none",
                    background: "var(--bg)",
                    color: "var(--text)",
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                  }}
                />
              </div>
            )}
            <div style={{ minHeight: 0, overflowY: "auto", ...(isMobile ? { flex: 1 } : null) }}>
              {onRefresh && (
                <ModelRefreshRow
                  refreshing={refreshing}
                  label={t("chat.refreshModels")}
                  refreshingLabel={t("chat.refreshingModels")}
                  onClick={onRefresh}
                />
              )}
              {onClear && !filter.trim() && (
                <ModelOptionButton active={!value} label={emptyLabel ?? "Default"} disabled={refreshing} onClick={() => {
                  if (refreshing) return;
                  setOpen(false);
                  setFilter("");
                  onClear();
                }} />
              )}
              {recentOptions.length > 0 && (
                <div key="recent">
                  <div style={{ padding: "6px 12px 4px", borderTop: onClear ? "1px solid var(--border)" : "none", color: "var(--text-dim)", fontSize: 10, fontWeight: 600, letterSpacing: 0, textTransform: "uppercase", display: "flex", alignItems: "center", gap: 5 }}>
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
                    {t("chat.recentModels")}
                  </div>
                  {recentOptions.map((option) => (
                    <ModelOptionButton
                      key={`recent:${option.provider}:${option.modelId}`}
                      active={option.modelId === value?.modelId && option.provider === value?.provider}
                      label={option.name}
                      hint={option.provider}
                      status={option.status}
                      disabled={refreshing}
                      onClick={() => choose(option)}
                    />
                  ))}
                </div>
              )}
              {filteredOptions.length === 0 ? (
                <div style={{ padding: "8px 12px", color: "var(--text-dim)", fontSize: 12, whiteSpace: "nowrap" }}>
                  {filter.trim() ? t("chat.noMatchingModels") : "No available models"}
                </div>
              ) : modelsByProvider.map((group, index) => (
                <div key={group.provider}>
                  {modelsByProvider.length > 1 && (
                    <div style={{ padding: "6px 12px 4px", borderTop: index > 0 || onClear || recentOptions.length > 0 ? "1px solid var(--border)" : "none", color: "var(--text-dim)", fontSize: 10, fontWeight: 600, letterSpacing: 0, textTransform: "uppercase", display: "flex", alignItems: "center", gap: 6 }}>
                      {group.provider}
                      {group.options.some((o) => o.providerRL) && (
                        <span style={{ color: "#d97706", fontSize: 9, fontWeight: 700, textTransform: "none", letterSpacing: 0, padding: "0 6px", borderRadius: 999, border: "1px solid rgba(245,158,11,.55)", background: "rgba(245,158,11,.12)", whiteSpace: "nowrap" }} title="All models for this provider are currently rate-limited (429) — informational only, nothing is auto-disabled">⛔ provider-wide 429</span>
                      )}
                    </div>
                  )}
                  {group.options.map((option) => (
                    <ModelOptionButton
                      key={`${option.provider}:${option.modelId}`}
                      active={option.modelId === value?.modelId && option.provider === value?.provider}
                      label={option.name}
                      hint={option.provider}
                      status={option.status}
                      disabled={refreshing}
                      onClick={() => choose(option)}
                    />
                  ))}
                </div>
              ))}
            </div>
            {/* Dropdown footer action area (the model-wizard extension's "manage models" entry):
                the management UI lives entirely on the extension side — zero render, zero regression
                when unregistered; the core only hands over the collapse callback (collapse the
                dropdown before opening the wizard float).
                Positioned after the scroll list closes = a panel-level fixed bottom row that does
                not scroll with the list. */}
            <ExtSlot
              name="modelSelectorFooter"
              extra={{ onClose: () => { setOpen(false); setFilter(""); } }}
            />
          </div>
        );
      })()}
    </div>
  );
}

/** Option row (exported solely for unit-test render assertions): name + provider suffix + availability status; the same information on desktop and small screens. */
export function ModelOptionButton({ active, label, hint, status, disabled = false, onClick }: { active: boolean; label: string; hint?: string; status?: ModelSelectorOption["status"]; disabled?: boolean; onClick: () => void }) {
  const statusMark = status === "rl"
    ? <span style={{ flexShrink: 0, fontSize: 9, fontWeight: 700, color: "#b45309", padding: "0 6px", borderRadius: 999, border: "1px solid rgba(245,158,11,.55)", background: "rgba(245,158,11,.14)" }} title="Currently rate-limited (429) — selecting it may be rejected by cooldown; informational only, nothing is auto-disabled">429</span>
    : status === "err"
      ? <span style={{ flexShrink: 0, fontSize: 9, fontWeight: 700, color: "#dc2626", padding: "0 6px", borderRadius: 999, border: "1px solid rgba(239,68,68,.5)", background: "rgba(239,68,68,.1)" }} title="Current probe error (non-rate-limit failure) — informational only, nothing is auto-disabled">✗ error</span>
      : status === "unprobed"
        ? <span style={{ flexShrink: 0, fontSize: 9, color: "var(--text-dim)", padding: "0 6px", borderRadius: 999, border: "1px solid var(--border)", background: "var(--bg-subtle,#f5f5f5)" }} title="Availability not probed yet (model check has not run)">untested</span>
        : null;
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      disabled={disabled || undefined}
      onClick={onClick}
      style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 12px", border: "none", background: active ? "var(--bg-selected)" : "none", color: active ? "var(--text)" : "var(--text-muted)", cursor: disabled ? "default" : "pointer", fontSize: 12, fontWeight: active ? 600 : 400, textAlign: "left", whiteSpace: "nowrap", opacity: disabled && !active ? 0.55 : undefined }}
      onMouseEnter={(event) => { if (!active) event.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(event) => { if (!active) event.currentTarget.style.background = "none"; }}
    >
      {active
        ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true"><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
        : <span style={{ width: 10, flexShrink: 0 }} />}
      <span title={label} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
      {statusMark}
      {hint && hint !== label ? (
        // Small screens no longer hide the provider suffix (2026-09-13): the same information on
        // desktop and small screens — the small-screen panel is already fullscreen full-height
        // (plenty of width), and the "recents" section has no group headers, so with the suffix
        // hidden, same-named models across providers would be indistinguishable. maxWidth is a
        // backstop against an over-long provider squeezing out the model name (consistent on both).
        <span style={{ marginLeft: "auto", flexShrink: 0, paddingLeft: 14, maxWidth: "45%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 10, fontWeight: 400, color: "var(--text-dim)", opacity: 0.8 }} title={hint}>{hint}</span>
      ) : null}
    </button>
  );
}

/** The dropdown-header "refresh model list" row (exported solely for unit-test render assertions). Spins + disabled while refreshing; clicking keeps the panel open. */
export function ModelRefreshRow({ refreshing, label, refreshingLabel, onClick }: { refreshing: boolean; label: string; refreshingLabel: string; onClick: () => void }) {
  return (
    <button
      type="button"
      data-model-refresh={refreshing ? "busy" : "idle"}
      disabled={refreshing || undefined}
      onClick={() => { if (!refreshing) onClick(); }}
      style={{ display: "flex", alignItems: "center", gap: 7, width: "100%", padding: "8px 12px", background: "none", border: "none", borderBottom: "1px solid var(--border)", color: refreshing ? "var(--text-dim)" : "var(--text-muted)", cursor: refreshing ? "default" : "pointer", fontSize: 12, textAlign: "left" }}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, ...(refreshing ? { animation: "pi-refresh-spin 1s linear infinite" } : {}) }}>
        <path d="M21 12a9 9 0 1 1-2.64-6.36" /><polyline points="21 3 21 9 15 9" />
      </svg>
      {refreshing ? refreshingLabel : label}
      {refreshing && <style>{"@keyframes pi-refresh-spin{to{transform:rotate(360deg)}}"}</style>}
    </button>
  );
}
