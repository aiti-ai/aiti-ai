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
const extSlotsSource = await readFile(new URL("./ExtSlots.tsx", import.meta.url), "utf8");
const extLoaderSource = await readFile(new URL("./ext-client-loader.ts", import.meta.url), "utf8");
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
  // 接管态 ✕ 收尾立即触发（原生兜底态交给 TerminalPanel 完整收尾）；hook 必须在
  // if (takeover) 之前（顺序变化 = 部分渲染路径丢 hook）
  const closingIdx = bridgeSource.indexOf("if (tab.closing && takeover) onClosed();");
  const returnIdx = bridgeSource.indexOf("if (takeover) {");
  assert.ok(closingIdx !== -1, "closing→onClosed effect 丢失（接管态立即收尾）");
  assert.ok(returnIdx !== -1, "takeover 分支丢失");
  assert.ok(closingIdx < returnIdx, "closing effect 必须在 takeover early-return 之前调用（Rules of Hooks）");
});

test("扩展缺席回落原生 PTY 面板（三层：接管优先/未决占位/原生兜底）", () => {
  // 裁决钩子：boot manifest settle + 无人声明 terminalDock → settled（一次快照定案）
  assert.match(bridgeSource, /useExtSlotSettled\("terminalDock"\)/);
  // settle 前空壳占位（接管迟到即双开，不预判）；settle 后才渲染原生面板
  const settledIdx = bridgeSource.indexOf("if (!settled) {");
  const panelIdx = bridgeSource.indexOf("<TerminalPanel");
  assert.ok(settledIdx !== -1 && panelIdx !== -1, "原生兜底层丢失");
  assert.ok(settledIdx < panelIdx, "占位层必须在原生面板之前（未决不建 PTY）");
  assert.match(bridgeSource, /import \{ TerminalPanel \} from "\.\/TerminalPanel";/);
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
  assert.match(cmdSource, /restored 恢复页签不静默起/);
});

test("openAitiCmdShell 死代码已清理（真接管后 core 不再间接唤起弹窗）", () => {
  assert.doesNotMatch(tabStateSource, /openAitiCmdShell/);
});

// ---- [懒加载适配 2026-09-09] 恢复终端页签永驻「未检测到 aiti-cmd 扩展」根因守护 ----
// 常挂载 dock 插槽（AppShell hidden 容器）挂载早于 manifest 异步拉取：物化 effect 若只
// 依赖 [slot]（恒不变）则首跑 pendingForSlot 恒空，声明扩展永不物化，takeover 永不出现。

test("useExtSlotItems 物化 effect 依赖 ui-store version（manifest 就绪后重估 pending）", () => {
  // version 经 useSyncExternalStore 订阅（manifest 就绪/静态条目/reload 反卷都会 bump）
  assert.match(extSlotsSource, /useSyncExternalStore\(subscribeExtUi, extUiVersion/);
  // 物化 effect 依赖必须含 version；仍是裸 [slot] = 时序竞争回归
  assert.match(extSlotsSource, /\}, \[slot, version\]\);/);
});

test("接管缺席裁决语义：boot settle + 无人声明（ExtSlots/ext-client-loader 侧）", () => {
  // useExtSlotSettled = extBootSettled && !slotDeclared(slot)——以 manifest 声明为准：
  // 物化时序/成败不影响定案（声明了接管就不做原生兜底，防双开；失败走错误指示器）
  assert.match(extSlotsSource, /export function useExtSlotSettled\(slot: ExtSlotName\): boolean \{/);
  assert.match(extSlotsSource, /extBootSettled && !slotDeclared\(slot\)/);
  // boot settle 与加载成败解耦：fetch 失败也置位（此时无人声明 → 原生兜底可用）
  assert.match(extSlotsSource, /notifyExtBootSettled\(\);/);
  assert.match(extLoaderSource, /export function slotDeclared\(slot: string\): boolean \{/);
});
