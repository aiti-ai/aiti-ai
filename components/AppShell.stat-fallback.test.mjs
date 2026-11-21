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
  // The fallback condition includes !hasAnyStatValue. The compact tier is the merged
  // one (rowCompact = viewport compact OR chat-column compact).
  assert.match(
    statsSource,
    /\(\(rowCompact && !ctxStr\) \|\| \(isMobile && contextUsage\?\.percent == null\) \|\| !hasAnyStatValue\) \?/,
  );
  assert.match(statsSource, /Empty-state fallback/);
});

test("compact tier (rowCompact = viewport compact OR narrow chat column) collapses the row to the context percentage only", () => {
  assert.match(statsSource, /const rowCompact = isCompact \|\| statsRowCompact;/);
  // The whole density row (in/out/cache/cost/context) is gated behind !rowCompact…
  assert.match(statsSource, /!isMobile && !rowCompact && \(/);
  // …and the context value is the bare percentage, never the "X% / window" form.
  assert.match(statsSource, /ctxStr = pct !== null \? `\$\{pct\.toFixed\(0\)\}%` : "\?%";/);
  assert.doesNotMatch(statsSource, /`\$\{pct\.toFixed\(0\)\}% \/ \$\{fmt\(contextUsage\.contextWindow\)\}`/);
  // The percentage itself MUST be rendered on the desktop compact tier. This was
  // once missing (the only render sites were the !rowCompact groups flow and the
  // mobile dome block) and the button went fully blank on compact — regression
  // guard for the render site, not just the tier definition.
  assert.match(statsSource, /!isMobile && rowCompact && ctxStr && \(/);
});

test("density plan 方案 E: the stats row is a single nowrap flow (no per-stat flex gaps)", () => {
  // One inline-flex container holds the whole row; the individual stats are inline
  // spans inside it with marginLeft/dot separators, not sibling flex items.
  assert.match(statsSource, /Density tier \(plan: workspace-tools docs\/pi-web-topbar-stats-density-plan\.md §2 方案 E\)/);
  assert.match(statsSource, /display: "inline-flex", alignItems: "center", whiteSpace: "nowrap"/);
  // in/out share one glyph and render as an a/b pair.
  assert.match(statsSource, /\{fmt\(tokens\.input\)\}\/\{fmt\(tokens\.output\)\}/);
  // ≥100k collapses to a 1-digit k value (33.6M → 34M).
  assert.match(statsSource, /n >= 100_000 \? `\$\{Math\.round\(n \/ 1000\)\}k`/);
});

test("mobile keeps the battery-percentage-style context indicator", () => {
  assert.match(statsSource, /isMobile && contextUsage\?\.percent != null && \(/);
  assert.match(statsSource, /\{contextUsage\.percent\.toFixed\(0\)\}%/);
});

test("the inline IIFE remains the sole render source for top-bar stats (no duplicate renderSessionStatsButton)", () => {
  assert.doesNotMatch(source, /renderSessionStatsButton\(/);
  assert.doesNotMatch(source, /const renderSessionStatsButton/);
});

test("session-info tooltip is multi-line (one topic per line) and includes inline-slot contributors", () => {
  // One line per topic instead of the old single `  |  `-joined string.
  assert.match(statsSource, /const baseTooltip = tooltipLines\.join\("\\n"\);/);
  assert.match(statsSource, /tooltipLines\.push\(`tokens: \$\{tokenParts\.join\(" · "\)\}`\)/);
  assert.doesNotMatch(statsSource, /tooltipParts\.join\("  \|  "\)/);
  // Inline slot items (the sysmon CPU/memory chips) contribute their own line,
  // read on hover so the latest sample is used.
  assert.match(statsSource, /const inlineTooltipLines = \(\): string\[\] => sessionStatsInlineItems/);
  assert.match(statsSource, /e\.currentTarget\.title = \[baseTooltip, \.\.\.live\]\.filter\(Boolean\)\.join\("\\n"\);/);
  // Zero-valued cache entries are dropped rather than printed as "cache-write 0".
  assert.match(statsSource, /if \(tokens\.cacheWrite > 0\) tokenParts\.push/);
});
