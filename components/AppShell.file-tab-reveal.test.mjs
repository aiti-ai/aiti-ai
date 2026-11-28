import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Regression protection: the right-side file area tab bar "auto-scroll into
// view when a tab is newly opened" (TabBar revealToken, predecessor in
// 8fd815f) serves only "user-initiated open/switch". History restore (the
// file-editor extension's session tombstones batch-opened silently in the
// background with select:false) and its fallback activation must not
// increment the token — those tabs are opened silently in the background,
// take no focus, and must not yank the tab bar away (a position the user
// manually scrolled to is not pulled back by the restore flow).
// Restore-semantics background: fork merge notes item ⑪.

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

/** Grabs the source snippet of a top-level declaration up to the next top-level const declaration (top-level = two-space indent). */
function blockOf(decl) {
  const start = source.indexOf(decl);
  assert.ok(start >= 0, `${decl} not found`);
  const after = source.indexOf("\n  const ", start + decl.length);
  return source.slice(start, after === -1 ? source.length : after);
}

test("TabBar is driven by the host token (revealToken={fileTabRevealToken})", () => {
  assert.match(source, /const \[fileTabRevealToken, setFileTabRevealToken\] = useState\(0\);/);
  assert.match(source, /const revealFileTabOnOpen = useCallback\(\(\) => setFileTabRevealToken\(\(n\) => n \+ 1\), \[\]\);/);
  assert.match(source, /revealToken=\{fileTabRevealToken\}/);
});

test("user-initiated open paths increment the token: file/folder (select:true), tab click, terminal, dock, collapse", () => {
  // split on 2026-09-19: openHostFileTab owns host tab placement (handleOpenFile only does face-guard routing)
  assert.match(
    blockOf("const openHostFileTab = useCallback"),
    /if \(select\) \{\s*\n\s*setActiveFileTabId\(tabId\);\s*\n\s*revealFileTabOnOpen\(\)/,
  );
  assert.match(
    blockOf("const handleOpenFolder = useCallback"),
    /if \(select\) \{\s*\n\s*setActiveFileTabId\(tabId\);\s*\n\s*revealFileTabOnOpen\(\)/,
  );
  assert.match(blockOf("const guardedSelectFileTab = useCallback"), /revealFileTabOnOpen\(\)/);
  assert.match(blockOf("const handleOpenTerminal = useCallback"), /revealFileTabOnOpen\(\)/);
  assert.match(blockOf("const dockBackTab = useCallback"), /revealFileTabOnOpen\(\)/);
  // dock open / re-open of an already-docked panel brings it to front (one occurrence per event kind)
  assert.equal((source.match(/revealFileTabOnOpen\(\); \/\/ dock panel opened from the toolbar\/extension/g) || []).length, 1);
  assert.equal((source.match(/revealFileTabOnOpen\(\); \/\/ re-opening an already-docked panel/g) || []).length, 1);
});

test("lazy-materialization window guard: dormant faces are rerouted to openFileFace (no host tab)", () => {
  const b = blockOf("const handleOpenFile = useCallback");
  // dormant face hit → materialize the file-editor extension, then go through
  // openFileFace (auto passes through select:false); the bring-to-front/token
  // semantics for user clicks (select:true) are carried by the dock activate
  // event linkage (AppShell onActivate).
  assert.match(b, /findDormantFileFacePath\(filePath\)/);
  assert.match(b, /ensureExtMaterialized\("aiti-editor"\)/);
  assert.match(b, /api\.openFileFace\(facePath, \{ auto: options\?\.select === false \}\)/);
  assert.match(b, /openHostFileTab\(facePath, fileName, options\)/);
});

test("background restore and fallback paths do not increment the token: restore fallback activation / layout restore / close / detach", () => {
  // restore fallback activation (the only automatic activation point when a plain expanded-panel restore opens history files)
  const restoreIdx = source.indexOf("setActiveFileTabId(visibleTabs[visibleTabs.length - 1].id);");
  assert.ok(restoreIdx > 0, "the restore fallback-activation effect should exist");
  assert.doesNotMatch(source.slice(restoreIdx - 420, restoreIdx + 80), /revealFileTabOnOpen/);
  // terminal tab layout restore (sessionStorage)
  const termIdx = source.indexOf("setActiveFileTabId(saved.activeId);");
  assert.ok(termIdx > 0, "the terminal layout restore should exist");
  assert.doesNotMatch(source.slice(termIdx - 320, termIdx + 80), /revealFileTabOnOpen/);
  // activation fallback after close / detach
  for (const decl of [
    "const handleCloseFileTabs = useCallback",
    "const performCloseFileTab = useCallback",
    "const handleTerminalClosed = ",
    "const detachTab = useCallback",
  ]) {
    assert.doesNotMatch(blockOf(decl), /revealFileTabOnOpen/, `${decl} must not increment the tab-reveal token`);
  }
});
