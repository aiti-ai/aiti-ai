/**
 * sidebar/picker — CWD picker trigger + dropdown shell.
 *
 * The trigger (current project + other-workspace activity dot) and the anchoring/animation
 * stay here; the dropdown's content is the shared ProjectMenuBody (the same body the
 * new-session Workspace selector renders): project rows, default-directory and
 * browse-folder actions, then the workspacePickerActions slot footer.
 *
 * State and callbacks are owned by SidebarDock (mirrors the host component's internal state).
 */
import { useEffect, type ReactNode, type RefObject } from "react";
import { t, renderSlot } from "../host-shim";
import { displayCwd, type RecentProject } from "./pure";
import { AnimatedDropdown, PathLabel } from "./parts";
import { ProjectMenuBody } from "./project-menu";

export interface PickerProps {
  /** Right-end slot (branch indicator etc.); its own clicks stop propagation, so the menu stays closed. */
  rightSlot?: ReactNode;
  dropdownRef: RefObject<HTMLDivElement>;
  dropdownOpen: boolean;
  setDropdownOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  projectFilter: string;
  setProjectFilter: (v: string) => void;
  selectedCwd: string | null;
  homeDir: string;
  selectedProject: { key: string; root: string } | null;
  recentProjects: RecentProject[];
  visibleProjects: RecentProject[];
  projectActivity: Map<string, { running: number; unread: number }>;
  hasOtherWorkspaceActivity: boolean;
  customPathOpen: boolean;
  customPathValue: string;
  onSelectProject: (root: string) => void;
  onDefaultCwd: () => void;
  onCustomPathClick: () => void;
  hiddenWorkspaces: ReadonlySet<string>;
  /** Project pins: pinned order (visibleProjects is already ordered) + toggle callback. Omitted = read-only list (no pin button). */
  pinnedKeys?: readonly string[];
  onTogglePinProject?: (key: string) => void;
}

export function SidebarCwdPicker(p: PickerProps) {
  const showProjectFilter = p.recentProjects.length > 8;

  // Close on outside press and reset the filter; the glue lives here (not in the caller) so
  // every mount point behaves the same (2026-09-17: a popup mount forgot it once).
  useEffect(() => {
    if (!p.dropdownOpen) return;
    const onDown = (e: MouseEvent) => {
      if (p.dropdownRef.current && !p.dropdownRef.current.contains(e.target as Node)) {
        p.setDropdownOpen(false);
        p.setProjectFilter("");
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [p.dropdownOpen]);

  const pickProject = (root: string) => {
    p.onSelectProject(root);
    p.setProjectFilter("");
    p.setDropdownOpen(false);
  };
  const useDefault = () => {
    p.onDefaultCwd();
    p.setProjectFilter("");
    p.setDropdownOpen(false);
  };

  return (
    <div ref={p.dropdownRef} style={{ position: "relative" }}>
      <button
        onClick={() => p.setDropdownOpen((v) => !v)}
        title={p.selectedProject?.root ?? p.selectedCwd ?? ""}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          padding: "6px 10px",
          background: p.selectedCwd ? "var(--bg-hover)" : "rgba(37,99,235,0.06)",
          border: p.selectedCwd ? "1px solid var(--border)" : "1px solid rgba(37,99,235,0.4)",
          borderRadius: 7,
          cursor: "pointer",
          fontSize: 12,
          color: "var(--text)",
          textAlign: "left",
          transition: "border-color 0.15s, background 0.15s",
        }}
      >
        {p.selectedCwd ? (
          <PathLabel
            text={displayCwd(p.selectedProject?.root ?? p.selectedCwd, p.homeDir)}
            style={{
              flex: 1,
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--text)",
            }}
          />
        ) : (
          <span
            style={{
              flex: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--text-dim)",
            }}
          >
            {t("sidebar.selectProject")}
          </span>
        )}
        {p.hasOtherWorkspaceActivity && (
          <span
            title={t("sidebar.newActivity")}
            aria-label={t("sidebar.newActivity")}
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              flexShrink: 0,
              marginLeft: 6,
              background: "var(--accent)",
            }}
          />
        )}
        {p.rightSlot ? (
          <span
            style={{ marginLeft: "auto", flexShrink: 0, display: "inline-flex" }}
            onClick={(e) => e.stopPropagation()}
          >
            {p.rightSlot}
          </span>
        ) : null}
      </button>

      <AnimatedDropdown
        open={p.dropdownOpen}
        fixedAnchor
        style={{
          zIndex: 100,
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          boxShadow: "0 6px 20px rgba(0,0,0,0.10)",
          overflow: "hidden",
        }}
      >
        <ProjectMenuBody
          projects={p.visibleProjects}
          selectedKey={p.selectedProject?.key ?? null}
          homeDir={p.homeDir}
          activity={p.projectActivity}
          pinnedKeys={p.pinnedKeys}
          onTogglePin={p.onTogglePinProject}
          filter={{ value: p.projectFilter, onChange: p.setProjectFilter, show: showProjectFilter, onEscape: () => p.setDropdownOpen(false) }}
          onPick={pickProject}
          onUseDefault={useDefault}
          onBrowse={p.onCustomPathClick}
          labels={{
            filterPlaceholder: t("sidebar.filterProjects"),
            noMatch: t("sidebar.noMatchingProjects"),
            useDefault: t("sidebar.useDefaultDirectory"),
            useDefaultTitle: t("sidebar.useDefaultDirectory"),
            browse: t("sidebar.browseFolders"),
            browseTitle: t("sidebar.browseFoldersTitle"),
          }}
          actions={renderSlot("workspacePickerActions", {
            extra: {
              projects: p.visibleProjects.map((x) => ({ key: x.key, root: x.root })),
              allProjects: p.recentProjects.map((x) => ({ key: x.key, root: x.root })),
              selectedCwd: p.selectedCwd,
              hiddenWorkspaces: p.hiddenWorkspaces,
              onSelect: p.onSelectProject,
              onClose: () => p.setDropdownOpen(false),
            } as never,
          })}
        />
      </AnimatedDropdown>
    </div>
  );
}
