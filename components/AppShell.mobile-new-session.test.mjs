/**
 * Host-side pins for the small-screen leading new-session entry (plan:
 * docs/pi-web-mobile-new-session-topbar-plan.md).
 *
 * Three contract points: (1) one render site, after the sidebar toggle and before the
 * sortable itemsRow (leftmost, second button); (2) mobile viewports only (desktop keeps
 * the sidebar header's "+", so no action is duplicated); (3) extra carries data only
 * (cwd) — the host knows no new-session behavior (the action lives in session-manager
 * and lands through the "pi-web.newSession" client service).
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("topbarMobileLeading renders once, between the sidebar toggle and the sortable tool row", () => {
  const occurrences = source.split('name="topbarMobileLeading"').length - 1;
  assert.equal(occurrences, 1, "exactly one render site (a merge adding a second one would double the button)");

  const slot = source.indexOf('name="topbarMobileLeading"');
  const toggle = source.indexOf("const handleSidebarToggle");
  const row = source.indexOf("ref={itemsRowRef}");
  assert.ok(toggle !== -1, "sidebar toggle should exist");
  assert.ok(row !== -1, "the sortable tool row should exist");
  assert.ok(toggle < slot, "the slot must come after the sidebar toggle");
  assert.ok(slot < row, "the slot must come before the sortable row — leftmost, second button on a phone");
});

test("the slot is mobile-gated and its extra is data only (cwd)", () => {
  assert.match(
    source,
    /\{isMobile && \(\s*<ExtSlot name="topbarMobileLeading" extra=\{\{ cwd: selectedSession\?\.cwd \?\? effectiveNewSessionCwd \?\? null \}\} \/>\s*\)\}/,
    "the slot must render only for isMobile and pass cwd as data (slot-extra red line)",
  );
});

test("the host keeps no new-session logic for the phone entry (the extension owns the action)", () => {
  const at = source.indexOf('name="topbarMobileLeading"');
  const around = source.slice(Math.max(0, at - 1200), at + 400);
  assert.doesNotMatch(around, /handleTopbarNewSession|startNewSessionIn\(/, "the host slot renders extension items only");
});
