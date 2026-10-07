/**
 * What the session sidebar's menus offer, as plain data the component turns
 * into labelled items: a session row's actions and the group "+" worktree
 * choice. Pure, so the rules (nothing disk-backed for a transient session,
 * archive disabled while a family runs, a worktree picker only where there is
 * a choice) are testable without a DOM.
 */

import type { SidebarFamilyStatus, SidebarRow } from "./session-tree";

export type SessionMenuActionId =
  | "pin"
  | "unpin"
  | "rename"
  | "mark-read"
  | "mark-unread"
  | "archive"
  | "unarchive"
  | "delete";

export type SessionMenuEntry =
  | { kind: "action"; id: SessionMenuActionId; shortcut: string; disabledReason?: "running" }
  | { kind: "separator" };

/**
 * A session row's built-in menu. A transient session has no file yet, so it
 * gets none: pin, archive, rename and delete would all act on a missing file.
 * In the archive view, Pin also restores (pin and archive exclude each other).
 */
export function sessionMenuEntries(
  context: Extract<SidebarRow, { kind: "session" }>["context"],
  status: SidebarFamilyStatus,
): SessionMenuEntry[] {
  if (status.transient) return [];
  if (context === "archive") {
    return [
      { kind: "action", id: "unarchive", shortcut: "A" },
      { kind: "action", id: "pin", shortcut: "P" },
      { kind: "action", id: "rename", shortcut: "R" },
      { kind: "separator" },
      { kind: "action", id: "delete", shortcut: "D" },
    ];
  }
  return [
    { kind: "action", id: context === "pinned" ? "unpin" : "pin", shortcut: "P" },
    { kind: "action", id: "rename", shortcut: "R" },
    { kind: "action", id: status.unread ? "mark-read" : "mark-unread", shortcut: "U" },
    // A running family would come straight back: archiving waits for the run.
    status.running
      ? { kind: "action", id: "archive", shortcut: "A", disabledReason: "running" }
      : { kind: "action", id: "archive", shortcut: "A" },
    { kind: "separator" },
    { kind: "action", id: "delete", shortcut: "D" },
  ];
}

export interface WorktreeListingEntry {
  path: string;
  branch: string | null;
  isMain: boolean;
}

/** `GET /api/worktrees?cwd=` for a project root. */
export interface WorktreeListing {
  projectRoot: string;
  projectKey: string;
  isGit: boolean;
  isTopLevel: boolean;
  currentWorktreePath: string | null;
  worktrees: WorktreeListingEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The listing in a `/api/worktrees` response; null for an error or a response without a project. */
export function parseWorktreeListing(data: unknown): WorktreeListing | null {
  if (!isRecord(data) || typeof data.error === "string") return null;
  if (typeof data.projectRoot !== "string" || !data.projectRoot) return null;
  const worktrees: WorktreeListingEntry[] = [];
  if (Array.isArray(data.worktrees)) {
    for (const entry of data.worktrees) {
      if (!isRecord(entry) || typeof entry.path !== "string" || !entry.path) continue;
      worktrees.push({
        path: entry.path,
        branch: typeof entry.branch === "string" ? entry.branch : null,
        isMain: entry.isMain === true,
      });
    }
  }
  return {
    projectRoot: data.projectRoot,
    projectKey: typeof data.projectKey === "string" && data.projectKey ? data.projectKey : data.projectRoot,
    isGit: data.isGit === true,
    isTopLevel: data.isTopLevel === true,
    currentWorktreePath: typeof data.currentWorktreePath === "string" ? data.currentWorktreePath : null,
    worktrees,
  };
}

/**
 * Whether a group's "+" asks which worktree to use: only at the top of a git
 * checkout with more than one worktree, the same rule that shows the files
 * tab's worktree switcher. Anywhere else the session starts in the project
 * root directly.
 */
export function needsWorktreePicker(listing: WorktreeListing | null): boolean {
  return Boolean(listing && listing.isGit && listing.isTopLevel && listing.worktrees.length > 1);
}

/**
 * The worktree the picker marks as current. For the project in use that is
 * the checkout of the sidebar's cwd (`currentWorktreePath`, resolved by the
 * server, so it is one of the listed paths verbatim); for another project,
 * its main checkout.
 */
export function pickerCurrentWorktreePath(listing: WorktreeListing, currentWorktreePath: string | null): string | null {
  if (currentWorktreePath && listing.worktrees.some((worktree) => worktree.path === currentWorktreePath)) {
    return currentWorktreePath;
  }
  return listing.worktrees.find((worktree) => worktree.isMain)?.path ?? null;
}
