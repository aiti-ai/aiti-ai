/**
 * session-run-quiescence -- cross-instance single-writer check (precondition for fork/clone).
 *
 * Background (proven by an orphan run on 2026-08-30, session 73927991): the dev and prod
 * pi-web instances share the same ~/.pi/agent/sessions directory. A session's run may be
 * executing in **the other instance** (a pi child process spawned by prod) -- its
 * in-memory running state (isStreaming etc.) is completely invisible to this instance's
 * wrapper, so this instance's "no fork while running" guard fails, and the fork would
 * read/copy the file concurrently while the other side is streaming writes to it (data
 * race + dangling routing).
 *
 * Mechanism: before fork/clone actually acts, take two stat samples of the session file
 * (700ms apart); any change in size or mtime means a write is in progress -> throw to
 * reject. The same-instance running case is intercepted earlier by
 * isSessionRunningForReplacement (in-memory state); this check is the cross-instance
 * fallback.
 *
 * Residual race (known, accepted): a writer that happens to stay silent for >700ms can
 * still slip through; the v2 direction is a cross-instance run claim file on the shared
 * disk (flock/pid liveness) -- see the docs retrospective. A missing file (new session)
 * counts as quiescent.
 */

import { stat } from "node:fs/promises";

const QUIESCENCE_WINDOW_MS = 700;

export async function assertSessionFileQuiescent(sessionFile: string): Promise<void> {
  let a: { size: number; mtimeMs: number };
  try {
    a = await stat(sessionFile);
  } catch {
    return; // file missing/unreadable -> no writer
  }
  await new Promise((resolve) => setTimeout(resolve, QUIESCENCE_WINDOW_MS));
  let b: { size: number; mtimeMs: number };
  try {
    b = await stat(sessionFile);
  } catch {
    return;
  }
  if (b.size !== a.size || b.mtimeMs !== a.mtimeMs) {
    throw new Error(
      "Cannot fork: the session is being actively written by another process "
      + "(another pi-web instance is running this session?) — abort that run first",
    );
  }
}
