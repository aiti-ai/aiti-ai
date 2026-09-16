import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 回归保护：合并 plan-a-upstream 时，session 条目的操作区曾被上游改成互斥 `?:` 链——
// 运行中只显示转圈指示器、未读只显示未读标，相对时间（刚刚/xxx前）被吃掉。
// fork 原版是「指示器 + 时间并列」：任何 session 都显示时间，运行/未读额外叠加指示器。
// 本文件盯住并列语义，只要合并再把它改回互斥，这里即时红灯。
const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const sessionItemSource = source.slice(source.indexOf("function SessionItem("));

test("运行中 session 同时显示转圈指示器 AND 相对时间（并列而非互斥）", () => {
  assert.match(sessionItemSource, /{isRunning && <RunningSessionIndicator \/>}\s*\n\s*{!isRunning && isUnread && <UnreadSessionIndicator \/>}\s*\n\s*{\/\*[^\n]*\*\/}\s*\n\s*{!isRunning && session\.lastRun[\s\S]*?}\s*\n\s*<span title=\{session\.modified\}>/);
});

test("运行/未读指示器不影响相对时间始终渲染", () => {
  // 时间 span 必须无条件渲染（不包在 isRunning/isUnread 的任何分支里）
  assert.match(sessionItemSource, /\{[a-zA-Z]+\s*\}|\s*<span title=\{session\.modified\}>/);
  // 严禁出现上游的互斥 `isRunning ? (...RunningSessionIndicator...) : isUnread ? (...) : (<span>)` 形态
  assert.doesNotMatch(sessionItemSource, /isRunning \?\s*\([\s\S]*?RunningSessionIndicator[\s\S]*?\)\s*:\s*isUnread \?/);
});

test("相对时间用当前 locale 且带完整时间戳 title", () => {
  assert.match(sessionItemSource, /formatRelativeTime\(session\.modified, locale\)/);
  assert.match(sessionItemSource, /title=\{session\.modified\}/);
});
