import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Regression guard: the right file panel's "load history" (the file-editor extension's session tombstone
// restore) once broke in an upstream merge (merge-notes item ⑪ in the host repo's docs): the restore call
// _restoreSession was originally inlined in the file-panel toggle button's onClick, and got silently
// dropped when the upstream handleRightPanelToggle refactor (toggle moved to a unified handler) merged
// → expanding the panel no longer restored the last open files/folders; only manually opening some
// file/folder afterwards triggered it.
// This file pins down: the restore logic must hang off the rightPanelOpen effect (covering every
// expansion path), and must not regress into an inline call buried inside a single handler.

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("panel expansion triggers session restore: the rightPanelOpen effect exists and calls _restoreSession", () => {
  const m = source.match(
    /useEffect\(\(\) => \{\s*\n\s*if \(!rightPanelOpen\) return;\s*\n\s*const restore = window\.__aitiEditor\?\._restoreSession;[\s\S]*?\n\s*\}, \[rightPanelOpen\]\);/,
  );
  assert.ok(
    m,
    "the rightPanelOpen session-restore effect is missing — expanding the file panel no longer loads history (see merge-notes ⑪)",
  );
  // guarded call (invoke only when the function exists) + async release; must not become a bare call
  assert.match(m[0], /typeof restore === "function"/);
  assert.match(m[0], /setTimeout\(\(\) => restore\(\), 0\)/);
});

test("restore triggering is owned solely by the effect: must not scatter back into inline calls inside a single handler", () => {
  // First cut out the effect block; in the remaining source only the Window type declaration `_restoreSession?: () => void;`
  // may appear; any other occurrence (inline calls in handlers etc.) = regression to the shape that lost the logic last time.
  const effectMatch = source.match(
    /\/\/ Panel expansion immediately restores[\s\S]*?\}, \[rightPanelOpen\]\);/,
  );
  assert.ok(effectMatch, "the rightPanelOpen session-restore effect should exist");
  const rest = source.replace(effectMatch[0], "");
  const leftovers = [...rest.matchAll(/_restoreSession(?!\?: \(\) => void;)/g)]
    // Mentions on comment lines (starting with // or a JSDoc *) don't count as call sites; only block occurrences in code
    .filter((m) => {
      const lineStart = rest.lastIndexOf("\n", m.index) + 1;
      const line = rest.slice(lineStart, m.index + 200).split("\n")[0].trim();
      return !(line.startsWith("//") || line.startsWith("*") || line.startsWith("/*"));
    });
  assert.equal(
    leftovers.length,
    0,
    `_restoreSession appears outside the effect ${leftovers.length} time(s) — restore triggering must stay confined to the rightPanelOpen effect, not scatter back into individual handlers (see merge-notes ⑪)`,
  );
});

test("the toggle button uses the unified handler and the handler sets rightPanelOpen (restore triggered indirectly via the effect)", () => {
  // renderMainFileToggle must not bypass handleRightPanelToggle and setRightPanelOpen on its own:
  // the restore logic hangs only on the effect; if the button bypasses the unified handler it could lose the mobile teardown;
  // conversely handleRightPanelToggle must actually set rightPanelOpen (otherwise the effect never fires).
  const fnStart = source.indexOf("const renderMainFileToggle");
  const fn = source.slice(fnStart, fnStart + 2200);
  assert.match(fn, /onClick=\{handleRightPanelToggle\}/);
  const toggleStart = source.indexOf("const handleRightPanelToggle");
  const toggleFn = source.slice(toggleStart, toggleStart + 400);
  assert.match(toggleFn, /setRightPanelOpen\(/);
  // No inlined restore call directly in the handler (that is exactly the fragile shape that lost the logic in the merge; see the Window declaration comment)
  assert.doesNotMatch(toggleFn, /_restoreSession/);
});

test("restore companion: panel open + tabs present + none active → activate the last one (removes the empty state of select:false batch opening)", () => {
  // The extension's _restoreSession opens everything in the background (select:false); with a pure expansion
  // trigger no tab gets activated and the panel lands in the "click a tab to open" empty state. This effect is
  // the state-driven backstop — the first file commit of the restore flow activates (at that moment it is the
  // last), and the activeFileTabId !== null guard blocks re-activation while later files open
  // (= a file the user opened manually keeps focus too). Verified in E2E: expand → content renders, no empty state.
  // tab-detach v0.6.0: the activation surface narrows to tabs visible within the panel (detached ones don't take a right-panel activation slot).
  const m = source.match(
    /useEffect\(\(\) => \{\s*\n\s*\/\/ tab-detach: auto-activation only picks from tabs visible inside the panel[^\n]*\n\s*const visibleTabs = fileTabs\.filter\(\(t\) => !detachedTabIds\.has\(t\.id\)\);\s*\n\s*if \(!rightPanelOpen \|\| visibleTabs\.length === 0 \|\| activeFileTabId !== null\) return;\s*\n\s*setActiveFileTabId\(visibleTabs\[visibleTabs\.length - 1\]\.id\);\s*\n\s*\}, \[activeFileTabId, fileTabs, detachedTabIds, rightPanelOpen\]\);/,
  );
  assert.ok(m, "the restore fallback-activation effect is missing — after expanding the panel history tabs open without activation and the content area shows an empty state");
});

test("the Window type declaration keeps _restoreSession (the extension-private contract remains)", () => {
  assert.match(source, /_restoreSession\?: \(\) => void;/);
});
