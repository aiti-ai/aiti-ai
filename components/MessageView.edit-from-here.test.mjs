import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 回归保护：「从这里编辑」的 fork 机制（纯前端待发送标记）在合并 plan-a-upstream 时曾丢失——
// MessageView 被改回上游的 onNavigate+onEditContent（点按钮立即跳转+预填），
// 导致 fork 的「点击仅预填+高亮+按钮变取消，发送时才回退会话」整套变成死代码。
// 本文件盯住 MessageView 侧的 props 接线：只要合并把它改回上游机制，这里即时红灯。
const source = await readFile(new URL("./MessageView.tsx", import.meta.url), "utf8");

test("MessageView 仍在 props 接口声明「编辑从此处」三件套", () => {
  // 三个 props 缺一不可：标记入口 / 是否正处待发送态（高亮+变取消）/ 取消标记
  assert.match(source, /onEditFromHere\?: \(entryId: string, message: UserMessage, branchPointId: string \| null\) => void;/);
  assert.match(source, /editingFromStart\?: boolean;/);
  assert.match(source, /onCancelEditFromStart\?: \(\) => void;/);
});

test("MessageView 把三件套透传给 UserMessageView", () => {
  assert.match(
    source,
    /entryId=\{entryId\} onFork=\{onFork\} forking=\{forking\} onNavigate=\{onNavigate\} prevAssistantEntryId=\{prevAssistantEntryId\} onEditFromHere=\{onEditFromHere\} editingFromStart=\{editingFromStart\} onCancelEditFromStart=\{onCancelEditFromStart\}/,
  );
});

test("UserMessageView 计算 canEditFromHere（无 onEditFromHere 则按钮隐藏）", () => {
  assert.match(source, /const canEditFromHere = !!onEditFromHere && !!entryId;/);
});

test("编辑从此处按钮在待发送态变为「取消」，否则标记分支点", () => {
  // 分支点：有上一条 assistant 回复→回退到它；首条消息（无 canNavigate）→ null → 发送时根重建（new 会话）
  assert.match(
    source,
    /onClick=\{[\s\S]*?if \(editingFromStart\) \{[\s\S]*?onCancelEditFromStart\?\.\(\);[\s\S]*?\} else \{[\s\S]*?onEditFromHere!\(entryId!, editTarget, canNavigate \? prevAssistantEntryId! : null\);/,
  );
  assert.match(source, /editingFromStart\s*\?\s*t\("i18n\.editFromHereCancelTitle"\)/);
  assert.match(source, /canNavigate \? t\("i18n\.editFromHereTitle"\) : t\("i18n\.editFromStartTitle"\)/);
  assert.match(source, /editingFromStart \? t\("i18n\.editFromHereCancel"\) : t\("i18n\.editFromHere"\)/);
});

test("编辑从此处待发送态对 user 气泡加高亮（boxShadow，不换 border 避免布局跳动）", () => {
  assert.match(
    source,
    /\.\.\.\(editingFromStart \? \{ boxShadow: "0 0 0 1\.5px var\(--accent\), 0 0 12px rgba\(59,130,246,0\.25\)" \} : \{\}\)/,
  );
});

test("动作区容器包含 canEditFromHere 分支", () => {
  assert.match(source, /\{\(canFork \|\| canNavigate \|\| canEditFromHere\) && \(/);
});
