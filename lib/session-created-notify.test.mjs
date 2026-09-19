import test from "node:test";
import assert from "node:assert/strict";
import { notifySessionCreated } from "./session-created-notify.ts";
import { addPageEventSink } from "./agent-page-events.ts";

test("notifySessionCreated wide publish: one copy each to the core sink and the bus slot, origin passed through", () => {
  const got = [];
  const off = addPageEventSink((f) => got.push(f));
  const slotCalls = [];
  const g = globalThis;
  const prev = g.__piPageEvents;
  // accessor-wrapper shape (same as after the bus takes over): a different reference than the core publish → goes to the slot
  g.__piPageEvents = { publish: (type, data) => slotCalls.push({ type, data }) };
  try {
    notifySessionCreated("sid-1", "/tmp/proj", "fork_branch");
  } finally {
    off();
    if (prev === undefined) delete g.__piPageEvents; else g.__piPageEvents = prev;
  }
  assert.equal(got.length, 1);
  assert.deepEqual(got[0], { type: "sm:session-created", sessionId: "sid-1", cwd: "/tmp/proj", origin: "fork_branch" });
  assert.equal(slotCalls.length, 1);
  assert.deepEqual(slotCalls[0], { type: "sm:session-created", data: { sessionId: "sid-1", cwd: "/tmp/proj", origin: "fork_branch" } });
});

test("notifySessionCreated: slot is a plain object itself (no bus present) → no double publish; missing origin omits the field", () => {
  const got = [];
  const off = addPageEventSink((f) => got.push(f));
  const g = globalThis;
  const prev = g.__piPageEvents;
  g.__piPageEvents = { publish: undefined }; // no slot publish → skip
  try {
    notifySessionCreated("sid-2", "/tmp/p2");
  } finally {
    off();
    if (prev === undefined) delete g.__piPageEvents; else g.__piPageEvents = prev;
  }
  assert.equal(got.length, 1);
  assert.equal("origin" in got[0], false);
});

test("notifySessionCreated: a throwing sink does not leak (broadcast failure never blocks session creation)", () => {
  const off = addPageEventSink(() => { throw new Error("boom"); });
  try {
    assert.doesNotThrow(() => notifySessionCreated("sid-3", "/tmp/p3", "clone"));
  } finally {
    off();
  }
});
