// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for the running/events broker's backend disconnect/recovery broadcasts
// (the data source of the app-restart hint banner)
//
// Contract (lib/agent-running-events.ts):
//   - EventSource onerror ≥2 times in a row → broadcast "offline" once (filters a single
//     network blip);
//   - onopen → reset the failure counter; if offline was broadcast before → broadcast "online" once;
//   - only state transitions are broadcast (continued failures during offline don't re-broadcast);
//   - dual channel: module-level subscription callback + window "piwe-backend-conn" CustomEvent.
//
// Isolation note: `lastConnState`/`connStateListeners` inside the module are module-level
// singletons. Each node:test case needs its own module instance (jiti moduleCache:false +
// re-import each time), otherwise offline/online state left over from the previous case
// pollutes the next (this once made the recreation case misjudge).
// ─────────────────────────────────────────────────────────────────────────────
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

class FakeEventSource {
  readyState = CONNECTING;
  onopen = null;
  onmessage = null;
  onerror = null;
  closeCount = 0;

  constructor() { FakeEventSource.instances.push(this); }
  addEventListener(_type, _handler) { /* named events like heartbeat: not exercised by this test */ }
  open() { this.readyState = OPEN; this.onopen?.(new Event("open")); }
  error() { this.readyState = CLOSED; this.onerror?.(new Event("error")); }
  close() { this.readyState = CLOSED; this.closeCount += 1; }
}
FakeEventSource.instances = [];

const windowEvents = [];
globalThis.window = {
  dispatchEvent: (e) => { windowEvents.push(e); return true; },
};
globalThis.EventSource = FakeEventSource;

const jiti = createJiti(import.meta.url, { moduleCache: false });

/** Fresh module instance: each case imports on its own, isolating the module-level lastConnState/connStateListeners */
function freshLib() {
  return jiti.import("./agent-running-events.ts");
}

/** Clean broker + subscriptions (the previous broker is destroyed when fully unsubscribed;
 *  connFails/connOffline are rebuilt from zero)
 *  @param libInst optional: pass to share the module-level lastConnState within one case (e.g. the recreation case) */
async function harness(libInst) {
  const lib = libInst ?? await freshLib();
  FakeEventSource.instances = [];
  windowEvents.length = 0;
  // the broker singleton hangs on the shared window; teardown already destroyed it — this defensive clear prevents leftovers bleeding across cases
  globalThis.window.__runningEventsBroker = null;
  const states = [];
  const unsubConn = lib.onBackendConnChange((s) => states.push(s));
  const unsubBroker = lib.subscribeRunningEvents(() => {});
  return {
    lib,
    states,
    windowStates: () => windowEvents.map((e) => e.detail?.state),
    source: () => FakeEventSource.instances.at(-1),
    teardown() { unsubBroker(); unsubConn(); },
  };
}

test("getBackendConnState starts null before any broadcast", async () => {
  const lib = await freshLib();
  assert.equal(lib.getBackendConnState(), null);
});

test("offline after 2 consecutive failures, online on reopen, transitions only", async () => {
  const h = await harness();
  try {
    // a single failure (e.g. a restart cutting an in-flight connection / a network blip) → no broadcast
    h.source().error();
    assert.deepEqual(h.states, []);
    assert.deepEqual(h.windowStates(), []);

    // second failure (reconnect loop refused / 502) → judged disconnected, broadcast once
    h.source().error();
    assert.deepEqual(h.states, ["offline"]);
    assert.deepEqual(h.windowStates(), ["offline"]);
    assert.equal(h.lib.getBackendConnState(), "offline");

    // continued failures during offline → only transitions broadcast, no repeats
    h.source().error();
    h.source().error();
    assert.deepEqual(h.states, ["offline"]);

    // reconnect established → broadcast recovery; another open (with no preceding offline) → no broadcast
    h.source().open();
    assert.deepEqual(h.states, ["offline", "online"]);
    h.source().open();
    assert.deepEqual(h.states, ["offline", "online"]);

    // a single blip after recovery → no broadcast
    h.source().error();
    assert.deepEqual(h.states, ["offline", "online"]);

    // disconnect again → broadcast the transition pair again
    h.source().error();
    assert.deepEqual(h.states, ["offline", "online", "offline"]);
    h.source().open();
    assert.deepEqual(h.states, ["offline", "online", "offline", "online"]);
    assert.deepEqual(h.windowStates(), ["offline", "online", "offline", "online"]);
  } finally {
    h.teardown();
  }
});

