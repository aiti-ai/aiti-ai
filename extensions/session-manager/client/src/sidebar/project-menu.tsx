/**
 * sidebar/project-menu — the project menu body shared by the sidebar CWD picker and the
 * new-session Workspace selector (one list, one set of actions, one look).
 *
 * Contents (order): optional filter field, the project rows (pinned first, current checked,
 * activity badges, "~" labels, hover pin), then the action group: "Use default directory",
 * "Browse folders…" (the directory browser) and the extension footer
 * (workspacePickerActions: get / upload / manage a workspace).
 *
 * Callers own the trigger/anchoring and what "picking" means:
 *  - sidebar: switch the app's cwd (onCwdChange);
 *  - new session: stage the target through the "pi-web.newSession" service.
 * Data filtering/ordering stays in the caller (it already owns the hidden list and pins).
 */
import { useState, type CSSProperties, type ReactNode } from "react";
import { t } from "../host-shim";
import { displayCwd, type RecentProject } from "./pure";
import { PathLabel, showProjectActivity, isSmallScreen } from "./parts";
import { SIc } from "../helpers";
import { MENU_GROUP_STYLE, MenuActionRow } from "../../../../_shared/menu-row";

export interface ProjectMenuFilter {
  value: string;
  onChange: (value: string) => void;
  show: boolean;
  /** Escape in the filter: close the menu (falls back to just clearing the query). */
  onEscape?: () => void;
}

export interface ProjectMenuBodyProps {
  /** Visible projects: already filtered by the hidden list + the query, already pinned-ordered. */
  projects: readonly RecentProject[];
  selectedKey: string | null;
  homeDir: string;
  activity: Map<string, { running: number; unread: number }>;
  pinnedKeys?: readonly string[];
  onTogglePin?: (key: string) => void;
  filter: ProjectMenuFilter;
  onPick: (root: string) => void;
  onUseDefault: () => void;
  onBrowse: () => void;
  /** workspacePickerActions slot element (caller supplies its extra props). */
  actions?: ReactNode;
  /** Labels come from the caller so the shared body carries no i18n keys of its own. */
  labels: {
    filterPlaceholder: string;
    noMatch: string;
    useDefault: string;
    useDefaultTitle: string;
    browse: string;
    browseTitle: string;
  };
  listStyle?: CSSProperties;
}

function HomeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 7.2 8 2.2l6 5" />
      <path d="M3.4 6.4V13h9.2V6.4" />
      <path d="M6.6 13V9.6h2.8V13" />
    </svg>
  );
}

function FolderBrowseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1.5 4.2h4l1.4 1.8h7.6v6.6h-13z" />
      <circle cx="8" cy="8.3" r="1.6" />
      <path d="M6.2 9.9 5.1 11" />
    </svg>
  );
}

export function ProjectMenuBody(props: ProjectMenuBodyProps) {
  const { projects, filter, labels } = props;
  const showNoMatch = projects.length === 0 && Boolean(filter.value.trim());
  return (
    <>
      {filter.show && (
        <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <input
            value={filter.value}
            onChange={(event) => filter.onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              filter.onChange("");
              if (filter.onEscape) filter.onEscape();
              else (event.currentTarget as HTMLInputElement).blur();
            }}
            placeholder={labels.filterPlaceholder}
            autoFocus={!isSmallScreen()}
            aria-label={labels.filterPlaceholder}
            style={{
              width: "100%",
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              padding: "5px 8px",
              border: "1px solid var(--border)",
              borderRadius: 5,
              outline: "none",
              background: "var(--bg)",
              color: "var(--text)",
              boxSizing: "border-box",
            }}
          />
        </div>
      )}
      <div style={{ flex: "1 1 auto", minHeight: 0, maxHeight: "min(50vh, 380px)", overflowY: "auto", ...props.listStyle }}>
        {projects.map((project) => (
          <ProjectRow
            key={project.key}
            project={project}
            selected={project.key === props.selectedKey}
            pinned={!!props.pinnedKeys?.includes(project.key)}
            activity={props.activity.get(project.key)}
            homeDir={props.homeDir}
            onPick={props.onPick}
            onTogglePin={props.onTogglePin}
          />
        ))}
        {showNoMatch && (
          <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--text-dim)" }}>{labels.noMatch}</div>
        )}
      </div>

      <div style={MENU_GROUP_STYLE}>
        <MenuActionRow icon={<HomeIcon />} label={labels.useDefault} title={labels.useDefaultTitle} onClick={props.onUseDefault} />
        <MenuActionRow icon={<FolderBrowseIcon />} label={labels.browse} title={labels.browseTitle} emphasized onClick={props.onBrowse} />
        {props.actions ? (
          <div style={{ borderTop: "1px solid var(--border)", marginTop: 4, paddingTop: 4 }}>{props.actions}</div>
        ) : null}
      </div>
    </>
  );
}

/**
 * Project row: `div role="button"` (a pin button inside a button is invalid HTML and clicks
 * would double-fire). Keyboard: Tab + Enter/Space selects; the pin is its own button.
 */
function ProjectRow(props: {
  project: RecentProject;
  selected: boolean;
  pinned: boolean;
  activity: { running: number; unread: number } | undefined;
  homeDir: string;
  onPick: (root: string) => void;
  onTogglePin?: (key: string) => void;
}) {
  const { project, selected, pinned, onPick, onTogglePin } = props;
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const highlight = hovered || focused;
  return (
    <div
      role="button"
      tabIndex={0}
      className={`project-menu-row${selected ? " is-selected" : ""}`}
      title={project.root}
      onClick={() => onPick(project.root)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onPick(project.root);
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        width: "100%",
        padding: "8px 10px",
        background: highlight ? "var(--bg-hover)" : "var(--bg)",
        borderBottom: "1px solid var(--border)",
        outline: focused ? "1px solid var(--accent)" : "none",
        color: selected ? "var(--text)" : "var(--text-muted)",
        cursor: "pointer",
        textAlign: "left",
        fontSize: 11,
        fontFamily: "var(--font-mono)",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        boxSizing: "border-box",
      }}
    >
      {selected ? (
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true">
          <polyline points="1.5 5 4 7.5 8.5 2.5" />
        </svg>
      ) : (
        <span style={{ width: 10, flexShrink: 0 }} />
      )}
      <PathLabel text={displayCwd(project.root, props.homeDir)} style={{ flex: 1 }} />
      {showProjectActivity(props.activity)}
      {onTogglePin && (
        <button
          type="button"
          title={pinned ? t("sm.unpinProject") : t("sm.pinProject")}
          aria-label={pinned ? t("sm.unpinProject") : t("sm.pinProject")}
          onClick={(event) => {
            event.stopPropagation();
            onTogglePin(project.key);
          }}
          style={{
            // Space is reserved even when hidden so hovering does not shift the row's text.
            visibility: pinned || highlight ? "visible" : "hidden",
            flexShrink: 0,
            padding: "0 2px",
            fontSize: 11,
            lineHeight: 1.2,
            background: "none",
            border: "none",
            cursor: "pointer",
            color: pinned ? "var(--accent)" : "var(--text-dim)",
          }}
        >
          <SIc name="pin" size={12} />
        </button>
      )}
    </div>
  );
}
