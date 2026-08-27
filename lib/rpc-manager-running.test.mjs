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
