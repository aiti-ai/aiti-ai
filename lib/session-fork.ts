import { existsSync, writeFileSync } from "fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { readSubagentRun } from "./subagents";
import type { SessionEntry } from "./types";

/**
 * The sidebar's Fork: pi's `/clone` (a copy of the current branch, positioned
 * at its leaf) done on disk, so it never needs, starts or touches an
 * AgentSession and works while the source runs.
 */

export type SessionForkRefusal = "not_found" | "unsaved" | "empty" | "subagent";

export class SessionForkError extends Error {
  constructor(readonly code: SessionForkRefusal, message: string) {
    super(message);
    this.name = "SessionForkError";
  }
}

/**
 * Copies the branch that ends at the leaf into a new session file beside the
 * source (same directory and cwd, header `parentSession` = the source).
 * `liveLeafId` is an open wrapper's leaf (null: its leaf was reset before the
 * first entry); undefined means the file's own leaf, its last entry.
 *
 * Only entries already on disk are copied: pi appends each finished entry
 * synchronously in this process, so a run in progress contributes what it has
 * finished. Opens its own SessionManager, because createBranchedSession()
 * repoints the instance it runs on: never the cached reader of
 * openSessionManager() nor a wrapper's. pi's open-time migration may rewrite
 * an old-version source, as viewing it does; the source is otherwise unchanged.
 */
export function forkSessionBranch(sourcePath: string, liveLeafId?: string | null): { sessionId: string; path: string } {
  const live = liveLeafId !== undefined;
  // SessionManager.open() of a missing path silently starts an empty session.
  if (!existsSync(sourcePath)) {
    throw live
      ? new SessionForkError("unsaved", "This session has not been saved yet. Send a message before forking it.")
      : new SessionForkError("not_found", "Session not found");
  }
  const manager = SessionManager.open(sourcePath);
  const leafId = live ? liveLeafId : manager.getLeafId();
  if (!leafId) throw new SessionForkError("empty", "Nothing to fork: the session has no messages");
  // The wrapper's leaf is an entry not written yet.
  if (!manager.getEntry(leafId)) {
    throw new SessionForkError("unsaved", "This session has not been saved yet. Send a message before forking it.");
  }

  const branch = manager.getBranch(leafId);
  // A copy carrying a subagent's metadata would be read as that subagent and
  // folded, out of sight, into its parent's family.
  if (readSubagentRun(branch as unknown as SessionEntry[], "", sourcePath)) {
    throw new SessionForkError("subagent", "A subagent session cannot be forked");
  }
  if (!branch.some((entry) => entry.type === "message")) {
    throw new SessionForkError("empty", "Nothing to fork: the session has no messages");
  }

  const path = manager.createBranchedSession(leafId);
  if (path && !existsSync(path)) {
    // pi writes the copy only once it has a user or assistant message; a
    // shell-only branch (pi-web keeps those sessions) is written here.
    const header = manager.getHeader();
    if (header) {
      const content = [header, ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
      writeFileSync(path, content, { encoding: "utf8", flag: "wx" });
    }
  }
  if (!path || !existsSync(path)) throw new Error("Failed to fork the session");
  return { sessionId: manager.getSessionId(), path };
}
