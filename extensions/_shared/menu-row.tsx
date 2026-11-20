/**
 * MenuActionRow — the one row shape for action entries at the bottom of a dropdown
 * (project menu: "Use default directory" / "Browse folders…" / injected workspace
 * actions; the new-session workspace menu reuses the same body, so it gets the same rows).
 *
 * Why a shared component: the rows used to be hand-styled per extension (padding/font/icon
 * size drifted, dim text made "Custom path…" read as a label instead of a button). One
 * component keeps them recognizable as actions in every menu.
 *
 * Theme: colors come from host CSS vars only (no literal values); hover is local state
 * because inline styles cannot express :hover.
 */
import { useState, type ReactNode } from "react";

/** The row's base look: full width, 12px, readable (not dim) text, 8/12 padding. */
export const MENU_ACTION_ROW_STYLE: Record<string, string | number> = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  minHeight: 30,
  padding: "6px 12px",
  border: 0,
  borderRadius: 0,
  background: "none",
  color: "var(--text-muted)",
  fontFamily: "inherit",
  fontSize: 12,
  lineHeight: 1.35,
  textAlign: "left",
  cursor: "pointer",
};

/** Footer container: a divider above the action group (no section caption by design). */
export const MENU_GROUP_STYLE: Record<string, string | number> = {
  flexShrink: 0,
  borderTop: "1px solid var(--border)",
  paddingTop: 4,
  paddingBottom: 4,
};

export interface MenuActionRowProps {
  /** Leading icon (13px), rendered in the muted color unless the row is emphasized. */
  icon?: ReactNode;
  label: string;
  /** Tooltip: say what the row does (e.g. "Browse the filesystem to pick any folder"). */
  title?: string;
  /** The row reads as the primary way out of the list (folder browser). */
  emphasized?: boolean;
  disabled?: boolean;
  /** Trailing content (shortcut, count, caret). */
  trailing?: ReactNode;
  onClick: (event: { stopPropagation: () => void }) => void;
}

export function MenuActionRow(props: MenuActionRowProps) {
  const { icon, label, title, emphasized = false, disabled = false, trailing, onClick } = props;
  const [hovered, setHovered] = useState(false);
  const active = hovered && !disabled;
  return (
    <button
      type="button"
      className={`menu-action-row${emphasized ? " is-emphasized" : ""}`}
      title={title ?? label}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick({ stopPropagation: () => event.stopPropagation() });
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        ...MENU_ACTION_ROW_STYLE,
        color: disabled ? "var(--text-dim)" : active || emphasized ? "var(--text)" : "var(--text-muted)",
        background: active ? "var(--bg-hover)" : "none",
        opacity: disabled ? 0.55 : 1,
        cursor: disabled ? "default" : "pointer",
      }}
    >
      {icon ? (
        <span
          aria-hidden="true"
          style={{ display: "inline-flex", flexShrink: 0, color: emphasized || active ? "var(--text)" : "var(--text-dim)" }}
        >
          {icon}
        </span>
      ) : null}
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      {trailing ? <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 11 }}>{trailing}</span> : null}
    </button>
  );
}
