import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  registerQueuePanelController,
  getQueuePanelController,
  resetQueuePanelControllerForTests,
} = await jiti.import("../../lib/composer/queue-api.ts");

test("register/get：注册后可取回；disposer 精确移除", () => {
  resetQueuePanelControllerForTests();
  assert.equal(getQueuePanelController(), null);
  const ctrl = { expand() {} };
  const off = registerQueuePanelController(ctrl);
  assert.equal(getQueuePanelController(), ctrl);
  off();
  assert.equal(getQueuePanelController(), null);
});

test("register(null) 卸载；重复注册覆盖且旧 disposer 不误删新控制器", () => {
  resetQueuePanelControllerForTests();
  const a = { expand() {} };
  const b = { expand() {} };
  const offA = registerQueuePanelController(a);
  registerQueuePanelController(b); // 覆盖
  assert.equal(getQueuePanelController(), b);
  offA(); // 旧 disposer 不应清掉 b
  assert.equal(getQueuePanelController(), b);
  registerQueuePanelController(null);
  assert.equal(getQueuePanelController(), null);
});

test("无接管返回 null（核心恢复流 no-op 路径）", () => {
  resetQueuePanelControllerForTests();
  assert.equal(getQueuePanelController(), null);
});
