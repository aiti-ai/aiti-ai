import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  registerRecoveryItemsProvider,
  getRecoveryProviderItems,
  resetRecoveryProvidersForTests,
} = await jiti.import("../../lib/composer/recovery.ts");

test("aggregates items from multiple providers; removed after dispose", () => {
  resetRecoveryProvidersForTests();
  let itemsA = ["a1"];
  const offA = registerRecoveryItemsProvider({ id: "a", getItems: () => itemsA });
  registerRecoveryItemsProvider({ id: "b", getItems: () => ["b1", "b2"] });
  assert.deepEqual(getRecoveryProviderItems(), ["a1", "b1", "b2"]);
  offA();
  assert.deepEqual(getRecoveryProviderItems(), ["b1", "b2"]);
});

test("subscribe triggers re-aggregation; a throwing getItems is isolated", () => {
  resetRecoveryProvidersForTests();
  const subs = new Set();
  let fail = false;
  registerRecoveryItemsProvider({
    id: "dyn",
    getItems: () => { if (fail) throw new Error("no"); return ["d1"]; },
    subscribe: (cb) => { subs.add(cb); return () => subs.delete(cb); },
  });
  assert.deepEqual(getRecoveryProviderItems(), ["d1"]);
  // provider internal state change → notify → re-aggregate
  for (const cb of subs) cb();
  assert.deepEqual(getRecoveryProviderItems(), ["d1"]);
  // a throwing provider is skipped without affecting the rest (returns empty instead of blowing up)
  fail = true;
  for (const cb of subs) cb();
  assert.deepEqual(getRecoveryProviderItems(), []);
});
