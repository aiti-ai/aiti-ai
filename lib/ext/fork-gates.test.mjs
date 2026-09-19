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

test("with no registered gates, always passes (zero-extension behavior unchanged)", async () => {
  resetSessionForkGatesForTests();
  assert.equal(await runSessionForkGates(INFO), true);
});

test("all gates pass → true; executed in registration order", async () => {
  resetSessionForkGatesForTests();
  const order = [];
  const off1 = registerSessionForkGate(async () => { order.push(1); return true; });
  const off2 = registerSessionForkGate(async () => { order.push(2); return true; });
  assert.equal(await runSessionForkGates(INFO), true);
  assert.deepEqual(order, [1, 2]);
  off1(); off2();
});

test("any gate returning false → cancel (later gates do not run)", async () => {
  resetSessionForkGatesForTests();
  let ran = false;
  const off1 = registerSessionForkGate(async () => false);
  const off2 = registerSessionForkGate(async () => { ran = true; return true; });
  assert.equal(await runSessionForkGates(INFO), false);
  assert.equal(ran, false);
  off1(); off2();
});

test("a gate throwing → treated as cancel and not propagated upward", async () => {
  resetSessionForkGatesForTests();
  const off = registerSessionForkGate(async () => { throw new Error("boom"); });
  assert.equal(await runSessionForkGates(INFO), false);
  off();
});

test("disposer removes exactly its own registration", async () => {
  resetSessionForkGatesForTests();
  let called = 0;
  const off = registerSessionForkGate(async () => { called++; return true; });
  off();
  assert.equal(await runSessionForkGates(INFO), true);
  assert.equal(called, 0);
});

test("gate receives the full fork context", async () => {
  resetSessionForkGatesForTests();
  let seen = null;
  const off = registerSessionForkGate(async (info) => { seen = info; return true; });
  await runSessionForkGates({ sessionId: "s9", sessionFile: "/x.jsonl", entryId: "e9", position: "before" });
  assert.deepEqual(seen, { sessionId: "s9", sessionFile: "/x.jsonl", entryId: "e9", position: "before" });
  off();
});
