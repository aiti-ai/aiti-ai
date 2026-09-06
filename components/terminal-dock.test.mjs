/**
 * terminalDock 插槽守护测试（源码级断言，T2 dock 真接管）：
 * aiti-cmd 真接管工作区终端页签——渲染归属状态机（tab⇄弹窗单实例二选一）+ 双向占位。
 * 改坏任一断言 = 接管链路回归，先读 docs/todo-upstream-v0.9-integration.md T2 深化结论。
 * Run: node --experimental-strip-types --test components/terminal-dock.test.mjs
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const bridgeSource = await readFile(new URL("./TerminalPanelBridge.tsx", import.meta.url), "utf8");
const typesSource = await readFile(new URL("../lib/ext/types.ts", import.meta.url), "utf8");
const tabStateSource = await readFile(new URL("./terminal-tab-state.ts", import.meta.url), "utf8");

const extDir = new URL("../../aiti-ai/pi-web-ext/aiti-cmd/client/src/index.js", import.meta.url);
let cmdSource = null;
try {
  cmdSource = await readFile(extDir, "utf8");
} catch {
  // aiti-ai 不在相对位置（如独立部署仓）时跳过扩展侧断言
}

test("TerminalPanelBridge renders terminalDock slot items when registered (真接管)", () => {
  assert.match(bridgeSource, /useExtSlotItems\("terminalDock"\)\.find\(hasExtRender\)/);
  assert.match(bridgeSource, /<ExtItemBoundary extId=\{takeover\.extId\} slot="terminalDock" itemId=\{takeover\.id\}>/);
  // 真接管 props：cwd/tabId/active/restored/onClosed 全量透传（归属状态机 key 依赖 tabId）
  assert.match(bridgeSource, /cwd=\{tab\.cwd\}/);
  assert.match(bridgeSource, /tabId=\{tab\.id\}/);
  assert.match(bridgeSource, /restored=\{Boolean\(tab\.restored\)\}/);
});

test("closing→onClosed stays before the takeover early-return (Rules of Hooks)", () => {
  // ✕/restart 收尾必须无条件触发；hook 必须在 if (takeover) 之前（顺序变化 = 部分渲染路径丢 hook）
  const closingIdx = bridgeSource.indexOf("if (tab.closing) onClosed();");
  const returnIdx = bridgeSource.indexOf("if (takeover) {");
  assert.ok(closingIdx !== -1, "closing→onClosed effect 丢失");
  assert.ok(returnIdx !== -1, "takeover 分支丢失");
  assert.ok(closingIdx < returnIdx, "closing effect 必须在 takeover early-return 之前调用（Rules of Hooks）");
});

test("fallback 引导页在扩展缺席时保留（兜底不丢）", () => {
  assert.match(bridgeSource, /TerminalPanelFallback/);
  assert.match(bridgeSource, /t\("terminal\.managedBy"\)/);
  assert.match(bridgeSource, /t\("terminal\.needAitiCmd"\)/);
});

test("terminalDock 契约存在于插槽类型表", () => {
  assert.match(typesSource, /\| "terminalDock"/);
  assert.match(typesSource, /interface TerminalDockSlotProps \{/);
  assert.match(typesSource, /terminalDock: \{ props: TerminalDockSlotProps \};/);
});

test("归属状态机（tab⇄弹窗二选一）与双向占位（aiti-cmd 侧）", () => {
  if (!cmdSource) return; // 扩展源码不可达时跳过（core 断言已覆盖）
  // 归属存储：tabAttached[tabId] = { sessionId, title, cwd }；tabDetached 标记「已拉回窗口」
  assert.match(cmdSource, /const tabAttached = \{\}/);
  assert.match(cmdSource, /const tabDetached = \{\}/);
  // dock 位宿主组件注册到 terminalDock 插槽
  assert.match(cmdSource, /registerItems\("terminalDock"/);
  assert.match(cmdSource, /function WorkspaceTerminalHost/);
  // 页签态头行「拉回窗口」：切归属到弹窗 + 直接打开该会话视图（detach 后窗口可用）
  assert.match(cmdSource, /pullBackToPanel/);
  assert.match(cmdSource, /已在 aiti-cmd 窗口打开/);
  // 弹窗态占位卡：被页签持有（未 detach）时不渲染 TerminalView
  assert.match(cmdSource, /useSessionHostTab\(view && view\.kind === "pty" \? view\.id : null\)/);
  assert.match(cmdSource, /已在工作区页签打开/);
  // restored 语义：恢复页签不静默起 shell（triedRef 只挡自动路径，手动按钮仍在）
  assert.match(cmdSource, /restored 恢复页签不静默起 shell/);
});

test("openAitiCmdShell 死代码已清理（真接管后 core 不再间接唤起弹窗）", () => {
  assert.doesNotMatch(tabStateSource, /openAitiCmdShell/);
});
