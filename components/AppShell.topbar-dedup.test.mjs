import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 回归保护：合并 plan-a-upstream 时，顶栏「当前会话统计」曾被渲染两份——
// fork 内联 IIFE 版本 + 上游 renderSessionStatsButton 调用叠在一起（auto-merge 无冲突叠加，
// 同类问题曾导致 theme/language 双份）。本次已删掉 renderSessionStatsButton/renderProjectTrustWarning，
// 只留内联 IIFE 单一渲染源。只要合并再把函数调用版加回来 / 或去掉内联版，这里即时红灯。
const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("顶栏会话统计只保留内联 IIFE 单一渲染源", () => {
  // 内联 IIFE 是 fork 的原生实现（pre-plan-a-merge 唯一渲染源），必须存在
  assert.match(
    source,
    /\{showChat && \(sessionStats \|\| contextUsage\) && \(\(\) => \{/,
  );
  // 渲染点唯一：不应同时出现 renderSessionStatsButton 调用
  assert.doesNotMatch(source, /renderSessionStatsButton\(/);
});

test("不再调用会叠加重复的 renderProjectTrustWarning（由内联信任警告承担）", () => {
  assert.doesNotMatch(source, /renderProjectTrustWarning\(/);
});

test("顶栏状态信息按钮不重复：无 renderSessionStatsButton 残留定义或调用", () => {
  assert.doesNotMatch(source, /const renderSessionStatsButton/);
  assert.doesNotMatch(source, /const renderProjectTrustWarning/);
});

test("「⋯」更多按钮位于会话统计之后（保持既有布局顺序）", () => {
  const statsIdx = source.indexOf("Session stats — right-aligned in top bar");
  const moreIdx = source.indexOf('title={translate("common.more")}');
  assert.ok(statsIdx !== -1, "会话统计注释应存在");
  assert.ok(moreIdx !== -1, "⋯按钮应存在");
  assert.ok(statsIdx < moreIdx, "会话统计应在 ⋯ 之前渲染");
});
