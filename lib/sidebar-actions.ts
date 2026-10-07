/**
 * What a session row's menu offers, as plain data the sidebar turns into
 * labelled items. Pure, so the rules (nothing disk-backed for a transient
 * session, archive disabled while a family runs) are testable without a DOM.
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
