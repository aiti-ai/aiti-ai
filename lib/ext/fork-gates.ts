/**
 * sessionForkGate — pre-gate for "edit and resend" (client-side handler extension
 * point; the name carries over from the fork era, registration API unchanged).
 *
 * Extensions register via client ctx.registerSessionForkGate(gate); the caller
 * (components/ChatWindow.handleEditFromHereMark) awaits all gates in order before
 * placing the "edit from here" mark: any gate returning false or throwing aborts
 * the marking immediately (later gates are not run). Only when all gates pass does
 * it enter the marking state. Consumer: the git-trace extension's "rollback
 * pre-gate" — before edit-and-resend (rewind to the branch point and resend), let
 * the user decide whether to roll back file changes produced in that range
 * (internal design doc §5.4).
 * Note: fork (branch button → useAgentSession.handleFork) intentionally does NOT
 * trigger this gate since 9963a46 — the new session is append-only and leaves the
 * original session untouched, so there is no rollback need.
 *
 * This module has zero React dependencies (same bus pattern as lib/composer/bus.ts):
 * registrants register inside their extension client bundle's effect and hold the
 * disposer (precisely removes the old gate on HMR reload).
 */
import type { SessionForkGate, SessionForkGateInfo } from "./types";

export type { SessionForkGate, SessionForkGateInfo };

const gates: SessionForkGate[] = [];

/** Register a pre-gate; returns a disposer (precisely removes this registration; use as the effect return value). */
export function registerSessionForkGate(gate: SessionForkGate): () => void {
  gates.push(gate);
  return () => {
    const i = gates.indexOf(gate);
    if (i >= 0) gates.splice(i, 1);
  };
}

/**
 * Run all pre-gates in order (registration order). All pass → true; any gate
 * returning false or throwing cancels immediately (returns false, later gates
 * are not run); thrown errors only console.warn, never propagate up.
 * With no gates registered it always passes (true) — with zero extensions, fork
 * behavior is exactly as before.
 */
export async function runSessionForkGates(info: SessionForkGateInfo): Promise<boolean> {
  for (const gate of gates) {
    try {
      const ok = await gate(info);
      if (!ok) return false;
    } catch (e) {
      console.warn("[ext] sessionForkGate cancelled the fork:", e);
      return false;
    }
  }
  return true;
}

/** Test helper: clear all gates (do not call in production code). */
export function resetSessionForkGatesForTests(): void {
  gates.length = 0;
}