test("unsubscribed listener no longer receives state changes", async () => {
  const h = await harness();
  const states2 = [];
  const unsub2 = h.lib.onBackendConnChange((s) => states2.push(s));
  unsub2();
  try {
    h.source().error();
    h.source().error();
    assert.deepEqual(h.states, ["offline"]); // still-subscribed works as usual
    assert.deepEqual(states2, []);           // unsubscribed no longer receives
  } finally {
    h.teardown();
  }
});

test("broker recreation corrects a stale offline state on reopen", async () => {
  const lib = await freshLib(); // share the module-level lastConnState within this case
  const h = await harness(lib);
  try {
    h.source().error();
    h.source().error();          // broadcasts offline
    assert.deepEqual(h.states, ["offline"]);
  } finally {
    h.teardown();                // broker destroyed on full unsubscribe (offline state not recovered)
  }
  const h2 = await harness(lib); // rebuild the broker: connOffline reset to zero while lastConnState is still offline
  try {
    h2.source().open();          // the first successful connection corrects it → broadcasts online
    assert.deepEqual(h2.states, ["online"]);
    assert.equal(h2.lib.getBackendConnState(), "online");
  } finally {
    h2.teardown();
  }
});
test("CLOSED error schedules a broker-level reconnect even without error callbacks", async () => {
  // In takeover mode (sidebar dock via subscribePageFrames) there is no error-callback fallback:
  // once an HTTP error flips EventSource to CLOSED, the broker must schedule the rebuild itself,
  // otherwise recovery idles until the 75s watchdog and the disconnect banner lingers.
  const h = await harness();
  try {
    const b = globalThis.window.__runningEventsBroker;
    assert.equal(b.reconnectTimer, null);

    // a single CLOSED error (502): offline not broadcast yet, but the rebuild is already scheduled (orthogonal to the disconnect broadcast)
    h.source().error();
    assert.deepEqual(h.states, []);
    assert.notEqual(b.reconnectTimer, null);

    // run the scheduled rebuild manually (don't wait 3s): a new connection is created → onopen → recovery broadcast
    clearTimeout(b.reconnectTimer);
    b.reconnectTimer = null;
    b.connect();
    assert.equal(FakeEventSource.instances.length, 2);
    h.source().open();
    // connFails only 1 (<2) → offline was never broadcast, open just resets the counter without broadcasting
    assert.deepEqual(h.states, []);
    assert.equal(h.lib.getBackendConnState(), null);

    // full pair: two CLOSED errors → offline broadcast; rebuild succeeds → online
    h.source().error();
    h.source().error();
    assert.deepEqual(h.states, ["offline"]);
    assert.notEqual(b.reconnectTimer, null);
    clearTimeout(b.reconnectTimer);
    b.reconnectTimer = null;
    b.connect();
    h.source().open();
    assert.deepEqual(h.states, ["offline", "online"]);
    assert.deepEqual(h.windowStates(), ["offline", "online"]);
  } finally {
    h.teardown();
  }
});

test("visibilitychange to visible rebuilds a stale connection immediately", async () => {
  // Return-to-foreground relay: for silent dead connections / disconnected states caused by
  // background freezing, switching back to the foreground immediately closes the old connection
  // and creates a new one — a successful onopen broadcasts online right away and the disconnect
  // banner drops without waiting for the heartbeat watchdog.
  const visHandlers = [];
  globalThis.document = {
    visibilityState: "visible",
    addEventListener: (_t, h) => visHandlers.push(h),
    removeEventListener: () => {},
  };
  try {
    const h = await harness();
    try {
      assert.equal(visHandlers.length, 1); // registered once when the broker is created
      const b = globalThis.window.__runningEventsBroker;

      // two CLOSED errors → offline broadcast + a 3s rebuild scheduled
      h.source().error();
      h.source().error();
      assert.deepEqual(h.states, ["offline"]);
      assert.notEqual(b.reconnectTimer, null);

      // back to foreground → relay rebuilds immediately: old connection closed, new one created, the delayed timer cleared
      visHandlers[0]();
      assert.ok(FakeEventSource.instances[0].closeCount >= 1); // old connection was closed
      assert.equal(FakeEventSource.instances.length, 2);
      assert.equal(b.reconnectTimer, null);

      // new connection open → online broadcast (the banner-drop signal)
      h.source().open();
      assert.deepEqual(h.states, ["offline", "online"]);

      // switching to foreground while healthy (brief tab switch away and back) → connection untouched
      visHandlers[0]();
      assert.equal(FakeEventSource.instances.length, 2);
      assert.deepEqual(h.states, ["offline", "online"]);
    } finally {
      h.teardown();
    }
  } finally {
    delete globalThis.document;
  }
});
