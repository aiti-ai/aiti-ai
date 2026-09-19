import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Regression guard: when plan-a-upstream was merged, the top-bar "current session stats" was rendered twice —
// the fork's inline IIFE version + the upstream renderSessionStatsButton call stacked on top (auto-merge added both
// without conflict; the same class of problem once produced duplicate theme/language). renderSessionStatsButton/
// renderProjectTrustWarning were removed, leaving the inline IIFE as the single render source. If a merge ever adds
// the function-call version back / drops the inline version, this test goes red immediately.
const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("top-bar session stats keep the inline IIFE as the single render source", () => {
  // The inline IIFE is the fork's native implementation (the sole render source before the plan-a merge); it must exist
  assert.match(
    source,
    /\{showChat && \(sessionStats \|\| contextUsage\) && \(\(\) => \{/,
  );
  // Single render site: the renderSessionStatsButton call must not appear as well
  assert.doesNotMatch(source, /renderSessionStatsButton\(/);
});

test("no more calls to the duplicate-stacking renderProjectTrustWarning (the inline trust warning covers it)", () => {
  assert.doesNotMatch(source, /renderProjectTrustWarning\(/);
});

test("top-bar status buttons are not duplicated: no leftover renderSessionStatsButton definition or call", () => {
  assert.doesNotMatch(source, /const renderSessionStatsButton/);
  assert.doesNotMatch(source, /const renderProjectTrustWarning/);
});

test("the \"⋯\" more button sits after the session stats (existing layout order preserved)", () => {
  const statsIdx = source.indexOf("Session stats — right-aligned in top bar");
  const moreIdx = source.indexOf('title={translate("common.more")}');
  assert.ok(statsIdx !== -1, "session stats comment should exist");
  assert.ok(moreIdx !== -1, "\"⋯\" more button should exist");
  assert.ok(statsIdx < moreIdx, "session stats should render before the \"⋯\" more button");
});
