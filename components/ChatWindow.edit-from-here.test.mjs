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

test("runs ai-change gates before marking; free-of-disturbance preflight comes first", () => {
  // 2026-09 起 ai变更处置前置门挂在「从此处编辑」（fork 不再触发）：
  // hasInput 预检必须在门之前——输入框非空本就静默中止，先弹门会让用户白答一次。
  const gatePos = source.indexOf("await runSessionForkGates(");
  const preflightPos = source.indexOf("if (!hasPending && chatInputRef?.current?.hasInput?.()) return;");
  assert.ok(gatePos > -1, "gate call missing");
  assert.ok(preflightPos > -1, "hasInput preflight missing");
  assert.ok(preflightPos < gatePos, "preflight must run before the gate dialog");
  assert.match(source, /const allowed = await runSessionForkGates\(\{ sessionId: sid, entryId, position: "before", cutUserEntryIds \}\);/);
  assert.match(source, /cutUserEntryIds/);
  assert.match(source, /if \(!allowed\) return;/);
});

test("re-checks composer input after the gate dialog wait", () => {
  // 回撤门是非模态浮层：等待期间用户可能已手动输入——门后复检防预填覆盖（canRestore 约定）
  assert.match(source, /if \(!editFromHerePendingRef\.current && chatInputRef\?\.current\?\.hasInput\?\.\(\)\) return;/);
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
  // （试验合并后解构追加上游的 scrollToMessage——会话搜索跳转用，与本契约无关；
  //  2026-09-15 又追加 reloadCurrentSession——已停止会话手动刷新用，同样无关；
  //  正则放行 activeLeafId 之后任意尾随解构字段，避免每次加字段都红灯）
  assert.match(source, /loadSlashCommands, scrollToBottom, scrollUserMsgToTop,\n\s+loadContext, activeLeafId(?:, \w+)*,\n\s+\} = useAgentSession\(/);
});

test("suppresses composer draft writes while a pending mark is active", () => {
  assert.match(source, /suppressDraft=\{editFromHerePending != null\}/);
});

test("wires the edit-from-here mark into the MessageView render", () => {
  // 合并 plan-a-upstream 时曾把消息渲染改回上游 onNavigate+onEditContent，
  // 丢掉了把这套 pending 标记机制接线到 MessageView 的三行——内部机制完好却成死代码。
  // 这里盯住接线：只要合并丢任何一行，立即红灯。
  // 2026-09-18：新增 capability 门控（外部后端须 navigateTree 或 fork 之一；zcode 走
  // session/fork 语义，其余外部后端隐藏按钮=标示不支持）——本地会话无 caps 全通不变。
  assert.match(source, /onEditFromHere=\{sessionBusy \|\| isNew \|\| !\(sessionCap\("navigateTree"\) \|\| sessionCap\("fork"\)\) \? undefined : handleEditFromHereMark\}/);
  assert.match(source, /editingFromStart=\{editFromHerePending\?\.entryId === entryIds\[idx\]\}/);
  assert.match(source, /onCancelEditFromStart=\{handleCancelEditFromHere\}/);
});

test("新会话按钮不受 sessionBusy/首条消息门控（运行中/首条都可见）", () => {
  // a4aaff0 (08-20) 拍板：运行中 fork 完全没有问题——后端已去门卫（快照复制，不冲突），
  // 首条消息 fork = 复制会话前奏开新分支，同样合法。
  // v0.9.0 合并（test-upstream-0831）曾把上游的 sessionBusy || isNew || idx===0 门卫带回来，
  // 导致运行中所有用户消息的「新会话」消失。钉死表达式，合并再顶掉即红灯。
  // 2026-09-18：新增 fork capability 门控（本地会话无 caps 不变；不支持 fork 的外部后端隐藏）。
  assert.match(source, /onFork=\{isNew \|\| !sessionCap\("fork"\) \? undefined : handleFork\}/);
  assert.doesNotMatch(source, /onFork=\{sessionBusy/);
  assert.doesNotMatch(source, /idx === 0 && msg\.role === "user" \? undefined : handleFork/);
});

test("「从此处编辑」收 sessionBusy 门控（运行中隐藏，2026-09-08 拍板）", () => {
  // 从此处编辑发送时会回退会话——运行中标记/回退会与正在跑的轮次冲突，运行中隐藏。
  assert.match(source, /onEditFromHere=\{sessionBusy \|\| isNew \|\| !\(sessionCap\("navigateTree"\) \|\| sessionCap\("fork"\)\) \? undefined : handleEditFromHereMark\}/);
});

test("never falls back to the superseded upstream navigate+editContent path", () => {
  // 上游的 onEditContent 立即跳转+预填语义与 fork 的「标记待发送、发送时回退」不同，
  // 二者不可并存：前者的存在说明 fork 机制被顶掉。禁止它出现在消息渲染行。
  assert.doesNotMatch(source, /onEditContent=\{handleEditContent\}/);
});
