/**
 * ext-ui-store tests — DSH 反哺（docs/dsh-adapter-assessment.md §5.2）：
 * 按扩展隔离注册 + disposer 反卷语义。
 */
import assert from "node:assert/strict";
import test from "node:test";

const storePath = new URL("../lib/ext-ui-store.ts", import.meta.url).pathname;
const store = await import(storePath);

function reset() {
  globalThis.__piWebExtUI = undefined;
}

test("registerExtUiItems stamps extId and returns a disposer", () => {
  reset();
  const { registerExtUiItems, getExtUiItems } = store;
  const render = () => null;
  const disposeA = registerExtUiItems("toolbar", [{ id: "a1", render }], "ext-a");
  registerExtUiItems("toolbar", [{ id: "b1", render }], "ext-b");

  assert.equal(getExtUiItems("toolbar").length, 2);
  assert.deepEqual(getExtUiItems("toolbar").map((it) => it.extId), ["ext-a", "ext-b"]);

  // disposer 精确移除本次注册（同 extId 同 id 的其它注册不受影响）
  disposeA();
  assert.equal(getExtUiItems("toolbar").length, 1);
  assert.equal(getExtUiItems("toolbar")[0].id, "b1");
});

test("disposeExtUiItems removes only the (extId, ids) intersection", () => {
  reset();
  const { registerExtUiItems, disposeExtUiItems, getExtUiItems } = store;
  const render = () => null;
  registerExtUiItems("toolbar", [{ id: "a1", render }, { id: "a2", render }], "ext-a");
  registerExtUiItems("toolbar", [{ id: "a1", render }], "ext-b");

  disposeExtUiItems("toolbar", "ext-a", ["a1"]);
  const items = getExtUiItems("toolbar");
  // ext-a 的 a1 移除；ext-b 的 a1 保留；ext-a 的 a2 保留
  assert.equal(items.length, 2);
  assert.ok(items.some((it) => it.id === "a1" && it.extId === "ext-b"));
  assert.ok(items.some((it) => it.id === "a2" && it.extId === "ext-a"));
});

test("removeExtUiItems clears one extension across all slots", () => {
  reset();
  const { registerExtUiItems, removeExtUiItems, getExtUiItems } = store;
  const render = () => null;
  registerExtUiItems("toolbar", [{ id: "a1", render }], "ext-a");
  registerExtUiItems("sidebar", [{ id: "a2", render }], "ext-a");
  registerExtUiItems("toolbar", [{ id: "b1", render }], "ext-b");

  removeExtUiItems("ext-a");
  assert.equal(getExtUiItems("toolbar").length, 1);
  assert.equal(getExtUiItems("toolbar")[0].id, "b1");
  assert.equal(getExtUiItems("sidebar").length, 0);
});

test("registered items are isolated per extension (ids may collide across exts)", () => {
  reset();
  const { registerExtUiItems, getExtUiItems } = store;
  const render = () => null;
  registerExtUiItems("dialogs", [{ id: "same", render }], "ext-a");
  registerExtUiItems("dialogs", [{ id: "same", render }], "ext-b");
  const items = getExtUiItems("dialogs");
  assert.equal(items.length, 2);
  assert.equal(new Set(items.map((it) => it.extId)).size, 2);
});

test("re-registering the same (extId, id) is idempotent (Fast Refresh double materialize)", () => {
  reset();
  const { registerExtUiItems, getExtUiItems } = store;
  const render = () => null;
  registerExtUiItems("chatInputTop", [{ id: "x1", render }], "ext-a");
  registerExtUiItems("chatInputTop", [{ id: "other", render }], "ext-b");
  // Fast Refresh 后 loadExtensions 再次 materialize：同 (extId, id) 重复注册
  for (let i = 0; i < 5; i++) {
    registerExtUiItems("chatInputTop", [{ id: "x1", render }], "ext-a");
  }
  const items = getExtUiItems("chatInputTop");
  // 不累积同 key 项（React "two children with the same key" 回归）
  assert.equal(items.length, 2);
  assert.equal(items.filter((it) => it.id === "x1").length, 1);
  // 保位：覆盖后仍在原位置（顺序稳定，避免重排闪烁）
  assert.equal(items[0].id, "x1");
  assert.equal(items[0].extId, "ext-a");
});
