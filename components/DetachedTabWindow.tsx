"use client";

import type { ReactNode } from "react";
import { getFileIcon, FolderIcon } from "./FileIcons";
import type { Tab } from "./TabBar";

/**
 * Detached window shell (the floating-dialog extension's tab-detach design §5.5):
 * the host renders a fixed window shell and stamps the `data-ext-float` attribute
 * family on the shell root → the floating-dialog extension's scan() automatically
 * takes over dragging / eight-way resizing / ⛶❐ maximize / position persistence /
 * click-to-front / small-screen fullscreen / viewport clamping (float only reads
 * DOM attributes, not render sources — the host contains zero gesture code).
 *
 * ⚠️ Hard rule (design §2): style must not contain left/top/transform/width/height/
 * z-index — geometry belongs entirely to float (once float takes over it writes DOM
 * inline styles with !important; React re-renders only patch attributes declared and
 * changed in JSX, leaving undeclared positioning attributes untouched). Initial size
 * is passed via data-ext-float-w/-h. The React-rendered buttons inside the handle
 * (⇲/✕) are structurally static; the ⛶ injected by float is an extra sibling node,
 * so there is no key-diff conflict (same mechanism as extension dialogs, stable
 * long-term).
 */
export function DetachedTabWindow({
  tab,
  initW,
  initH,
  dockBackLabel,
  closeLabel,
  onDockBack,
  onClose,
  children,
}: {
  tab: Tab;
  initW: number;
  initH: number;
  dockBackLabel: string;
  closeLabel: string;
  onDockBack: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      data-ext-float="1"
      data-ext-float-key={`tabwin:${tab.id}`}
      data-ext-float-pos="asis"
      data-ext-float-w={initW}
      data-ext-float-h={initH}
      data-ext-float-full="1"
      data-ext-float-min-w="320"
      data-ext-float-min-h="200"
      role="dialog"
      aria-label={tab.label}
      style={{
        position: "fixed",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        boxShadow: "0 8px 32px rgba(0,0,0,.18)",
        overflow: "hidden",
      }}
    >
      <header
        data-ext-float-drag="1"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          height: 36,
          padding: "0 6px 0 12px",
          background: "var(--bg-panel)",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
          userSelect: "none",
        }}
      >
        <span style={{ flexShrink: 0, display: "flex", alignItems: "center", opacity: 0.8 }}>
          {tab.kind === "folder" ? <FolderIcon size={13} open /> : tab.kind === "terminal" ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
            </svg>
          ) : getFileIcon(tab.label, 13)}
        </span>
        <span
          style={{ flex: 1, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          title={tab.filePath}
        >
          {tab.label}
        </span>
        <button
          type="button"
          onClick={onDockBack}
          title={dockBackLabel}
          aria-label={dockBackLabel}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 26, height: 26, padding: 0,
            background: "transparent", border: "none", borderRadius: 4,
            color: "var(--text-dim)", cursor: "pointer", flexShrink: 0,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "transparent"; }}
        >
          {/* ⇲ dock back into the right panel */}
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="4 14 4 20 10 20" /><polyline points="20 10 20 4 14 4" /><line x1="14" y1="10" x2="20" y2="4" /><line x1="10" y1="14" x2="4" y2="20" />
          </svg>
        </button>
        {/* float's ensureMaxBtn automatically injects ⛶/❐ to the left of ✕ (the host does not render a maximize button) */}
        <button
          type="button"
          onClick={onClose}
          title={closeLabel}
          aria-label={`${closeLabel} ${tab.label}`}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 26, height: 26, padding: 0,
            background: "transparent", border: "none", borderRadius: 4,
            color: "var(--text-dim)", cursor: "pointer", flexShrink: 0,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "transparent"; }}
        >
          <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <line x1="2" y1="2" x2="8" y2="8" />
            <line x1="8" y1="2" x2="2" y2="8" />
          </svg>
        </button>
      </header>
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        {children}
      </div>
    </div>
  );
}
