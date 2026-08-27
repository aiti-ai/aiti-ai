import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 回归保护：顶栏「会话信息」统计按钮在统计全 0 / context 缺失且空间不足时，
// 曾渲染成 24px 空白（只有布局 padding，无任何内容）。
// 需求是两级降级：① 所有统计为空 → 显示时钟 icon 作为「会话信息」入口；② 紧凑/移动档 → 仅显示 context 百分比。
const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const statsSource = source.slice(
  source.indexOf('{showChat && (sessionStats || contextUsage) &&'),
  source.indexOf('title={translate("common.more")}'),
);

test("统计全空时兜底显示时钟 icon（避免 24px 空白按钮）", () => {
  // hasAnyStatValue 覆盖 in/out/cacheRead/cacheWrite/cost/context 六项
  assert.match(
    statsSource,
    /const hasAnyStatValue = Boolean\(\s*[\s\S]*?tokens\.input > 0 \|\| tokens\.output > 0 \|\| tokens\.cacheRead > 0 \|\| tokens\.cacheWrite > 0/,
  );
  assert.match(statsSource, /(?:\|\||\|)\s*costStr[\s\S]*?\|\|?\s*ctxStr/);
  // 兜底条件含 !hasAnyStatValue
  assert.match(
    statsSource,
    /\(\(isCompact && !ctxStr\) \|\| \(isMobile && contextUsage\?\.percent == null\) \|\| !hasAnyStatValue\) \?/,
  );
  assert.match(statsSource, /空状态兜底/);
});

test("紧凑档（isCompact）仅显示 context 百分比而非完整 X% / 总值", () => {
  assert.match(
    statsSource,
    /isCompact \? contextUsage\?\.percent != null \? contextUsage\.percent\.toFixed\(0\) \+ "%" : "\?%" : ctxStr/,
  );
});

test("移动端保留电池百分比式 context 指示", () => {
  assert.match(statsSource, /isMobile && contextUsage\?\.percent != null && \(/);
  assert.match(statsSource, /contextUsage\.percent\.toFixed\(0\) \+ "%"/);
});

test("内联 IIFE 仍是顶栏统计唯一渲染源（不与 renderSessionStatsButton 重复）", () => {
  assert.doesNotMatch(source, /renderSessionStatsButton\(/);
  assert.doesNotMatch(source, /const renderSessionStatsButton/);
});
