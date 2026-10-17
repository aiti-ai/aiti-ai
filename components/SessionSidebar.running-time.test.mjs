import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Regression guard: when plan-a-upstream was merged, the session item action area was
// changed by upstream into a mutually exclusive `?:` chain — while running only the
// spinner showed and while unread only the unread badge showed, so the relative time
// ("just now"/"x ago") got swallowed.
// The fork's original was "indicator + time side by side": every session shows the
// time, with running/unread indicators stacked on top.
// 合并适配（v0.11）：行渲染已随上游重构迁入 SessionTree.tsx 的虚拟化行组件，且上游把
// 相对时间移进了 tooltip（行上不可见）。守护语义随结构演进：
//   1) 行上必须有无条件渲染的相对时间（第二 meta 行，root.modified）；
//   2) running spinner 由右列 meta 承担（互斥列），但时间独立可见（不在任何 running 分支内）；
//   3) sessionRowMeta 扩展点保留在第二行末尾。
const source = await readFile(new URL("./SessionTree.tsx", import.meta.url), "utf8");
const rowSource = source.slice(source.indexOf('data-row-key={row.key}'));

test("a running session keeps the relative time visible on the row (not swallowed into the tooltip)", () => {
  // 相对时间 span 无条件渲染（不在 isRunning/isUnread 任何分支内），title 带完整时间戳
  assert.match(rowSource, /<span title=\{root\.modified\}>\{formatRelativeTime\(root\.modified, locale\)}<\/span>/);
  assert.match(rowSource, /session-tree-meta/);
});

test("running spinner lives in the meta column while the time stays independent", () => {
  assert.match(rowSource, /status\.running[\s\S]*?SpinnerIcon/);
  // 上游互斥 ? : 链若吞掉时间（时间 span 被卷进 status.running 分支）则立刻变红
  assert.doesNotMatch(rowSource, /status\.running \?[\s\S]*?formatRelativeTime[\s\S]*?:\s*status\.unread/);
});

test("the relative time uses the current locale and the row keeps the message count + sessionRowMeta", () => {
  assert.match(rowSource, /formatRelativeTime\(root\.modified, locale\)/);
  assert.match(rowSource, /sidebar\.messagesCount/);
  assert.match(rowSource, /ExtSlot name="sessionRowMeta"/);
});
