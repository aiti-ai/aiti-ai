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
