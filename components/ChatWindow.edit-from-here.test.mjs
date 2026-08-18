import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("marks a user message for edit-from-here without touching the session", () => {
  // 点击标记：纯前端（预填 composer + 高亮 + 按钮变取消），不发起任何后端操作
  assert.match(source, /const handleEditFromHereMark = useCallback\(\(entryId: string, message: UserMessage, branchPointId: string \| null\) => \{/);
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
  assert.match(source, /const handleSendWrapped = useCallback\(async \(message: string, images\?: AttachedImage\[\]\) => \{/);
  assert.match(source, /if \(message\.trim\(\)\.startsWith\("!"\)\) \{[\s\S]*?await handleSend\(message, images\);[\s\S]*?return;/);
  assert.match(source, /setEditFromHerePending\(null\);\n\s+await handleEditFromStartSend\(pending\.targetId, pending\.leafId, message, images\);/);
});

test("branch navigation cancels the pending mark automatically", () => {
  // 分支导航（BranchNavigator/上下文链接）改变 activeLeafId → 视图位置已变，
  // 待发送标记失效自动取消（否则发送会强行回退、覆盖用户刚导航到的分支）。
  assert.match(source, /useEffect\(\(\) => \{[\s\S]*?setEditFromHerePending\(null\);[\s\S]*?\}, \[activeLeafId\]\);/);
  // activeLeafId 必须来自 useAgentSession 同一 state（handleLeafChange/handleNavigate 更新它）
  assert.match(source, /loadSlashCommands, scrollToBottom,\n\s+activeLeafId,\n\s+\} = useAgentSession\(/);
});

test("suppresses composer draft writes while a pending mark is active", () => {
  assert.match(source, /suppressDraft=\{editFromHerePending != null\}/);
});
