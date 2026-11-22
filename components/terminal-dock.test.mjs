/**
 * Guard tests for the terminalDock slot (source-level assertions; T2 dock full takeover):
 * the cmd extension takes over workspace terminal tabs for real — an ownership state machine
 * (tab ⇄ dialog, single instance either way) + two-sided placeholders.
 * Breaking any assertion = a takeover-chain regression.
 * Run: node --experimental-strip-types --test components/terminal-dock.test.mjs
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const bridgeSource = await readFile(new URL("./TerminalPanelBridge.tsx", import.meta.url), "utf8");
const extSlotsSource = await readFile(new URL("./ExtSlots.tsx", import.meta.url), "utf8");
const extLoaderSource = await readFile(new URL("./ext-client-loader.ts", import.meta.url), "utf8");
const typesSource = await readFile(new URL("../lib/ext/types.ts", import.meta.url), "utf8");
const tabStateSource = await readFile(new URL("./terminal-tab-state.ts", import.meta.url), "utf8");

test("TerminalPanelBridge renders terminalDock slot items when registered (real takeover)", () => {
  assert.match(bridgeSource, /useExtSlotItems\("terminalDock"\)\.find\(hasExtRender\)/);
  assert.match(bridgeSource, /<ExtItemBoundary extId=\{takeover\.extId\} slot="terminalDock" itemId=\{takeover\.id\}>/);
  // real-takeover props: cwd/tabId/active/restored/onClosed all passed through (the ownership state machine key depends on tabId)
  assert.match(bridgeSource, /cwd=\{tab\.cwd\}/);
  assert.match(bridgeSource, /tabId=\{tab\.id\}/);
  assert.match(bridgeSource, /restored=\{Boolean\(tab\.restored\)\}/);
});

test("closing→onClosed stays before the takeover early-return (Rules of Hooks)", () => {
  // In takeover state the ✕ close triggers teardown immediately (the native fallback state leaves full teardown to TerminalPanel); the hook must sit
  // before if (takeover) (reordering = some render paths lose the hook)
  const closingIdx = bridgeSource.indexOf("if (tab.closing && takeover) onClosed();");
  const returnIdx = bridgeSource.indexOf("if (takeover) {");
  assert.ok(closingIdx !== -1, "closing→onClosed effect is missing (takeover teardown path)");
  assert.ok(returnIdx !== -1, "takeover branch is missing");
  assert.ok(closingIdx < returnIdx, "closing effect must run before the takeover early-return (Rules of Hooks)");
});

test("falls back to the native PTY panel when the extension is absent (three layers: takeover first / pending placeholder / native fallback)", () => {
  // arbitration hook: boot manifest settle + nobody declaring terminalDock → settled (one snapshot decides)
  assert.match(bridgeSource, /useExtSlotSettled\("terminalDock"\)/);
  // empty-shell placeholder before settle (a late takeover would double-open, so no pre-judgment); the native panel renders only after settle
  const settledIdx = bridgeSource.indexOf("if (!settled) {");
  const panelIdx = bridgeSource.indexOf("<TerminalPanel");
  assert.ok(settledIdx !== -1 && panelIdx !== -1, "native fallback layer is missing");
  assert.ok(settledIdx < panelIdx, "placeholder layer must render before the native panel (no PTY while unsettled)");
  assert.match(bridgeSource, /import \{ TerminalPanel \} from "\.\/TerminalPanel";/);
});

test("terminalDock contract exists in the slot type table", () => {
  assert.match(typesSource, /\| "terminalDock"/);
  assert.match(typesSource, /interface TerminalDockSlotProps \{/);
  assert.match(typesSource, /terminalDock: \{ props: TerminalDockSlotProps \};/);
});

test("openAitiCmdShell dead code removed (after real takeover, core no longer indirectly opens the dialog)", () => {
  assert.doesNotMatch(tabStateSource, /openAitiCmdShell/);
});

// ---- [lazy-load adaptation 2026-09-09] guard against the root cause of restored terminal tabs staying stuck on "cmd extension not detected" ----
// The always-mounted dock slot (AppShell hidden container) mounts before the manifest is fetched
// asynchronously: if the materialize effect only depended on [slot] (which never changes), the first
// run would see an always-empty pendingForSlot, declared extensions would never materialize, and
// takeover would never appear.

test("useExtSlotItems materialize effect depends on the ui-store version (re-evaluates pending once the manifest is ready)", () => {
  // version is subscribed via useSyncExternalStore (manifest ready / static entries / reload unwinding all bump it)
  assert.match(extSlotsSource, /useSyncExternalStore\(subscribeExtUi, extUiVersion/);
  // the materialize effect deps must include version; still bare [slot] = timing-race regression
  assert.match(extSlotsSource, /\}, \[slot, version\]\);/);
});

test("takeover-absence arbitration semantics: boot settle + nobody declares (ExtSlots/ext-client-loader side)", () => {
  // useExtSlotSettled = extBootSettled && !slotDeclared(slot) — the manifest declaration is authoritative:
  // materialize timing/success does not affect the verdict (a declared takeover disables the native fallback,
  // preventing double-open; failures surface via the error indicator)
  assert.match(extSlotsSource, /export function useExtSlotSettled\(slot: ExtSlotName\): boolean \{/);
  assert.match(extSlotsSource, /extBootSettled && !slotDeclared\(slot\)/);
  // boot settle is decoupled from load success: set even when the fetch fails (nobody declared → native fallback stays available)
  assert.match(extSlotsSource, /notifyExtBootSettled\(\);/);
  assert.match(extLoaderSource, /export function slotDeclared\(slot: string\): boolean \{/);
});
