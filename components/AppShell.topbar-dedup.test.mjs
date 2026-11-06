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

// Regression guard for the 2026-11 merge: the upstream medium inline row
// (renderChatToolbarActions/renderDebugButton/renderMainFileToggle for
// !isNarrowMobile) was merged back on TOP of the fork's custom-drawn top bar,
// stacking Debug and the file toggle twice on every width. Each of these has
// exactly one render site in this fork — count the calls (definition lines
// excluded) so an auto-merge that adds a second call goes red immediately.
test("top-bar buttons have exactly one render site each (Debug / file toggle / chat actions)", () => {
  // Strip comments before counting: JSX comments in this file legitimately
  // mention helper calls by name (e.g. "originally called renderMainFileToggle(true),
  // which was lost in the custom-order refactor") — counting them raw would
  // false-red, while a `{`-anchored call regex would false-green a merged-in
  // `{!cond && renderDebugButton(true)}` row (the exact upstream form the
  // 2026-11 merge brought back). So: strip comments, then count every line
  // calling `renderXxx(` except the const definition lines.
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments (JSX {/* */} included)
    .replace(/^\s*\/\/.*$/gm, ""); // whole-line // comments
  const callsOf = (name) =>
    stripped
      .split("\n")
      .filter((line) => line.includes(`${name}(`) && !line.includes(`const ${name}`))
      .length;
  // Debug: re-homed to the fork's top-bar right cluster (f19b7398) — one call, (isMobile).
  assert.equal(callsOf("renderDebugButton"), 1, "renderDebugButton must have exactly one call site (the fork re-homed entry); a second call means an upstream toolbar entry rode back in on a merge");
  assert.match(source, /\{renderDebugButton\(isMobile\)\}/);
  assert.doesNotMatch(stripped, /renderDebugButton\(true\)/);
  // File toggle: pinned at the top-right corner (51273ef1) — one call, (isMobile).
  assert.equal(callsOf("renderMainFileToggle"), 1, "renderMainFileToggle must have exactly one call site (the top-right corner owner); a second call means the upstream inline toggle rode back in on a merge");
  assert.match(source, /\{renderMainFileToggle\(isMobile\)\}/);
  assert.doesNotMatch(stripped, /renderMainFileToggle\(true\)/);
  // Chat toolbar actions: only inside the narrow-mobile More overlay (mobile: true).
  assert.equal(callsOf("renderChatToolbarActions"), 1, "renderChatToolbarActions must have exactly one call site (the More overlay); the upstream medium inline row must stay deleted");
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

// ════════════════════════════════════════════════════════════════════════════
// 2026-11 topbar 双堆叠第二波（v0.13→v0.15 合并）后的单一调用点计数钉。
// 上游 mobile-toolbar 的行内调用组（renderChatToolbarActions / renderDebugButton /
// renderMainFileToggle）被合并带回，与 fork 的单一 owner 叠加——桌面出现两个
// Debug、两个文件面板开关，375px 下行内开关还与 fork ⋯ 溢出按钮重叠。与本文件
// 开头 session stats 双堆叠同款（auto-merge 无冲突地两边都加）。这里改用「剥注
// 释后统计调用行数」的强钉：任何来源（合并带入、重构补回）把调用点加回都会红。
// fork 侧单一 owner 语义：
//   renderDebugButton      → 顶栏右簇（f19b7398 re-home，参数 isMobile）
//   renderMainFileToggle   → 右上角固定开关（51273ef1，参数 isMobile；负 margin
//                            抵消容器预留 padding，容器为其 reserve 44px）
//   renderChatToolbarActions → 仅窄屏 More 浮层面板内（medium 档由 fork 自绘行
//                            renderTopbarItem + 测量溢出覆盖，无需上游行内平铺）
// 详见 docs/upstream-merge-guardrails.md §一 单一 owner 清单。
// ════════════════════════════════════════════════════════════════════════════

// 剥掉块注释与行注释后的代码行（调用点统计用；块注释续行如 "renderMainFileToggle(true),
// which was lost..." 会被块注释剥除覆盖，行尾 // 注释由 replace 清掉）
const codeLines = source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .map((l) => l.replace(/\/\/.*$/, ""));

function callSites(fnName) {
  return codeLines
    .map((line, i) => ({ line: line.trim(), no: i + 1 }))
    .filter(({ line }) => line.includes(`${fnName}(`))
    .filter(({ line }) => !line.startsWith(`const ${fnName}`) && !line.includes(`function ${fnName}`));
}

test("top-bar render helpers have exactly one call site each (merge-stacking guard)", () => {
  const cases = [
    { fn: "renderDebugButton", want: "renderDebugButton(isMobile)", owner: "顶栏右簇（f19b7398 re-home）" },
    { fn: "renderMainFileToggle", want: "renderMainFileToggle(isMobile)", owner: "右上角固定开关（51273ef1）" },
    { fn: "renderChatToolbarActions", want: "renderChatToolbarActions(true)", owner: "窄屏 More 浮层面板内" },
  ];
  for (const { fn, want, owner } of cases) {
    const sites = callSites(fn);
    assert.equal(
      sites.length, 1,
      `${fn} 调用点应恰 1 处（单一 owner = ${owner}，形态 ${want}）。` +
      `实际 ${sites.length} 处：${JSON.stringify(sites)}。若为合并带入，请对照 docs/upstream-merge-guardrails.md §一 单一 owner 清单裁决去留，不要两边都留。`,
    );
    assert.match(sites[0].line, new RegExp(want.replace("(", "\\(").replace(")", "\\)")));
  }
});
