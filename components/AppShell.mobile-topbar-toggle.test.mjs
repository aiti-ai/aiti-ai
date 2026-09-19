import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Regression guard: the mobile top-bar buttons broke twice from merge conflicts resolved on
// the wrong side (the repo's merge-notes doc, item ⑦):
// ① renderMainFileToggle's mobile call {renderMainFileToggle(true)} was lost during the custom
//    sortable top-bar refactor, leaving only the !isMobile branch → the mobile top-right file
//    toggle never rendered, leaving the reserved 44px corner slot empty;
// ② the mobile BranchNavigator's controlled open={activeTopPanel === "branches"} was resolved
//    into a bare JSX attribute open (= always true) in merge c3db1c1 → the branch panel stayed
//    permanently spread open and untappable, feeling like "every click opens and nothing closes".
// This file pins down: one call site for both form factors / no bare boolean props returning /
// all toggle-style buttons keep toggle semantics.

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("file panel toggle: desktop and mobile must share the renderMainFileToggle(isMobile) call site", () => {
  // unified call site exists
  assert.match(source, /\{renderMainFileToggle\(isMobile\)\}/);
  // the desktop-only-branch old form must not come back
  assert.doesNotMatch(source, /!isMobile && renderMainFileToggle\(false\)/);
});

test("file panel toggle: unified negative right margin on both form factors (no more mobile ? 0 dead-code branch)", () => {
  const fn = source.slice(
    source.indexOf("const renderMainFileToggle"),
    source.indexOf("const renderMainFileToggle") + 2000,
  );
  // the container reserves 44px + safe-area at the top-right; the button cancels it with an equal
  // negative margin to hug the corner — a separate 0 on mobile is a regression
  assert.match(fn, /marginRight:\s*"calc\(-44px - min\(env\(safe-area-inset-right\), 8px\)\)"/);
  assert.doesNotMatch(fn, /mobile \? 0\s*:/);
});

test("mobile BranchNavigator: open must be controlled by activeTopPanel, bare boolean attributes forbidden", () => {
  const m = source.match(
    /\{isMobile && sessionHasBranches && \(\s*<BranchNavigator[\s\S]*?\/?>\s*\)\}/,
  );
  assert.ok(m, "mobile BranchNavigator render block should exist");
  const block = m[0];
  assert.match(block, /open=\{activeTopPanel === "branches"\}/);
  // bare open (no value = always true) = panel permanently open; bare hasSession (renders
  // without sessions) = gating broken — neither may return
  assert.doesNotMatch(block, /^\s*open\s*$/m);
  assert.doesNotMatch(block, /^\s*hasSession\s*$/m);
  // native-capability props must not be lost again: compact (icon tier) + hasSession={showChat} (session gating)
  assert.match(block, /\bcompact\b/);
  assert.match(block, /hasSession=\{showChat\}/);
});

test("toggle semantics: topPanel and the ⋯more menu both close on a second click, must not degrade to open-only", () => {
  // topPanel: clicking the same panel again = close (functional negate; direct setActiveTopPanel(panel) assignment forbidden)
  assert.match(source, /setActiveTopPanel\(\(cur\) => cur === panel \? null : panel\)/);
  // ⋯more: setMoreOpen(v => !v) negation semantics
  assert.match(source, /setMoreOpen\(\(?v\)? => !v\)|setMoreOpen\(\(v\) => !v\)/);
});
