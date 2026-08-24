import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  registerRecoveryItemsProvider,
  getRecoveryProviderItems,
  resetRecoveryProvidersForTests,
} = await jiti.import("../../lib/composer/recovery.ts");

test("聚合多个 provider 的 items；disposer 后移除", () => {
  resetRecoveryProvidersForTests();
  let itemsA = ["a1"];
  const offA = registerRecoveryItemsProvider({ id: "a", getItems: () => itemsA });
  registerRecoveryItemsProvider({ id: "b", getItems: () => ["b1", "b2"] });
  assert.deepEqual(getRecoveryProviderItems(), ["a1", "b1", "b2"]);
  offA();
  assert.deepEqual(getRecoveryProviderItems(), ["b1", "b2"]);
});

test("subscribe 触发重聚合；getItems 抛错被隔离", () => {
  resetRecoveryProvidersForTests();
  const subs = new Set();
  let fail = false;
  registerRecoveryItemsProvider({
    id: "dyn",
    getItems: () => { if (fail) throw new Error("no"); return ["d1"]; },
    subscribe: (cb) => { subs.add(cb); return () => subs.delete(cb); },
  });
  assert.deepEqual(getRecoveryProviderItems(), ["d1"]);
  // provider 内部状态变化 → notify → 重聚合
  for (const cb of subs) cb();
  assert.deepEqual(getRecoveryProviderItems(), ["d1"]);
  // 抛错的 provider 被跳过，不影响整体（返回空但不炸）
  fail = true;
  for (const cb of subs) cb();
  assert.deepEqual(getRecoveryProviderItems(), []);
});
