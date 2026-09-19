import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Regression guard: the top-bar "session info" stats button once rendered as a
// blank 24px area (layout padding only, no content) when all stats were 0 /
// context was missing and space was tight.
// Requirement is two-level fallback: ① all stats empty → show a clock icon as the
// "session info" entry; ② compact/mobile tier → show only the context percentage.
const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const statsSource = source.slice(
  source.indexOf('{showChat && (sessionStats || contextUsage) &&'),
  source.indexOf('title={translate("common.more")}'),
);

test("falls back to the clock icon when all stats are empty (avoids a blank 24px button)", () => {
  // hasAnyStatValue covers six items: in/out/cacheRead/cacheWrite/cost/context
  assert.match(
    statsSource,
    /const hasAnyStatValue = Boolean\(\s*[\s\S]*?tokens\.input > 0 \|\| tokens\.output > 0 \|\| tokens\.cacheRead > 0 \|\| tokens\.cacheWrite > 0/,
  );
  assert.match(statsSource, /(?:\|\||\|)\s*costStr[\s\S]*?\|\|?\s*ctxStr/);
  // The fallback condition includes !hasAnyStatValue
  assert.match(
    statsSource,
    /\(\(isCompact && !ctxStr\) \|\| \(isMobile && contextUsage\?\.percent == null\) \|\| !hasAnyStatValue\) \?/,
  );
  assert.match(statsSource, /Empty-state fallback/);
});

test("compact tier (isCompact) shows only the context percentage instead of the full X% / totals", () => {
  assert.match(
    statsSource,
    /isCompact \? contextUsage\?\.percent != null \? contextUsage\.percent\.toFixed\(0\) \+ "%" : "\?%" : ctxStr/,
  );
});

test("mobile keeps the battery-percentage-style context indicator", () => {
  assert.match(statsSource, /isMobile && contextUsage\?\.percent != null && \(/);
  assert.match(statsSource, /contextUsage\.percent\.toFixed\(0\) \+ "%"/);
});

test("the inline IIFE remains the sole render source for top-bar stats (no duplicate renderSessionStatsButton)", () => {
  assert.doesNotMatch(source, /renderSessionStatsButton\(/);
  assert.doesNotMatch(source, /const renderSessionStatsButton/);
});
