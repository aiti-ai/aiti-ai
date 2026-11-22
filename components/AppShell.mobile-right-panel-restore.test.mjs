// Small-screen contract: the right panel is a full-screen overlay drawer, so nothing in the
// load path may pull it up (same rule the sidebar follows via `auto` gating). Three sources
// replay persisted state — the dock state machine's restorative re-dock, the sessionStorage
// workspace memory, and the editor's background tombstone restore — all have to stay gated.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const mobileHook = await readFile(new URL("../hooks/useIsMobile.ts", import.meta.url), "utf8");

test("restorative dock re-dock does not expand the small-screen right panel", () => {
  assert.match(source, /if \(!\(detail\.auto && isMobile\)\) \{\s*\n\s*setRightPanelOpen\(true\);/);
  // the restored tab is still activated, so a user-initiated expand shows it
  assert.match(source, /if \(!\(detail\.auto && isMobile\)\) \{[\s\S]{0,400}?setActiveFileTabId\(`dock:\$\{detail\.key\}`\);/);
  // the listener closure reads isMobile: it must be a dependency or the gate goes stale
  assert.match(source, /\}, \[fileTabs, terminalTabs, agentTabs, isMobile, revealFileTabOnOpen\]\);/); // 合并：deps 并入 agentTabs（子代理 tab）
});

test("workspace memory keeps the panel collapsed on a small-screen load", () => {
  assert.match(source, /setRightPanelOpen\(saved\.open && !isMobileViewport\(\)\)/);
  // mount effects run against the desktop hydration snapshot, so the query is read imperatively
  assert.match(mobileHook, /export function isMobileViewport\(\): boolean \{\s*return queryMatches\(MOBILE_QUERY\);\s*\}/);
});

test("background folder opens reach the dock state machine marked auto", () => {
  assert.match(source, /dockApi\.openFolderDocked\(folderPath, "right-panel", \{ auto: options\?\.select === false \}\)/);
});
