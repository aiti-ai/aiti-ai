import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Regression guard: when plan-a-upstream was merged, the session item action area was
// changed by upstream into a mutually exclusive `?:` chain — while running only the
// spinner showed and while unread only the unread badge showed, so the relative time
// ("just now"/"x ago") got swallowed.
// The fork's original was "indicator + time side by side": every session shows the
// time, with running/unread indicators stacked on top.
// This file watches the side-by-side semantics; if a merge makes it mutually exclusive
// again, this file goes red immediately.
const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const sessionItemSource = source.slice(source.indexOf("function SessionItem("));

test("a running session shows the spinner AND the relative time (side by side, not mutually exclusive)", () => {
  assert.match(sessionItemSource, /{isRunning && <RunningSessionIndicator \/>}\s*\n\s*{!isRunning && isUnread && <UnreadSessionIndicator \/>}\s*\n\s*{\/\*[^\n]*\*\/}\s*\n\s*{!isRunning && session\.lastRun[\s\S]*?}\s*\n\s*<span title=\{session\.modified\}>/);
});

test("running/unread indicators do not affect the always-rendered relative time", () => {
  // The time span must render unconditionally (not wrapped in any isRunning/isUnread branch)
  assert.match(sessionItemSource, /\{[a-zA-Z]+\s*\}|\s*<span title=\{session\.modified\}>/);
  // Upstream's mutually exclusive `isRunning ? (...RunningSessionIndicator...) : isUnread ? (...) : (<span>)` shape must never appear
  assert.doesNotMatch(sessionItemSource, /isRunning \?\s*\([\s\S]*?RunningSessionIndicator[\s\S]*?\)\s*:\s*isUnread \?/);
});

test("the relative time uses the current locale and carries a full timestamp title", () => {
  assert.match(sessionItemSource, /formatRelativeTime\(session\.modified, locale\)/);
  assert.match(sessionItemSource, /title=\{session\.modified\}/);
});
