import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 回归保护（2026-09-15 新会话页调整）：
//  1. 新会话欢迎页 Workspace 选择器（Backend 之前，默认当前 cwd）——选择只暂存目标，
//     不立即切换应用工作区；会话创建成功后才切入并打开新会话；
//  2. Backend 下拉内扩展条目（如 ACP agent 管理入口）——管理入口在列表里，不在选择器外；
//  3. 目标工作区变化重挂 composer，丢弃旧 cwd 已 ensure 的 runtime。
const appShell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const chatWindow = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const extTypes = await readFile(new URL("../lib/ext/types.ts", import.meta.url), "utf8");

function callbackBody(source, name, nextName) {
  const start = source.indexOf(`const ${name} = useCallback`);
  const end = source.indexOf(`\n  const ${nextName}`, start);
  assert.notEqual(start, -1, `${name} callback not found`);
  assert.notEqual(end, -1, `${nextName} callback not found after ${name}`);
  return source.slice(start, end);
}

test("新会话页工作区选择：目标 cwd 独立于应用工作区（选择不立即切换）", () => {
  assert.match(appShell, /const \[newSessionWorkspace, setNewSessionWorkspace\] = useState<string \| null>\(null\)/);
  assert.match(appShell, /const targetNewSessionCwd = newSessionWorkspace \?\? effectiveNewSessionCwd/);
  // ChatWindow 拿目标 cwd；草稿 key 仍按当前工作区（切换选择不换草稿槽位）
  assert.match(appShell, /newSessionCwd=\{targetNewSessionCwd\}/);
  assert.match(appShell, /const newSessionDraftKey = selectedSession === null && effectiveNewSessionCwd/);
  // sidebar 的 selectedCwd 不被目标污染（否则选择即触发 handleCwdChange 立即切工作区）
  assert.match(appShell, /selectedCwd: selectedSession\?\.cwd \?\? newSessionCwd \?\? null/);
});

test("切换目标工作区重挂 composer（丢弃旧 cwd 已 ensure 的 runtime，草稿由 keeper 恢复）", () => {
  const body = callbackBody(appShell, "handleNewSessionWorkspaceChange", "newSessionDraftKey");
  assert.match(body, /setNewSessionWorkspace\(next\)/);
  assert.match(body, /setSessionKey\(\(k\) => k \+ 1\)/);
});

test("会话创建成功才切入所选工作区并打开新会话", () => {
  const body = callbackBody(appShell, "handleSessionCreated", "deliverSessionNotification");
  assert.match(body, /setNewSessionWorkspace\(null\)/);
  // 先改写项目身份 + activeCwd（sidebar cwd-sync 早退，不把它当跨项目切换拆会话）
  assert.match(body, /if \(session\.cwd && session\.cwd !== activeCwd\) \{/);
  assert.match(body, /activeProjectKeyRef\.current = workspaceKeyOf\(session\)/);
  assert.match(body, /setActiveCwd\(session\.cwd\)/);
  assert.match(body, /setSelectedSession\(session\)/);
});

test("显式上下文变化清掉暂存目标；同 cwd 身份水合不清", () => {
  for (const [name, nextName] of [
    ["handleSelectSession", "handleNewSession"],
    ["handleNewSession", "hydrateSelectedSession"],
    ["handleSessionForked", "handleInitialRestoreDone"],
  ]) {
    assert.match(callbackBody(appShell, name, nextName), /setNewSessionWorkspace\(null\)/, `${name} 应清暂存目标`);
  }
  assert.match(callbackBody(appShell, "handleSessionDeleted", "handleOpenFile"), /setNewSessionWorkspace\(null\)/);
  // handleCwdChange：清空必须发生在「同 cwd 身份水合/同项目早退」之后——identity hydration
  // 不是用户切换，不得把用户刚选的目标工作区清掉。
  const cwdBody = callbackBody(appShell, "handleCwdChange", "handleSelectSession");
  const hydrationReturn = cwdBody.indexOf("if (currentFreshCwd === cwd && currentProject !== newProject) return;");
  const clear = cwdBody.indexOf("setNewSessionWorkspace(null)");
  assert.notEqual(hydrationReturn, -1);
  assert.notEqual(clear, -1);
  assert.ok(clear > hydrationReturn, "handleCwdChange 的清空应在同 cwd 水合早退之后");
});

test("Backend 下拉内置扩展条目（管理入口在列表内，不在选择器外）", () => {
  assert.match(chatWindow, /useExtSlotItems\("newSessionBackendOptions"\)/);
  assert.match(chatWindow, /BACKEND_EXT_OPTION_PREFIX/);
  assert.match(chatWindow, /backendExtraOptions\.map\(\(item\) => \(/);
  // 选中扩展条目：执行动作并把下拉复位（不改当前 backend）
  assert.match(chatWindow, /e\.target\.value = sessionBackend \?\? ""/);
  assert.match(chatWindow, /\.meta\?\.onClick\?\.\(\)/);
  // 旧选择器外插槽彻底退役
  assert.doesNotMatch(chatWindow, /newSessionBackendBar/);
  assert.match(extTypes, /"newSessionBackendOptions"/);
  assert.doesNotMatch(extTypes, /"newSessionBackendBar"/);
});

test("Workspace 选择器渲染在 Backend 之前", () => {
  const workspaceAt = chatWindow.indexOf(">Workspace</span>");
  const backendAt = chatWindow.indexOf(">Backend</span>");
  assert.notEqual(workspaceAt, -1, "Workspace 标签缺失");
  assert.notEqual(backendAt, -1, "Backend 标签缺失");
  assert.ok(workspaceAt < backendAt, "Workspace 应在 Backend 之前");
  // 默认当前 cwd；选择回传 AppShell（null = 当前工作区）
  assert.match(chatWindow, /value=\{newSessionWorkspace \?\? newSessionCwd \?\? ""\}/);
  assert.match(chatWindow, /onNewSessionWorkspaceChange\?\.\(e\.target\.value \|\| null\)/);
});
