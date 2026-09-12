import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 回归保护：运行中 session 联动（侧栏转圈）在合并 plan-a-upstream 时丢失——
// 上游代码把「正常 prompt 发送」路径的 notifyRunningChange() 广播删了，
// 只保留 queue/followUp 路径。结果：发送普通消息后 isRunning 变 true，但 SSE
// 主通道（/api/agent/running/events）没广播 → 左侧 session 列表不显示运行中标志。
// 本文件盯住 prompt 开始 + finishPrompt 结束两处必须广播；只要合并再删，立即红灯。
const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");

// 定位正常 prompt 分支（pendingPromptCount 增设处）到 finishPrompt 的区间
const promptBranch = source.slice(source.indexOf("let acceptPreflight"));

test("prompt 开始时（pendingPromptCount 增设后）广播 running 变化", () => {
  assert.match(
    source,
    /this\.pendingPromptCount \+= 1;\n\s+\/\/ 开始执行.*\n\s+notifyRunningChange\(\);/,
  );
});

test("finishPrompt 结束时（running → idle）广播 running 变化", () => {
  assert.match(
    source,
    /this\.notifyAgentRunCompleteIfIdle\(\);\n\s+\/\/ 运行状态变了.*\n\s+notifyRunningChange\(\);/,
  );
});

test("queue/followUp 路径也保留 running 广播（不因本次修复覆盖丢失）", () => {
  assert.match(source, /this\.promptRunning = true;\n\s+notifyRunningChange\(\);/);
  assert.match(source, /this\.pendingPromptCount \+= 1;\n\s+notifyRunningChange\(\);\s*\n\s+void this\.inner\.followUp/);
});

test("bash 执行开始与结束时也广播 running 变化", () => {
  // 开始：notifyRunningChange 紧跟 executeBash 之前；结束：在 finally 里 const result 之后
  assert.match(source, /notifyRunningChange\(\);\s*\n\s+const execution = this\.inner\.executeBash/);
  assert.match(source, /this\.resetIdleTimer\(\);\s*\n\s+invalidateSessionListCache\(\);\s*\n\s+\/\/ bash 结束[^\n]*\n\s+notifyRunningChange\(\);/);
});

test("subscribeRunningSessions 监听器机制（SSE 主通道基础设施）仍存在", () => {
  assert.match(source, /export function subscribeRunningSessions\(listener: \(ids: string\[\]\) => void\): \(\) => void/);
  assert.match(source, /export function notifyRunningChange\(\): void/);
});

// 回归保护 2（2026-09-12）：旧会话 resume 的「运行中」即时性。
// startRpcSession 的启动是异步重活（扩展加载 + agent 进程/历史/MCP，秒级~十秒级），
// 此前 running 广播要等启动完成后 prompt 提交才发生 → 左侧树转圈迟迟不亮。
// 修复：启动一开始就把 sessionId 计入 starting 集合并广播（getRunningRpcSessionIds
// 合并 starting 集），终局由 IIFE finally 收尾移除并广播。以下三条守护该链路。

test("startRpcSession 旧会话启动一开始即广播 running（前置广播）", () => {
  assert.match(
    source,
    /if \(!isNewSession\) \{\n\s+getStartingSessionIds\(\)\.add\(sessionId\);/,
  );
});

test("getRunningRpcSessionIds 合并 starting 集（转圈即刻亮）", () => {
  assert.match(
    source,
    /for \(const id of getStartingSessionIds\(\)\) ids\.add\(id\);/,
  );
});

test("启动终局（成功/失败）finally 收尾广播退出", () => {
  assert.match(
    source,
    /if \(getStartingSessionIds\(\)\.delete\(sessionId\)\) notifyRunningChange\(\);/,
  );
});

// 回归保护 3（2026-09-12）：新会话草稿行的即时性。
// sm:session-created 原只在启动完成（IIFE 尾部）才 publish → 左侧树草稿行要等完
// 整个启动（秒级~十秒级）。sessionManagerId 在 SessionManager.create 预生成后同步
// 可得，应启动一开始就广播（trackStartingSession 之后、IIFE 之前）。

test("新会话启动一开始即广播 sm:session-created（草稿行即刻出现）", () => {
  assert.match(
    source,
    /if \(isNewSession\) \{\n\s+try \{ publishPageEvent\("sm:session-created", \{ sessionId: sessionManagerId/,
  );
});