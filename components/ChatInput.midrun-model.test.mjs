import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 回归保护：「运行中 session 改 model」在合并 plan-a-upstream 时被顶掉——
// 模型选择器从「流式可点、切换下轮生效 + 下轮生效徽标」变成 disabled={isStreaming} 锁死。
// 后端 handleModelChange（useAgentSession）仍有 setModel 路径，但 UI 入口被锁 = 功能不可达。
// 本文件盯住 UI 侧：只要合并再把它锁死 / 丢掉 pending 徽标，这里即时红灯。
const chatInput = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
const modelSelector = await readFile(new URL("./ModelSelector.tsx", import.meta.url), "utf8");

test("模型选择器在流式期间保持可点（不因 isStreaming 锁死）", () => {
  assert.match(chatInput, /disabled=\{false\}/);
  // 锁只来自「切换请求进行中」：busy 才锁，流式不锁。
  assert.match(chatInput, /busy=\{modelSwitching\}/);
  // 明确注释：合并后必须保留「流式可点、下轮生效」语义
  assert.match(
    chatInput,
    /Streaming stays clickable: switching mid-run applies next turn \(modelSwitchPending badge\)/,
  );
});

test("运行中切换后把 pending 徽标传给 ModelSelector", () => {
  assert.match(chatInput, /pending=\{modelSwitchPending != null\}/);
});

test("ModelSelector 暴露 pending 徽标 prop 并渲染「下轮生效」", () => {
  assert.match(modelSelector, /pending\?: boolean;/);
  assert.match(modelSelector, /pending = false,/);
  assert.match(modelSelector, /\{pending && \(/);
  assert.match(modelSelector, /t\("chat\.modelSwitchPendingBadge"\)/);
});

test("存在「下轮生效」的 i18n 文案", async () => {
  const { readFile: rf } = await import("node:fs/promises");
  const en = await rf(new URL("../lib/i18n/messages/en.ts", import.meta.url), "utf8");
  assert.match(en, /"chat\.modelSwitchPendingBadge"/);
});
