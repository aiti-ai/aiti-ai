/**
 * Running broadcast regression (lib/running-broadcast.ts):
 *   1) pure-function behavior: union merge / content key
 *      (lib/running-broadcast-core.ts is dependency-free and directly
 *      loadable);
 *   2) wiring via source-scan: three-way subscription registration
 *      (globalThis idempotent) / wide publish / content dedupe key, the
 *      handle subscription set's globalThis seam, the dual entry points
 *      (instrumentation + running route), and the events route direct call
 *      (prevents double-emitting to the bus alongside the broadcaster).
 *
 * The main module depends on rpc-manager etc. (TS parameter properties, not
 * directly loadable via strip-types) — the functional part lives in the
 * zero-dependency core, and the wiring is guarded by source-scan (project
 * convention, see rpc-manager-running.test.mjs).
 *
 * Background: running frame production was originally tied to the events
 * route connection lifecycle — after page events consolidated into the bus,
 * nobody connected directly (0 connections measured in production on
 * 2026-09-15) → no running frames on the bus → session-manager health check
 * stuck false → 30s fallback polling everywhere. This file pins the fix so
 * merges/refactors cannot quietly remove it.
 *
 * Run: node --experimental-strip-types --test lib/running-broadcast.test.mjs
 * (included in npm test)
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const { mergeRunningIds, runningFrameKey } = await import("./running-broadcast-core.ts");

test("mergeRunningIds: multi-path union dedupe (keeps first-seen order)", () => {
  assert.deepEqual(mergeRunningIds(["a", "b"], ["b", "c"], []), ["a", "b", "c"]);
  assert.deepEqual(mergeRunningIds([], []), []);
});

test("runningFrameKey: set semantics (order-insensitive / content-sensitive)", () => {
  assert.equal(runningFrameKey(["b", "a"]), runningFrameKey(["a", "b"]));
  assert.notEqual(runningFrameKey(["a"]), runningFrameKey(["a", "b"]));
  assert.equal(runningFrameKey([]), "");
});

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

test("running-broadcast: three-way subscription registration + globalThis idempotence + wide publish + content dedupe", async () => {
  const src = await read("./running-broadcast.ts");
  assert.match(src, /subscribeRunningSessions\(\(\) => publishMergedRunning\(\)\)/);
  assert.match(src, /subscribeRunningHandles\(\(\) => publishMergedRunning\(\)\)/);
  assert.match(src, /subscribeBridgeRunning\(\(\) => publishMergedRunning\(\)\)/);
  assert.match(src, /__piRunningBroadcastWired/); // globalThis idempotence flag (registered only once across realms)
  assert.match(src, /publishPageEventToBus\("running", \{ runningSessionIds: ids \}\)/);
  assert.match(src, /__piRunningBroadcastKey/); // content dedupe key (shared across realms)
  assert.match(src, /if \(g\[KEY_SLOT\] === key\) return;/);
});

test("handle-store: the running subscription set goes through the globalThis seam (cross-realm notifications reach the broadcaster)", async () => {
  const src = await read("./session/handle-store.ts");
  assert.match(src, /__piHandleRunningListeners/);
  assert.doesNotMatch(src, /^const runningListeners = new Set/m); // must not regress to a module-level set
});

test("dual entry activation: instrumentation startup section + /api/agent/running snapshot route", async () => {
  const instr = await read("../instrumentation.ts");
  assert.match(instr, /await import\("@\/lib\/running-broadcast"\)/);
  assert.match(instr, /ensureRunningBroadcast\(\)/);
  // must run after the bus startup (the first frame enters the bus through
  // the __piPageEvents accessor; earlier than that, it would be lost)
  const bootIdx = instr.indexOf('startupById("aiti-event-bus")');
  const ensureIdx = instr.indexOf("ensureRunningBroadcast()");
  assert.ok(bootIdx >= 0 && ensureIdx > bootIdx, "ensure must run after the aiti-event-bus startup");

  const snapRoute = await read("../app/api/agent/running/route.ts");
  assert.match(snapRoute, /ensureRunningBroadcast\(\)/);
});

test("events route: running direct call (not wide publish) — bus frames are fed uniformly by the broadcaster, preventing double emission", async () => {
  const src = await read("../app/api/agent/running/events/route.ts");
  assert.match(src, /publishPageEvent\("running", \{ runningSessionIds: mergedRunningIds\(\) \}\)/);
  assert.doesNotMatch(src, /publishPageEventToBus\(\s*"running"/);
});
