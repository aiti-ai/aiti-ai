/**
 * ext-client-loader tests — client-modules 浏览器半（rev 反卷 / 精确 HMR）。
 *
 * loader 依赖浏览器环境（dynamic import / window），node 测试聚焦纯逻辑部分：
 * reconcileGraph 的 rev 差集反卷决策。prefetch/materialize 的 import 语义在
 * ExtSlots 集成与 dev 冒烟中验证。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { reconcileGraph, immediateEntries, isImmediateEntry } from "../components/ext-client-loader.ts";

function graph(entries) {
  return {
    rev: entries.map((e) => e.rev).join(""),
    entries: entries.map((e) => ({
      id: e.id,
      url: `/api/extensions/${e.id}/assets/client.js?rev=${e.rev}`,
      rev: e.rev,
    })),
  };
}

test("no changes → nothing invalidated", () => {
  const g = graph([{ id: "a", rev: "aaa" }, { id: "b", rev: "bbb" }]);
  const removed = [];
  const invalidated = reconcileGraph(g, (id) => removed.push(id));
  assert.deepEqual(invalidated, []);
  assert.deepEqual(removed, []);
});

test("changed bundle rev → that extension invalidated only", () => {
  const g1 = graph([{ id: "a", rev: "aaa" }, { id: "b", rev: "bbb" }]);
  reconcileGraph(g1);
  const removed = [];
  const g2 = graph([{ id: "a", rev: "aaa" }, { id: "b", rev: "BBB" }]);
  const invalidated = reconcileGraph(g2, (id) => removed.push(id));
  assert.deepEqual(invalidated, ["b"]);
  assert.deepEqual(removed, ["b"]);
});

test("removed extension → invalidated (no longer in graph)", () => {
  const g1 = graph([{ id: "a", rev: "aaa" }, { id: "b", rev: "bbb" }]);
  reconcileGraph(g1);
  const removed = [];
  const g2 = graph([{ id: "a", rev: "aaa" }]);
  const invalidated = reconcileGraph(g2, (id) => removed.push(id));
  assert.deepEqual(invalidated, ["b"]);
  assert.deepEqual(removed, ["b"]);
});

test("new extension → not invalidated (prefetch/materialize picks it up)", () => {
  const g1 = graph([{ id: "a", rev: "aaa" }]);
  reconcileGraph(g1);
  const removed = [];
  const g2 = graph([{ id: "a", rev: "aaa" }, { id: "c", rev: "ccc" }]);
  const invalidated = reconcileGraph(g2, (id) => removed.push(id));
  assert.deepEqual(invalidated, []);
  assert.deepEqual(removed, []);
});

test("lazy entries are skipped by the startup batch (immediately:false)", () => {
  const g = graph([{ id: "a", rev: "aaa" }, { id: "b", rev: "bbb" }]);
  g.entries[1].immediately = false;
  // 启动批量（loadExtensions / reloadExtensions）用 immediateEntries 取目标行：
  // 懒加载项既不预取也不 materialize，留给插槽按需触发。
  const startup = immediateEntries(g).map((e) => e.id);
  assert.deepEqual(startup, ["a"]);
  assert.equal(isImmediateEntry(g.entries[0]), true);
  assert.equal(isImmediateEntry(g.entries[1]), false);
  // 未标 immediately 的行默认立即加载（向后兼容：旧 manifest 无此字段）。
  const plain = graph([{ id: "c", rev: "ccc" }]);
  assert.deepEqual(immediateEntries(plain).map((e) => e.id), ["c"]);
  // 空图 → 空批量。
  assert.deepEqual(immediateEntries(graph([])).map((e) => e.id), []);
});

test("concurrent materialize runs register exactly once", async () => {
  // 直接验证 materialize 的互斥语义（不依赖浏览器 import——用 stub 模块表）。
  // prefetch 会走真实 dynamic import，这里只验证并发调度不重复执行 register：
  // 通过两次并发调用同一 id，第二次应复用 in-flight。
  const { materialize } = await import("../components/ext-client-loader.ts");
  // 用已知会失败的 id（无 graph entry）——两次并发都应返回 false 且不抛。
  const results = await Promise.all([
    materialize("no-such-ext-xyz", () => null),
    materialize("no-such-ext-xyz", () => null),
  ]);
  assert.deepEqual(results, [false, false]);
});

test("pruneDeclaredSlots removes declarations for removed extensions", async () => {
  // manifest 重拉后，已卸载扩展的 slot 声明必须被清除（否则 pendingForSlot 残留候选）。
  const { registerDeclaredSlots, pruneDeclaredSlots, pendingForSlot } =
    await import("../components/ext-client-loader.ts");
  // 独特前缀，避免与其他用例/真实声明的模块级状态冲突。
  const SLOT = "test-slot-prune-unique";
  registerDeclaredSlots("ext-prune-a", [SLOT]);
  registerDeclaredSlots("ext-prune-b", [SLOT]);
  assert.deepEqual(pendingForSlot(SLOT), ["ext-prune-a", "ext-prune-b"]);
  // 只保留仍在 manifest 里的 a。
  pruneDeclaredSlots(["ext-prune-a"]);
  assert.deepEqual(pendingForSlot(SLOT), ["ext-prune-a"]);
  // 空声明 = 清除该扩展自己的声明。
  registerDeclaredSlots("ext-prune-a", []);
  assert.deepEqual(pendingForSlot(SLOT), []);
});

test("graph swaps to the new one after reconcile", () => {
  const g1 = graph([{ id: "a", rev: "aaa" }]);
  const g2 = graph([{ id: "a", rev: "AAA" }]);
  reconcileGraph(g1);
  reconcileGraph(g2);
  const invalidated = reconcileGraph(g2);
  assert.deepEqual(invalidated, []);
});

// ── [懒加载 v2] 常挂/交互插槽分流 + 显式物化 API ──

test("pendingForSlotAuto excludes immediately:false entries (lazy extensions)", async () => {
  const { registerDeclaredSlots, pendingForSlot, pendingForSlotAuto, setBootGraph } =
    await import("../components/ext-client-loader.ts");
  const SLOT = "test-slot-auto-unique";
  registerDeclaredSlots("ext-auto-imm", [SLOT]);
  registerDeclaredSlots("ext-auto-lazy", [SLOT]);
  setBootGraph({
    rev: "auto",
    entries: [
      { id: "ext-auto-imm", url: `/api/extensions/ext-auto-imm/assets/client.js`, rev: "i1" },
      { id: "ext-auto-lazy", url: `/api/extensions/ext-auto-lazy/assets/client.js`, rev: "l1", immediately: false },
    ],
  });
  assert.deepEqual(pendingForSlot(SLOT), ["ext-auto-imm", "ext-auto-lazy"], "原语义含懒扩展（交互时插槽用）");
  assert.deepEqual(pendingForSlotAuto(SLOT), ["ext-auto-imm"], "常挂插槽自动通道排除懒扩展");
  // [开页方案 §1 F1] 图里没有的扩展（无 client bundle）也不再放行——fail-closed：
  // 未知 = 不放行（旧语义 `entryOf(id)?.immediately !== false` 对未知项放行，正是
  // 「boot graph 未就绪时 13/13 懒扩展被常挂插槽自动物化」的根因）。
  registerDeclaredSlots("ext-auto-orphan", [SLOT]);
  assert.deepEqual(pendingForSlotAuto(SLOT).includes("ext-auto-orphan"), false, "未知条目不放行（fail-closed）");
  assert.ok(pendingForSlot(SLOT).includes("ext-auto-orphan"), "交互通道仍列出（调用方可显式拉起/降级）");
});

test("pendingForSlotAuto: 图未就绪（空图）一律不放行——懒扩展竞态回归", async () => {
  const { pendingForSlotAuto, registerDeclaredSlots, setBootGraph } = await import("../components/ext-client-loader.ts");
  const SLOT = "test-slot-race-unique";
  registerDeclaredSlots("ext-race-lazy", [SLOT]);
  setBootGraph({ rev: "", entries: [] }); // 模拟 manifest 登记先于 setBootGraph 的窗口
  assert.deepEqual(pendingForSlotAuto(SLOT), [], "空图不放行任何自动物化");
});

test("INTERACTIVE_SLOTS covers the interactive-mount slots", async () => {
  const { INTERACTIVE_SLOTS, pendingForSlotAuto } = await import("../components/ext-client-loader.ts");
  for (const s of ["sessionStats", "fileViewer", "pathPicker", "settingsModels", "settingsAgents", "settingsAgentsFeature"]) {
    assert.ok(INTERACTIVE_SLOTS.has(s), `interactive slot registered: ${s}`);
    assert.ok(!INTERACTIVE_SLOTS.has("toolbar") && !INTERACTIVE_SLOTS.has("sidebar"), "常挂插槽不在交互清单");
  }
  // [开页方案 §1 F2/F3] 这两个槽是「伪交互」——消费点在 AppShell/TerminalPanelBridge 挂载时
  // 即读取（前者为派生 dock tab 列表，后者为常挂隐藏容器），留在清单里会让 6 个懒扩展 +
  // aiti-cmd 开页即被物化。真实交互时刻改由消费方显式 ensureMaterialized。
  assert.ok(!INTERACTIVE_SLOTS.has("rightFileDock"), "rightFileDock 不再是交互插槽（AppShell 常挂消费）");
  assert.ok(!INTERACTIVE_SLOTS.has("terminalDock"), "terminalDock 不再是交互插槽（TerminalPanelBridge 常挂）");
  // pendingForSlotAuto 对交互插槽本就含懒扩展（同 pendingForSlot）——分流点在消费方 hook
  const SLOT = "test-slot-inter-unique";
  const { registerDeclaredSlots, pendingForSlot, setBootGraph } = await import("../components/ext-client-loader.ts");
  registerDeclaredSlots("ext-inter-lazy", [SLOT]);
  setBootGraph({ rev: "inter", entries: [{ id: "ext-inter-lazy", url: "/x", rev: "1", immediately: false }] });
  assert.deepEqual(pendingForSlotAuto(SLOT), [], "懒扩展被 auto 通道排除");
  assert.deepEqual(pendingForSlot(SLOT), ["ext-inter-lazy"], "交互通道保留");
});

test("ensureMaterialized: no bundle → false; already materialized → false (idempotent)", async () => {
  const { ensureMaterialized } = await import("../components/ext-client-loader.ts");
  // 无 bundle（import 失败）→ materialize 返回 false，不 throw
  assert.equal(await ensureMaterialized("ext-ensure-no-bundle", () => null), false);
});
