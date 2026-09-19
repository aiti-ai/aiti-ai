import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  registerQueuePanelController,
  getQueuePanelController,
  resetQueuePanelControllerForTests,
} = await jiti.import("../../lib/composer/queue-api.ts");

test("register/get: retrievable after registration; disposer removes exactly its own", () => {
  resetQueuePanelControllerForTests();
  assert.equal(getQueuePanelController(), null);
  const ctrl = { expand() {} };
  const off = registerQueuePanelController(ctrl);
  assert.equal(getQueuePanelController(), ctrl);
  off();
  assert.equal(getQueuePanelController(), null);
});

test("register(null) unmounts; re-registration overwrites and the old disposer must not remove the new controller", () => {
  resetQueuePanelControllerForTests();
  const a = { expand() {} };
  const b = { expand() {} };
  const offA = registerQueuePanelController(a);
  registerQueuePanelController(b); // overwrite
  assert.equal(getQueuePanelController(), b);
  offA(); // the old disposer must not clear b
  assert.equal(getQueuePanelController(), b);
  registerQueuePanelController(null);
  assert.equal(getQueuePanelController(), null);
});

test("returns null when nothing took over (core recovery-flow no-op path)", () => {
  resetQueuePanelControllerForTests();
  assert.equal(getQueuePanelController(), null);
});
