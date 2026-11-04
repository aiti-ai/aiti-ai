// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for the running/events broker's onopen snapshot alignment
// (the 2026-11-04 "sidebar spinner takes minutes to stop" fix)
//
// Contract (lib/agent-running-events.ts pullSnapshot):
//   - every connection (re)establishment (EventSource onopen) pulls one authoritative
//     snapshot from GET /api/agent/running and delivers it as a standard running frame
//     ({ type: "running", runningSessionIds }) to BOTH consumers:
//     listeners ("message") and frameListeners (extensions via subscribePageFrames);
//   - rationale: running frames are only broadcast when the set CHANGES — frames missed
//     during a disconnect window are never replayed, and after reconnect the heartbeat
//     alone makes the channel look healthy, so the stale set stayed wrong until the next
//     unrelated running change;
//   - 2s throttle (reconnect storms); failures silent; dead broker delivers nothing.
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
  addEventListener(_type, _handler) { /* named heartbeat: not exercised here */ }
  open() { this.readyState = OPEN; this.onopen?.(new Event("open")); }
  error() { this.readyState = CLOSED; this.onerror?.(new Event("error")); }
  close() { this.readyState = CLOSED; this.closeCount += 1; }
}
FakeEventSource.instances = [];

let snapshotPayloads = []; // scripted GET /api/agent/running responses (shift per call)
let snapshotFetches = 0;

globalThis.window = { dispatchEvent: (e) => true };
// 故意不给 window.addEventListener：event-bus-client.getEventBus 探测不到事件面 →
// busAbsent → 返回 null → broker 落到裸 EventSource 桩（同 backend-conn.test.mjs 的桩策略）。
globalThis.EventSource = FakeEventSource;
globalThis.fetch = async (url) => {
  if (String(url).includes("/api/agent/running")) {
    snapshotFetches += 1;
    const body = snapshotPayloads.shift() ?? { runningSessionIds: [] };
    return { ok: true, json: async () => body };
  }
  return { ok: false, json: async () => ({}) };
};

const jiti = createJiti(import.meta.url, { moduleCache: false });
function freshLib() {
  return jiti.import("./agent-running-events.ts");
}

async function harness() {
  const lib = await freshLib();
  FakeEventSource.instances = [];
  snapshotPayloads = [];
  snapshotFetches = 0;
  globalThis.window.__runningEventsBroker = null;
  const frames = [];      // frameListeners receive (extensions via subscribePageFrames)
  const messages = [];    // listeners receive ("message", data)
  const unsubFrame = lib.subscribePageFrames((f) => frames.push(f));
  const unsubMsg = lib.subscribeRunningEvents((kind, data) => { if (kind === "message") messages.push(data); });
  return {
    lib, frames, messages,
    source: () => FakeEventSource.instances.at(-1),
    teardown() { unsubFrame(); unsubMsg(); },
  };
}

const drain = () => new Promise((r) => setTimeout(r, 5));

test("onopen pulls one snapshot and delivers the running frame to both consumer kinds", async () => {
  const h = await harness();
  try {
    snapshotPayloads = [{ runningSessionIds: ["s1", "s2"] }];
    h.source().open();
    await drain();
    assert.equal(h.messages.length, 1, "listener got one snapshot frame");
    assert.deepEqual(h.messages[0], { type: "running", runningSessionIds: ["s1", "s2"] });
    assert.deepEqual(h.frames.at(-1), { type: "running", runningSessionIds: ["s1", "s2"] },
      "frameListener (extensions) got the same frame shape");
  } finally { h.teardown(); }
});

test("heartbeat-only liveness no longer hides a stale set: snapshot arrives on reconnect", async () => {
  const h = await harness();
  try {
    // first connection: set contains s1 (a running session)
    snapshotPayloads = [{ runningSessionIds: ["s1"] }];
    h.source().open();
    await drain(); // let the first snapshot fetch settle (in-flight dedupe needs it)
    // disconnect window: server-side set drops s1; the running frame is lost
    h.source().error();
    snapshotPayloads = [{ runningSessionIds: [] }];
    // reconnect → snapshot corrects the stale set immediately (this is the fix)
    h.source().open();
    await drain();
    assert.deepEqual(h.messages.at(-1), { type: "running", runningSessionIds: [] },
      "reconnect delivered the authoritative empty set without waiting for the next change");
  } finally { h.teardown(); }
});

test("in-flight dedupe: overlapping opens pull once; settled opens pull again", async () => {
  const h = await harness();
  try {
    snapshotPayloads = [{ runningSessionIds: [] }, { runningSessionIds: [] }];
    h.source().open();
    h.source().open(); // second open while the first fetch is still in flight → deduped
    await drain();
    assert.equal(snapshotFetches, 1, "overlapping onopen pulls are deduped");
    h.source().open(); // fetch settled → a fresh connection pulls again (legal reconnect)
    await drain();
    assert.equal(snapshotFetches, 2, "after the previous fetch settled, a new pull is allowed");
  } finally { h.teardown(); }
});

test("dead broker: late snapshot response delivers nothing", async () => {
  const h = await harness();
  const es = h.source(); // teardown destroys the broker; keep the source to fire onopen late
  try {
    snapshotPayloads = [{ runningSessionIds: ["s1"] }];
    h.teardown(); // full unsubscribe destroys the broker (dead=true)
    es.open();
    await drain();
    assert.equal(h.messages.length, 0, "no delivery after broker destruction");
    assert.equal(h.frames.length, 0, "no delivery after broker destruction");
  } finally { /* already torn down */ }
});
