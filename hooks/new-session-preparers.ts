/**
 * Preparer pipeline run before new-session creation (docs/pi-web-new-session-branch-worktree-plan.md §3):
 * ensureNewSession awaits each prepare registered by extensions, in order, before POST /api/agent/new —
 *  - returning { cwd } rewrites the target directory (chained: each preparer's ctx.cwd
 *    is the previous preparer's output);
 *  - returning { abort } cancels creation (the message is thrown verbatim → the existing
 *    catch in handleSend → shown as a notice; restoreSubmission puts the input back and the
 *    draft is kept by the draft-keeper — zero new display machinery);
 *  - returning void/undefined = no intervention.
 * Extensions register via registerItems("newSessionPreparers", [{ id, meta: { prepare } }]);
 * this module only implements the sequential-execution semantics (pure pipeline, no
 * React/network dependencies, directly unit-testable).
 */
import type { NewSessionPrepareResult } from "@/lib/ext/types";

export interface NewSessionPreparer {
  id: string;
  prepare?: (ctx: { cwd: string }) => Promise<NewSessionPrepareResult>;
}

export async function runNewSessionPreparers(
  preparers: NewSessionPreparer[] | undefined,
  cwd: string,
): Promise<{ cwd: string }> {
  let target = cwd;
  for (const p of preparers ?? []) {
    const r = await p.prepare?.({ cwd: target });
    if (!r) continue;
    if (r.abort) throw new Error(r.abort);
    if (r.cwd) target = r.cwd;
  }
  return { cwd: target };
}
