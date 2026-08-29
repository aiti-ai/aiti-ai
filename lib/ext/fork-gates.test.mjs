import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  registerSessionForkGate,
  runSessionForkGates,
  resetSessionForkGatesForTests,
} = await jiti.import("../../lib/ext/fork-gates.ts");

const INFO = { sessionId: "s1", entryId: "e1", position: "before" };

test("无注册 gate 时恒放行（零扩展行为不变）", async () => {
  resetSessionForkGatesForTests();
  assert.equal(await runSessionForkGates(INFO), true);
});

test("全部放行 → true；注册序依次执行", async () => {
  resetSessionForkGatesForTests();
  const order = [];
  const off1 = registerSessionForkGate(async () => { order.push(1); return true; });
  const off2 = registerSessionForkGate(async () => { order.push(2); return true; });
  assert.equal(await runSessionForkGates(INFO), true);
  assert.deepEqual(order, [1, 2]);
  off1(); off2();
});

test("任一 gate 返回 false → 取消（后续 gate 不执行）", async () => {
  resetSessionForkGatesForTests();
  let ran = false;
  const off1 = registerSessionForkGate(async () => false);
  const off2 = registerSessionForkGate(async () => { ran = true; return true; });
  assert.equal(await runSessionForkGates(INFO), false);
  assert.equal(ran, false);
  off1(); off2();
});

test("gate 抛错 → 视为取消且不向上冒", async () => {
  resetSessionForkGatesForTests();
  const off = registerSessionForkGate(async () => { throw new Error("boom"); });
  assert.equal(await runSessionForkGates(INFO), false);
  off();
});

test("disposer 精确移除本次注册", async () => {
  resetSessionForkGatesForTests();
  let called = 0;
  const off = registerSessionForkGate(async () => { called++; return true; });
  off();
  assert.equal(await runSessionForkGates(INFO), true);
  assert.equal(called, 0);
});

test("gate 收到完整 fork 上下文", async () => {
  resetSessionForkGatesForTests();
  let seen = null;
  const off = registerSessionForkGate(async (info) => { seen = info; return true; });
  await runSessionForkGates({ sessionId: "s9", sessionFile: "/x.jsonl", entryId: "e9", position: "before" });
  assert.deepEqual(seen, { sessionId: "s9", sessionFile: "/x.jsonl", entryId: "e9", position: "before" });
  off();
});
