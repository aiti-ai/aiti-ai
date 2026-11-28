/**
 * new-session-workspace-picker — takeover of the new-session welcome page's Workspace
 * selector (host slot `newSessionWorkspacePicker`).
 *
 * The menu is the same body as the sidebar CWD picker (`ProjectMenuBody`): the same
 * project list source (extension store, pinned order, hidden-workspace filter, activity
 * badges, "~" labels), the same "Use default directory" / "Browse folders…" actions and
 * the same `workspacePickerActions` footer (get / upload / manage a workspace).
 *
 * Semantics stay the native <select>'s: a pick only STAGES the target through the host's
 * "pi-web.newSession.setTarget" service; the app switches when the session is created.
 * Older hosts without setTarget fall back to setCwd (immediate move) plus a hint.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { apiUrl, getExtService, renderSlot, t } from "./host-shim";
import { useStore, togglePinProject, type WorkspaceEntry } from "./store";
import {
  WORKSPACES_CHANGED_EVENT,
  displayCwd,
  loadHiddenWorkspaces,
  loadLastCustomCwd,
  orderProjects,
  pinnedProjectKeys,
  type RecentProject,
} from "./sidebar/pure";
import { ProjectMenuBody } from "./sidebar/project-menu";
import { clampToViewport } from "@aiti-ai/ext-shared/popup-anchor";
import { createLazyModule, lazyExtView } from "@aiti-ai/ext-shared/ext-lazy";
import { fetchHomeDir } from "./home-dir";
import { showToast } from "./toast";

const dirPickerRef = createLazyModule(() => import("./sidebar/directory-picker"));

export interface NewSessionWorkspacePickerProps {
  /** New-session target cwd the host is rendering (null = undecided). */
  cwd: string | null;
  /** What the host's selector currently shows (the staged target, else the current cwd). */
  selected: string | null;
  isMobile: boolean;
}

interface NewSessionService {
  setTarget?: (path: string | null) => void;
  setCwd?: (path: string) => void;
}

async function validateCwd(path: string): Promise<string | null> {
  try {
    const response = await fetch(apiUrl("/api/cwd/validate"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: path }),
    });
    const data = await response.json().catch(() => ({})) as { cwd?: string; error?: string };
    if (!response.ok || data.error || !data.cwd) return null;
    return data.cwd;
  } catch {
    return null;
  }
}

async function defaultCwd(): Promise<string | null> {
  try {
    const response = await fetch(apiUrl("/api/default-cwd"), { method: "POST" });
    const data = await response.json() as { cwd?: string; error?: string };
    return data.cwd ?? null;
  } catch {
    return null;
  }
}

