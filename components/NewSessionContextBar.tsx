"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  currentWorktreeOf,
  describeProjectChoices,
  projectChoices,
  type NewSessionContext,
  type NewSessionTarget,
  type ProjectChoice,
} from "@/lib/new-session-context";
import { projectNameOf } from "@/lib/session-tree";
import { focusIfLost } from "@/lib/stacked-dialog";
import { SidebarMenu, type SidebarMenuAnchor, type SidebarMenuItem } from "./SidebarMenu";
import { BranchIcon, ChevronIcon, FolderIcon, FolderPlusIcon, PlusIcon } from "./SidebarIcons";
import { WorktreeCreateForm } from "./WorktreeCreateForm";

/** The bar's two controls. A move names the one it came from, which takes focus in the bar that replaces this one. */
export type NewSessionContextControl = "project" | "worktree";

interface MenuState {
  kind: NewSessionContextControl;
  anchor: SidebarMenuAnchor;
  opener: HTMLElement;
  /** Set while the worktree menu shows the "new worktree" form instead of the list. */
  form: { token: number; busy: boolean; error: string | null } | null;
}

interface Props {
  context: NewSessionContext;
  mobile: boolean;
  /** The control the move that mounted this bar came from: it takes focus once, if focus fell to the page. */
  initialFocus: NewSessionContextControl | null;
  onInitialFocusDone: () => void;
  /** Start the fresh composer over in `target`; the shell ignores a move to where it already is. */
  onPick: (target: NewSessionTarget, from: NewSessionContextControl) => void;
  /** "Open another project…": the folder picker, which hands its folder to `onPick`. */
  onOpenFolder: (opener: HTMLElement | null) => void;
  onRefreshWorktrees: () => void;
  onCreateWorktree: (project: ProjectChoice, branch: string) => Promise<{ path: string } | { error: string }>;
}

function buttonAnchor(element: HTMLElement): SidebarMenuAnchor {
  const rect = element.getBoundingClientRect();
  return { kind: "rect", rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }, align: "start" };
}

/**
 * The project and worktree a fresh composer starts its session in, above the
 * composer of the empty new-session page. Every pick starts the composer over
 * in the new folder (the shell remounts it, carrying the draft and its model
 * picks), so this bar only reports what was chosen; the sidebar keeps the cwd.
 */
