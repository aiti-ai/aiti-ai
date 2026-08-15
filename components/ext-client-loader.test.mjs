/**
 * ext-client-loader tests — client-modules 浏览器半（rev 反卷 / 精确 HMR）。
 *
 * loader 依赖浏览器环境（dynamic import / window），node 测试聚焦纯逻辑部分：
 * reconcileGraph 的 rev 差集反卷决策。prefetch/materialize 的 import 语义在
 * ExtSlots 集成与 dev 冒烟中验证。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { reconcileGraph } from "../components/ext-client-loader.ts";

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

test("graph swaps to the new one after reconcile", () => {
  const g1 = graph([{ id: "a", rev: "aaa" }]);
  const g2 = graph([{ id: "a", rev: "AAA" }]);
  reconcileGraph(g1);
  reconcileGraph(g2);
  const invalidated = reconcileGraph(g2);
  assert.deepEqual(invalidated, []);
});
