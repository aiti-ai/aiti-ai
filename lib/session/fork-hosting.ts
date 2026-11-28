/**
 * Hosting inheritance for forked session copies.
 *
 * A fork copy is a brand-new pi session file with no registry entry and no spawn
 * claim, so its first open would fall back to an in-process runtime — a silent
 * hosting downgrade when the source was hosted by a detached wrapper. The copy
 * gets the source's hosting as a preference instead: the agent route's
 * `prefersDetached` branch re-hosts it on a wrapper before any local runtime can
 * start (lib/agent-starter/registry.ts `setDetachedPreference`).
 *
 * Leaf module on purpose: it may be called from the handle adapter and from the
 * file-fork routes without importing lib/session/index.ts back (that module owns
 * the adapter, a cycle otherwise).
 */

import {
  getDetachedPreference,
  getWrapperStarter,
  setDetachedPreference,
} from "../agent-starter/index.ts";

/**
 * Mirror the source session's detached hosting onto a fork copy.
 *
 * Detached source = hosted by a live wrapper, or a session whose persisted
 * preference already says "subprocess-detached". Anything else (in-process, or a
 * plain direct subprocess) leaves the copy with no preference, which keeps it on
 * the source's in-process behaviour.
 *
 * Best effort: a failure here only means the copy opens with the default hosting.
 */
export async function inheritForkHosting(
  sourceSessionId: string,
  copySessionId: string,
  fallbackCwd?: string,
): Promise<boolean> {
  if (!sourceSessionId || !copySessionId || sourceSessionId === copySessionId) return false;
  try {
    const wrapper = await getWrapperStarter();
    const entry = wrapper?.describe(sourceSessionId);
    const pref = getDetachedPreference(sourceSessionId);
    const detached = Boolean(entry) || pref?.mode === "subprocess-detached";
    if (!detached) return false;
    setDetachedPreference(copySessionId, {
      mode: "subprocess-detached",
      ...(entry?.providerType ? { providerType: entry.providerType } : {}),
      ...(entry?.agentKey ? { agentKey: entry.agentKey } : {}),
      ...(entry?.cwd ?? fallbackCwd ? { cwd: entry?.cwd ?? fallbackCwd } : {}),
    });
    return true;
  } catch {
    return false;
  }
}
