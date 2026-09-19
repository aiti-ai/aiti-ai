// Contract unit tests for the getEventBus adapter (the transport layer where
// page events converge into a single SSE):
//   - the onmessage property-style handle must actually be wired into frame
//     dispatch (the wiring was once missing: the assignment landed on a plain
//     data property, so in bus mode data frames never reached the subscriber —
//     named events/heartbeat/onopen all looked fine, extremely hard to notice);
//   - frame reassembly contract: {type: topic, evt, ...payload} → onmessage
//     receives {type: evt, ...payload};
//   - absent-bus verdict: a minimal window stub (no event surface) → returns
//     null synchronously, callers fall back to a raw EventSource.
// Isolation: busAbsent/the global ready listener are module-level state;
// jiti moduleCache:false gives each test case its own instance.
// Run: node --experimental-strip-types --test lib/event-bus-client.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });

async function freshLib(windowStub) {
  globalThis.window = windowStub;
  return jiti.import("./event-bus-client.ts");
}

/** For deployment-verdict tests: drives the manifest verdict + drains microtasks. The signal is
 *  taken from inside the event-bus-client module graph (re-export of the same instance);
 *  module-level state like busAbsent is isolated per case via freshLib's moduleCache:false. */
async function freshVerdictLib(windowStub) {
  globalThis.window = windowStub;
  const mod = await jiti.import("./event-bus-client.ts");
  return {
    getEventBus: mod.getEventBus,
    async deployed(value) {
      mod.settleEventBusDeployed(value);
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

test("bus adapter delivers reassembled frames to the onmessage property handle", async () => {
  let deliver;
  const slot = {
    subscribeTopics(handler) {
      deliver = handler;
      return { ready: Promise.resolve(), off() {} };
    },
  };
  const { getEventBus } = await freshLib({
    addEventListener() {}, removeEventListener() {}, __piEventBus: slot,
  });
  const bus = getEventBus("/api/terminal/x/events", { topic: "terminal-x" });
  assert.ok(bus, "must return the adapter when the bus is present");
  const seen = [];
  bus.onmessage = (message) => seen.push(JSON.parse(message.data));
  deliver({ type: "terminal-x", evt: "output", data: "hi", offset: 3 });
  deliver({ type: "terminal-x", evt: "output", data: "!", offset: 4 });
  assert.deepEqual(seen, [
    { type: "output", data: "hi", offset: 3 },
    { type: "output", data: "!", offset: 4 },
  ]);
  bus.close();
});

test("adapter reassembles named events for addEventListener subscribers (heartbeat contract)", async () => {
  let deliver;
  const slot = {
    subscribeTopics(handler) {
      deliver = handler;
      return { ready: Promise.resolve(), off() {} };
    },
  };
  const { getEventBus } = await freshLib({
    addEventListener() {}, removeEventListener() {}, __piEventBus: slot,
  });
  const bus = getEventBus("/api/agent/running/events", { topic: "running" });
  const beats = [];
  bus.addEventListener("heartbeat", (m) => beats.push(m.data));
  deliver({ type: "running", evt: "heartbeat", at: 1 });
  assert.equal(beats.length, 1);
  bus.close();
});

test("absent bus verdict returns null so callers fall back to raw EventSource", async () => {
  // Minimal stub (only dispatchEvent, no event surface) → verdict: absent,
  // synchronously; this path was once mis-wired, making the fallback branch
  // dead code (getEventBus was always truthy, so a deployment without the
  // event bus extension could never connect).
  const { getEventBus } = await freshLib({ dispatchEvent: () => true });
  const bus = getEventBus("/api/agent/running/events", {});
  assert.equal(bus, null);
});

// ---- Unified SSE port plan v2 (user-approved): deployment verdict + queue
// while not ready (no fallback, no timeout) ----

test("deployed but not ready: getEventBus queues the subscription (not null, not CLOSED) and attaches it after the ready broadcast", async () => {
  let deliver;
  const slot = {
    subscribeTopics(handler) {
      deliver = handler;
      return { ready: Promise.resolve(), off() {} };
    },
  };
  const lib = await freshVerdictLib({
    listeners: new Map(),
    addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); },
    removeEventListener() {}, __piEventBus: undefined,
  });
  // manifest verdict: deployed (but the client has not registered/attached the slot yet)
  await lib.deployed(true);
  const bus = lib.getEventBus("/api/agent/running/events", { topic: "running" });
  assert.ok(bus, "deployed but not ready → adapter queues (never falls back to null)");
  assert.equal(bus.readyState, 0, "CONNECTING while queued (callers treat it as connecting; no raw EventSource is spawned)");
  // client register attaches the slot + ready broadcast → the queued subscription connects to the bus
  globalThis.window.__piEventBus = slot;
  for (const fn of globalThis.window.listeners.get("piwe-event-bus-ready") ?? []) fn();
  await new Promise((r) => setTimeout(r, 0));
  const seen = [];
  bus.onmessage = (m) => seen.push(JSON.parse(m.data));
  deliver({ type: "running", running: true });
  assert.deepEqual(seen, [{ type: "running", running: true }], "queued subscriptions attach to the bus after ready");
  bus.close();
});

test("manifest verdict says not deployed → getEventBus returns null synchronously (the only fallback condition)", async () => {
  const lib = await freshVerdictLib({ addEventListener() {}, removeEventListener() {} });
  await lib.deployed(false);
  const bus = lib.getEventBus("/api/agent/running/events", {});
  assert.equal(bus, null, "not deployed → synchronous fallback to native (callers follow their own contracts)");
});

test("a queued adapter flips to CLOSED + one-shot onerror when the verdict turns not-deployed (caller falls back)", async () => {
  const lib = await freshVerdictLib({
    addEventListener() {}, removeEventListener() {}, __piEventBus: undefined,
  });
  const bus = lib.getEventBus("/api/agent/running/events", {});
  assert.ok(bus, "unknown (manifest not back yet) → optimistic queueing");
  const errors = [];
  bus.onerror = (e) => errors.push(e);
  await lib.deployed(false); // manifest came back: bus not installed → verdict flips
  assert.equal(bus.readyState, 2, "verdict turned not-deployed → queued adapter flips to CLOSED");
  assert.equal(errors.length, 1, "one-shot onerror has fired (caller falls back to the raw SSE)");
});
