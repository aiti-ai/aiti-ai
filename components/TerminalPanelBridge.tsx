"use client";

import { useEffect } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useExtSlotItems, ExtItemBoundary, useExtSlotSettled, ensureExtSlotMaterialized } from "./ExtSlots";
import { hasExtRender } from "@/lib/ext-ui-store";
import { TerminalPanel } from "./TerminalPanel";
import type { TerminalTab } from "./terminal-tab-state";

interface Props {
  tab: TerminalTab;
  active: boolean;
  /** Tab close finalization (takeover mode = local removal suffices — the shell lifecycle belongs
   *  to the terminal/command extension; native fallback mode is called back by TerminalPanel after
   *  creation and in-flight input finalization complete; restart/failure semantics in docs/terminal.md). */
  onClosed: () => void;
  /** Native fallback layer only: restart/close failures go through the host tab state machine (takeover mode is handled by the extension itself). */
  onRestart?: () => void;
  onCloseError?: () => void;
  /** Passes through terminalDock.openShellTab: extension "＋ new" → force-open a new shell tab for the same cwd */
  onOpenShellTab?: (cwd: string) => void;
}

/**
 * [fork] Workspace terminal tab takeover bridge (upstream v0.9 integration T2 →
 * real dock takeover + native PTY fallback):
 *
 * - The terminal/command extension registers the `terminalDock` slot (real
 *   takeover): the extension terminal view (xterm) renders **directly inside
 *   the tab**, no longer the indirect "prompt to open a dialog" form. Render
 *   ownership (tab ⇄ dialog) is enforced either-or by the extension-side
 *   single-instance state machine: in dock mode the dialog shows a
 *   placeholder, and is restored once pulled back into the window.
 * - Manifest ready and nobody declared takeover (extension not installed or
 *   disabled) → fall back to the **native PTY panel** (the full
 *   lib/terminal-manager + /api/terminal setup, see docs/terminal.md:
 *   idempotent creation / 120s lease / resume / bounded replay). While the
 *   manifest is pending (boot fetch in flight), an empty shell placeholder
 *   renders — building the native PTY before an extension that declared
 *   takeover has materialized would double-open; declared-or-not is decided
 *   once from the manifest snapshot (useExtSlotSettled).
 * - The sessionStorage session-memory semantics are unchanged (a restored
 *   tab does not silently start a shell: the native layer GET-probes, the
 *   takeover layer exposes a "take over into tab" button from the extension).
 */
export function TerminalPanelBridge({ tab, active, onClosed, onRestart, onCloseError, onOpenShellTab }: Props) {
  const { t } = useI18n();
  const takeover = useExtSlotItems("terminalDock").find(hasExtRender);
  const settled = useExtSlotSettled("terminalDock");
  // [session-page plan §1 F3] terminalDock was removed from INTERACTIVE_SLOTS
  // (this bridge is a hidden container AppShell always mounts and would
  // unconditionally pull in the 559KB command extension at page open).
  // Instead, materialize on demand at the **moment of real interaction**:
  // pull it in when this terminal tab becomes visible (active). Until the
  // slot-declaring extension has materialized, this component renders an
  // empty shell placeholder (the !settled branch below) and does not jump
  // ahead building a native PTY — double-open protection unchanged.
  useEffect(() => {
    if (active) void ensureExtSlotMaterialized("terminalDock");
  }, [active]);
  // Tab-close finalization routing: takeover mode removes locally
  // immediately; native mode goes through TerminalPanel's closing effect for
  // full finalization (wait for creation/in-flight input → DELETE → callback;
  // on failure onCloseError keeps the tab retryable).
  // Hooks must be called before the takeover early-return (Rules of Hooks).
  useEffect(() => {
    if (tab.closing && takeover) onClosed();
  }, [tab.closing, takeover, onClosed]);
  if (takeover) {
    return (
      <section
        className="terminal-panel"
        aria-label={t("terminal.title")}
        style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        <ExtItemBoundary extId={takeover.extId} slot="terminalDock" itemId={takeover.id}>
          <takeover.render
            currentSession={null}
            cwd={tab.cwd}
            tabId={tab.id}
            active={active}
            restored={Boolean(tab.restored)}
            onClosed={onClosed}
            openShellTab={onOpenShellTab}
          />
        </ExtItemBoundary>
      </section>
    );
  }
  if (!settled) {
    // Manifest pending: can neither render the takeover layer nor presume
    // absence (guards against a late-arriving takeover double-opening), so
    // show an empty shell placeholder first (the manifest fetch takes <1s;
    // normally invisible).
    return <section className="terminal-panel" aria-label={t("terminal.title")} />;
  }
  return (
    <TerminalPanel
      tab={tab}
      active={active}
      onRestart={onRestart ?? (() => {})}
      onClosed={onClosed}
      onCloseError={onCloseError ?? (() => {})}
    />
  );
}
