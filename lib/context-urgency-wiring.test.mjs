import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

/** 紧迫度着色接线断言（方案 docs/context-compaction-urgency-plan.md §4）：
 *  四个消费方必须全部走 lib/context-urgency.ts 唯一来源，呼吸动画落 globals.css。 */
test("context-urgency 唯一来源被四个消费方接线", async () => {
  const appShell = fs.readFileSync(path.join(ROOT, "components/AppShell.tsx"), "utf8");
  const chatWindow = fs.readFileSync(path.join(ROOT, "components/ChatWindow.tsx"), "utf8");
  const chatInput = fs.readFileSync(path.join(ROOT, "components/ChatInput.tsx"), "utf8");
  const globals = fs.readFileSync(path.join(ROOT, "app/globals.css"), "utf8");
  const helper = fs.readFileSync(path.join(ROOT, "lib/context-urgency.ts"), "utf8");

  // helper：四档 + null 兜底 + 动画名导出
  assert.match(helper, /"calm" \| "warn" \| "urgent" \| "critical"/);
  assert.match(helper, /export function contextUrgency/);
  assert.match(helper, /CTX_BREATHE_ANIMATION = "ctx-urgency-breathe"/);

  // 顶栏（dome 指示）收敛到 helper，不再内联阈值
  assert.match(appShell, /from "@\/lib\/context-urgency"/);
  assert.match(appShell, /contextUrgency\(contextUsage\?\.contextWindow \? contextUsage\.percent : null\)/);
  assert.doesNotMatch(appShell, /pct > 90\) ctxColor/); // 旧内联分档已移除

  // 面板：压缩控制注册 + 上下文行着色按钮
  assert.match(appShell, /onCompactControlsRegister=\{setCompactControls\}/);
  assert.match(chatWindow, /onCompactControlsRegister\?:/);
  assert.match(chatWindow, /export interface CompactControls/);
  assert.match(chatWindow, /onCompactControlsRegister\?\.\(compactControls\)/);

  // ChatInput：contextPercent prop + 两处按钮/圆点消费
  assert.match(chatInput, /contextPercent\?: number \| null/);
  assert.match(chatInput, /const ctxUrg = contextUrgency\(contextPercent\)/);
  assert.match(chatInput, /background: idleCtxColor/); // 弹窗压缩行圆点

  // 全局 CSS：keyframes + reduced-motion 关闭
  assert.match(globals, /@keyframes ctx-urgency-breathe/);
  assert.match(globals, /prefers-reduced-motion: reduce/);
});
