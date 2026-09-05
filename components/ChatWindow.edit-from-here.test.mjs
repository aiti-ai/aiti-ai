import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("marks a user message for edit-from-here without touching the session", () => {
  // 点击标记：纯前端（预填 composer + 高亮 + 按钮变取消），不发起任何后端操作
  assert.match(source, /const handleEditFromHereMark = useCallback\(async \(entryId: string, message: UserMessage, branchPointId: string \| null\) => \{/);
  assert.match(source, /setEditFromHerePending\(\{[\s\S]*?targetId: branchPointId \?\? entryId,[\s\S]*?leafId: branchPointId,[\s\S]*?\}\)/);
  assert.match(source, /handleEditContent\(message\);/);
});

test("re-marks a different message by clearing the previous pending prefill", () => {
  // 已有待发送标记时：先清旧预填再标记新的（避免 composer 残留导致 replaceMessage 静默失效）
  assert.match(source, /const hasPending = editFromHerePendingRef\.current != null;/);
  assert.match(source, /if \(!hasPending && chatInputRef\?\.current\?\.hasInput\?\.\(\)\) return;/);
  assert.match(source, /if \(hasPending\) chatInputRef\?\.current\?\.clearInput\?\.\(\);/);
});

test("cancelling the pending mark restores the composer", () => {
  assert.match(source, /const handleCancelEditFromHere = useCallback\(\(\) => \{/);
  assert.match(source, /setEditFromHerePending\(null\);\n\s+chatInputRef\?\.current\?\.clearInput\?\.\(\);/);
});

test("sending with a pending mark rewinds first; bash commands skip the rewind", () => {
  // 发送才是真正生效点：pending 时先 navigate 回退再发；! 前缀的 bash 命令不消费标记
  assert.match(source, /const handleSendWrapped = useCallback\(async \(message: string, images\?: AttachedImage\[\], files\?: AttachedFile\[\]\) => \{/);
  assert.match(source, /if \(message\.trim\(\)\.startsWith\("!"\)\) \{[\s\S]*?await handleSend\(message, images[^)]*\);[\s\S]*?return;/);
  assert.match(source, /setEditFromHerePending\(null\);\n\s+await handleEditFromStartSend\(pending\.targetId, pending\.leafId, message, images\);/);
});

test("branch navigation cancels the pending mark automatically", () => {
  // 分支导航（BranchNavigator/上下文链接）改变 activeLeafId → 视图位置已变，
  // 待发送标记失效自动取消（否则发送会强行回退、覆盖用户刚导航到的分支）。
  assert.match(source, /useEffect\(\(\) => \{[\s\S]*?setEditFromHerePending\(null\);[\s\S]*?\}, \[activeLeafId\]\);/);
  // activeLeafId 必须来自 useAgentSession 同一 state（handleLeafChange/handleNavigate 更新它）
  // （试验合并后解构追加上游的 scrollToMessage——会话搜索跳转用，与本契约无关）
  assert.match(source, /loadSlashCommands, scrollToBottom, scrollUserMsgToTop,\n\s+loadContext, activeLeafId(, scrollToMessage)?,\n\s+\} = useAgentSession\(/);
});

test("suppresses composer draft writes while a pending mark is active", () => {
  assert.match(source, /suppressDraft=\{editFromHerePending != null\}/);
});

test("wires the edit-from-here mark into the MessageView render", () => {
  // 合并 plan-a-upstream 时曾把消息渲染改回上游 onNavigate+onEditContent，
  // 丢掉了把这套 pending 标记机制接线到 MessageView 的三行——内部机制完好却成死代码。
  // 这里盯住接线：只要合并丢任何一行，立即红灯。
  assert.match(source, /onEditFromHere=\{isNew \? undefined : handleEditFromHereMark\}/);
  assert.match(source, /editingFromStart=\{editFromHerePending\?\.entryId === entryIds\[idx\]\}/);
  assert.match(source, /onCancelEditFromStart=\{handleCancelEditFromHere\}/);
});

test("never falls back to the superseded upstream navigate+editContent path", () => {
  // 上游的 onEditContent 立即跳转+预填语义与 fork 的「标记待发送、发送时回退」不同，
  // 二者不可并存：前者的存在说明 fork 机制被顶掉。禁止它出现在消息渲染行。
  assert.doesNotMatch(source, /onEditContent=\{handleEditContent\}/);
});