export function NewSessionContextBar({
  context,
  mobile,
  initialFocus,
  onInitialFocusDone,
  onPick,
  onOpenFolder,
  onRefreshWorktrees,
  onCreateWorktree,
}: Props) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef(menu);
  menuRef.current = menu;
  const formTokenRef = useRef(0);
  const projectRef = useRef<HTMLButtonElement>(null);
  const worktreeRef = useRef<HTMLButtonElement>(null);
  // A worktree created after this bar went away (the composer moved, or the
  // first message went out) starts nothing: nobody asks for it any more.
  const mountedRef = useRef(false);
  // The newest props for an answer that arrives later.
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const initialFocusRef = useRef(initialFocus);
  const onInitialFocusDoneRef = useRef(onInitialFocusDone);
  onInitialFocusDoneRef.current = onInitialFocusDone;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // The control that moved the composer went away with it: its counterpart
  // here takes focus, so a keyboard user goes on from where they were.
  useEffect(() => {
    const from = initialFocusRef.current;
    if (!from) return;
    initialFocusRef.current = null;
    onInitialFocusDoneRef.current();
    focusIfLost(document, (from === "worktree" ? worktreeRef.current : null) ?? projectRef.current);
  }, []);

  const current = currentWorktreeOf(context);
  const closeMenu = () => setMenu(null);

  const openMenu = (kind: NewSessionContextControl, opener: HTMLElement) => {
    setMenu({ kind, anchor: buttonAnchor(opener), opener, form: null });
    // Worktrees come and go outside this page (the CLI, another window).
    if (kind === "worktree") onRefreshWorktrees();
  };

  const createWorktree = async (branch: string) => {
    const token = menuRef.current?.form?.token;
    if (token === undefined) return;
    const project = context.project;
    const setForm = (busy: boolean, error: string | null) => {
      setMenu((state) => (state?.form?.token === token ? { ...state, form: { token, busy, error } } : state));
    };
    setForm(true, null);
    let result: { path: string } | { error: string };
    try {
      result = await onCreateWorktree(project, branch);
    } catch (e) {
      result = { error: e instanceof Error ? e.message : String(e) };
    }
    if (!mountedRef.current) return;
    if ("error" in result) {
      setForm(false, result.error);
      return;
    }
    // Closed meanwhile: the worktree exists, and the sidebar lists it, but
    // nobody asked for a session in it any more.
    if (menuRef.current?.form?.token !== token) return;
    setMenu(null);
    onPickRef.current({ cwd: result.path, projectKey: project.key, projectRoot: project.root }, "worktree");
  };

  const projectItems = (): SidebarMenuItem[] => [
    ...describeProjectChoices(projectChoices(context)).map(({ choice, name, note }): SidebarMenuItem => ({
      type: "item",
      id: `project:${choice.key}`,
      label: name,
      note: note ?? undefined,
      title: choice.root,
      checked: choice.key === context.project.key,
      // The project in use stays as it is: picking it never moves a worktree back to the root.
      onSelect: () => {
        if (choice.key !== context.project.key) onPick({ cwd: choice.root, projectKey: choice.key, projectRoot: choice.root }, "project");
      },
    })),
    { type: "separator", id: "separator" },
    {
      type: "item",
      id: "open-folder",
      label: t("sidebar.openOtherProject"),
      icon: <FolderPlusIcon size={13} />,
      onSelect: () => onOpenFolder(menu?.opener ?? null),
    },
  ];

  const worktreeItems = (): SidebarMenuItem[] => [
    ...(context.worktrees ?? []).map((worktree): SidebarMenuItem => ({
      type: "item",
      id: `worktree:${worktree.path}`,
      label: worktree.branch ?? projectNameOf(worktree.path),
      mono: true,
      note: worktree.isMain ? t("sidebar.main") : undefined,
      title: worktree.path,
      checked: worktree.path === current?.path,
      onSelect: () => {
        if (worktree.path !== current?.path) {
          onPick({ cwd: worktree.path, projectKey: context.project.key, projectRoot: context.project.root }, "worktree");
        }
      },
    })),
    { type: "separator", id: "separator" },
    {
      type: "item",
      id: "new-worktree",
      label: t("sidebar.newWorktree"),
      icon: <PlusIcon size={13} />,
      onSelect: ({ keepOpen }) => {
        keepOpen();
        formTokenRef.current += 1;
        const token = formTokenRef.current;
        setMenu((state) => (state?.kind === "worktree" ? { ...state, form: { token, busy: false, error: null } } : state));
      },
    },
  ];

  let menuTitle = "";
  let menuItems: SidebarMenuItem[] | undefined;
  let menuWidth = 240;
  if (menu?.kind === "project") {
    menuTitle = t("workspace.project");
    menuItems = projectItems();
    menuWidth = 260;
  } else if (menu?.form) {
    menuTitle = t("sidebar.newWorktreeForSession");
  } else if (menu?.kind === "worktree") {
    menuTitle = t("sidebar.switchWorktree");
    menuItems = worktreeItems();
  }
  const form = menu?.form ?? null;

  return (
    <div className="new-session-context" style={{ paddingLeft: 16, paddingRight: mobile ? 16 : 52 }}>
      <div className="new-session-context-row" role="group" aria-label={t("workspace.newSessionContext")}>
        <button
          ref={projectRef}
          type="button"
          className="new-session-context-button is-project"
          title={context.project.root}
          aria-haspopup="menu"
          aria-expanded={menu?.kind === "project"}
          onClick={(event) => openMenu("project", event.currentTarget)}
        >
          <FolderIcon size={12} className="new-session-context-icon" />
          <span className="new-session-context-label">{projectNameOf(context.project.root)}</span>
          <ChevronIcon size={9} className="new-session-context-chevron sidebar-icon-down" />
        </button>
        {context.worktrees && (
          <button
            ref={worktreeRef}
            type="button"
            className="new-session-context-button"
            title={current ? t("sidebar.worktreePath", { path: current.path }) : t("sidebar.switchWorktree")}
            aria-haspopup="menu"
            aria-expanded={menu?.kind === "worktree"}
            onClick={(event) => openMenu("worktree", event.currentTarget)}
          >
            <BranchIcon size={12} className="new-session-context-icon" />
            <span className="new-session-context-label is-mono">
              {current ? current.branch ?? projectNameOf(current.path) : "…"}
            </span>
            <ChevronIcon size={9} className="new-session-context-chevron sidebar-icon-down" />
          </button>
        )}
      </div>
      <SidebarMenu
        open={menu !== null}
        anchor={menu?.anchor ?? null}
        sheet={mobile}
        ariaLabel={menuTitle}
        title={menuTitle}
        items={menuItems}
        cancelLabel={t("sidebar.cancel")}
        onClose={closeMenu}
        returnFocusTo={menu?.opener ?? null}
        width={menuWidth}
      >
        {form && (
          <WorktreeCreateForm
            heading={mobile ? null : menuTitle}
            busy={form.busy}
            error={form.error}
            showCancel={!mobile}
            onCreate={(branch) => { void createWorktree(branch); }}
            onCancel={closeMenu}
          />
        )}
      </SidebarMenu>
    </div>
  );
}