export function NewSessionWorkspacePicker(props: NewSessionWorkspacePickerProps) {
  const store = useStore();
  const entries = (store.workspaces ?? []) as WorkspaceEntry[];
  const current = props.selected ?? props.cwd ?? null;

  const [open, setOpen] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [homeDir, setHomeDir] = useState("");
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => loadHiddenWorkspaces());
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void fetchHomeDir().then((dir) => setHomeDir(dir));
  }, []);

  // Hidden workspaces are a cross-tab contract (same localStorage key the core/sidebar use).
  useEffect(() => {
    const sync = () => setHidden(loadHiddenWorkspaces());
    window.addEventListener(WORKSPACES_CHANGED_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(WORKSPACES_CHANGED_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const projects = useMemo(() => {
    const list = entries.map((entry) => ({ key: entry.key, root: entry.root }));
    // The folder the composer is in can have no sessions yet (fresh --cwd / a just-browsed
    // folder): keep it selectable, exactly like the host's native option list did.
    if (current && !list.some((project) => project.root === current)) {
      list.unshift({ key: current, root: current });
    }
    return list;
  }, [entries, current]);

  const pinnedKeys = useMemo(() => pinnedProjectKeys(store.tagData), [store.tagData]);
  const visibleProjects: RecentProject[] = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const filtered = projects.filter((project) => {
      if (project.root !== current && hidden.has(project.root)) return false;
      if (!query) return true;
      return displayCwd(project.root, homeDir).toLowerCase().includes(query);
    });
    return orderProjects(filtered, pinnedKeys);
  }, [projects, hidden, current, filter, homeDir, pinnedKeys]);

  const activity = useMemo(() => {
    const map = new Map<string, { running: number; unread: number }>();
    for (const entry of entries) {
      map.set(entry.key, { running: entry.runningCount ?? 0, unread: entry.unreadCount ?? 0 });
    }
    if (current && !map.has(current)) map.set(current, { running: 0, unread: 0 });
    return map;
  }, [entries, current]);

  // Stage the target (native <select> semantics). setTarget is the host's staging path;
  // setCwd is the old-host fallback (moves the fresh composer immediately).
  const stage = useCallback((path: string) => {
    if (!path) return;
    const service = getExtService<NewSessionService>("pi-web.newSession");
    setOpen(false);
    setFilter("");
    if (service?.setTarget) {
      service.setTarget(path);
      return;
    }
    if (service?.setCwd) {
      service.setCwd(path);
      showToast(t("sm.stageHint"));
      return;
    }
    showToast(t("sm.uploadSwitchHint"));
  }, []);

  const useDefaultDirectory = useCallback(async () => {
    const path = await defaultCwd();
    if (path) stage(path);
  }, [stage]);

  // Browse: the picker's directory dialog, validated to the realpath the sidebar uses.
  const browse = useCallback(async (path: string) => {
    setBrowseOpen(false);
    const resolved = await validateCwd(path);
    if (resolved) stage(resolved);
    else showToast(t("sm.browseInvalid"));
  }, [stage]);

  useLayoutEffect(() => {
    if (!open) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(360, window.innerWidth - 16);
    const { left, top } = clampToViewport(rect.left, rect.bottom + 6, width, popRef.current?.offsetHeight ?? 320, 8);
    setPos((previous) => (previous && previous.left === left && previous.top === top ? previous : { left, top }));
  }, [open, visibleProjects.length, filter]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (popRef.current?.contains(target)) return;
      if (target && typeof (target as Element).closest === "function" && (target as Element).closest("[data-nswp-trigger]")) return;
      setOpen(false);
      setFilter("");
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        setFilter("");
      }
    };
    const onScroll = (event: Event) => {
      if (popRef.current && event.target instanceof Node && popRef.current.contains(event.target)) return;
      setOpen(false);
      setFilter("");
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  const label = current ? displayCwd(current, homeDir) : t("sidebar.selectProject");
  const dialog = lazyExtView({
    active: browseOpen,
    load: dirPickerRef,
    pick: "DirectoryPicker",
    props: {
      initialPath: current ?? loadLastCustomCwd(),
      onCancel: () => setBrowseOpen(false),
      onSelect: (path: string) => void browse(path),
    },
  });

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        data-nswp-trigger="1"
        className="new-session-workspace-trigger"
        aria-label={t("sidebar.workspacePicker")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title={current ?? undefined}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          minWidth: 0,
          maxWidth: "min(52vw, 360px)",
          padding: "4px 8px",
          background: "var(--bg-hover)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          color: "var(--text)",
          fontFamily: "inherit",
          fontSize: 12,
          cursor: "pointer",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{label}</span>
        <span style={{ flexShrink: 0, fontSize: 9, color: "var(--text-muted)" }}>▾</span>
      </button>

      {open && createPortal(
        <div
          ref={popRef}
          role="dialog"
          aria-label={t("sidebar.workspacePicker")}
          style={{
            position: "fixed",
            zIndex: 1000,
            left: pos ? pos.left : -99999,
            top: pos ? pos.top : -99999,
            width: Math.min(360, window.innerWidth - 16),
            maxHeight: "min(60vh, 440px)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            boxShadow: "0 14px 36px color-mix(in srgb, var(--text) 14%, transparent)",
            fontFamily: "inherit",
            textAlign: "left",
          }}
        >
          <ProjectMenuBody
            projects={visibleProjects}
            selectedKey={current}
            homeDir={homeDir}
            activity={activity}
            pinnedKeys={pinnedKeys}
            onTogglePin={(key) => void togglePinProject(key)}
            filter={{ value: filter, onChange: setFilter, show: projects.length > 8, onEscape: () => setOpen(false) }}
            onPick={stage}
            onUseDefault={() => void useDefaultDirectory()}
            onBrowse={() => {
              setOpen(false);
              setBrowseOpen(true);
            }}
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
                projects: visibleProjects.map((project) => ({ key: project.key, root: project.root })),
                allProjects: projects.map((project) => ({ key: project.key, root: project.root })),
                selectedCwd: current,
                hiddenWorkspaces: hidden,
                onSelect: stage,
                onClose: () => setOpen(false),
              },
            })}
          />
        </div>,
        document.body,
      )}

      {dialog}
    </>
  );
}
