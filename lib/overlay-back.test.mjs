// Unit tests for the mobile system-back overlay unwinder (lib/overlay-back.ts).
//
// Fully simulates "pushState same-URL entry + asynchronous back traversal + popstate" with a
// fake window/history:
//   - open → system back: close the layer, step off the overlay entry;
//   - close → self cleanup: no leftover empty entry (microtask back); close-then-open in the
//     same commit race cancels the back;
//   - LIFO open/close sequences, vacant-slot skipping, forward normalization, Next `__NA`
//     state preservation.
// Isolation: module-level stack state → jiti moduleCache:false for a fresh instance per case.
// Run: node --experimental-strip-types --test lib/overlay-back.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });

/**
 * Fake browser history: entries/index model + back()/forward() enqueue (asynchronous traversal);
 * flush() dispatches popstate. pushState gets no Next patch (the module itself spreads
 * history.state, so `__NA` preservation is verifiable).
 */
function makeWindow() {
  const listeners = { popstate: [] };
  const entries = [{ state: { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: ["base"] } }];
  let index = 0;
  const queue = [];
  const history = {
    get state() {
      return entries[index]?.state ?? null;
    },
    get length() {
      return entries.length;
    },
    pushState(state) {
      entries.splice(index + 1);
      entries.push({ state });
      index += 1;
    },
    replaceState(state) {
      entries[index] = { state };
    },
    back() {
      queue.push(-1);
    },
    forward() {
      queue.push(1);
    },
  };
  const win = {
    history,
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
    },
  };
  /** Run the queued traversal and dispatch popstate; a back triggered inside a popstate handler is consumed in the same pass. */
  function flush() {
    while (queue.length) {
      const step = queue.shift();
      index = Math.max(0, Math.min(entries.length - 1, index + step));
      const event = { state: entries[index]?.state ?? null };
      for (const fn of [...listeners.popstate]) fn(event);
    }
  }
  return { win, history, entries, flush, index: () => index, queue };
}

async function freshLib(win) {
  globalThis.window = win;
  return jiti.import("./overlay-back.ts");
}

test("acquire pushes a same-URL entry preserving Next router state", async () => {
  const h = makeWindow();
  const lib = await freshLib(h.win);
  const closes = [];
  lib.acquireOverlayBack(() => closes.push("a"));
  assert.equal(h.entries.length, 2);
  const state = h.entries[1].state;
  assert.equal(state.__NA, true, "Next's __NA must be preserved, otherwise popstate triggers a full page reload");
  assert.deepEqual(state.__PRIVATE_NEXTJS_INTERNALS_TREE, ["base"]);
  assert.equal(typeof state.__piWebOverlayBack, "number");
  assert.equal(lib.overlayBackDepth(), 1);
});

test("system back closes the top layer and leaves the overlay entry", async () => {
  const h = makeWindow();
  const lib = await freshLib(h.win);
  const closes = [];
  lib.acquireOverlayBack(() => closes.push("a"));
  h.history.back();
  h.flush();
  assert.deepEqual(closes, ["a"]);
  assert.equal(lib.overlayBackDepth(), 0);
  assert.equal(h.index(), 0, "back to the main page entry beneath the overlay");
});

test("UI close releases the layer and cleans its history slot (no leftover entry)", async () => {
  const h = makeWindow();
  const lib = await freshLib(h.win);
  const closes = [];
  const handle = lib.acquireOverlayBack(() => closes.push("a"));
  handle.release();
  await Promise.resolve(); // release's own back is queued in a microtask
  h.flush();
  assert.deepEqual(closes, [], "the self-cleanup back must not call close again");
  assert.equal(h.index(), 0);
  // open another one: reuse the vacant slot (replaceState) instead of stacking more history entries
  const handle2 = lib.acquireOverlayBack(() => closes.push("b"));
  assert.equal(h.entries.length, 2);
  h.history.back();
  h.flush();
  assert.deepEqual(closes, ["b"]);
  handle2.release();
});

test("stacked overlays close in LIFO order", async () => {
  const h = makeWindow();
  const lib = await freshLib(h.win);
  const closes = [];
  lib.acquireOverlayBack(() => closes.push("a"));
  lib.acquireOverlayBack(() => closes.push("b"));
  h.history.back();
  h.flush();
  assert.deepEqual(closes, ["b"]);
  h.history.back();
  h.flush();
  assert.deepEqual(closes, ["b", "a"]);
  assert.equal(h.index(), 0);
});

test("vacant slots left by UI closes are skipped in a single back gesture", async () => {
  const h = makeWindow();
  const lib = await freshLib(h.win);
  const closes = [];
  const a = lib.acquireOverlayBack(() => closes.push("a"));
  lib.acquireOverlayBack(() => closes.push("b"));
  a.release(); // the current entry is b's; a's entry becomes vacant (no back triggered)
  h.history.back(); // after closing b we land on a's vacant slot → skipped automatically
  h.flush();
  assert.deepEqual(closes, ["b"], "a vacant slot must not trigger the released layer's close");
  assert.equal(h.index(), 0, "one back gesture reaches the main page entry directly");
});

test("close-then-open in the same tick: new layer reuses the slot and keeps its back entry", async () => {
  const h = makeWindow();
  const lib = await freshLib(h.win);
  const closes = [];
  const a = lib.acquireOverlayBack(() => closes.push("a"));
  a.release(); // backs in a microtask
  const b = lib.acquireOverlayBack(() => closes.push("b")); // reuses a's vacant slot
  await Promise.resolve();
  h.flush();
  assert.equal(h.entries.length, 2, "vacant slot reused, no new history entry");
  assert.deepEqual(closes, [], "the self-back was canceled; it must not wrongly close the new layer");
  h.history.back();
  h.flush();
  assert.deepEqual(closes, ["b"], "back should close the new layer");
  b.release();
});

test("forward navigation into a stale overlay entry normalizes state without closing", async () => {
  const h = makeWindow();
  const lib = await freshLib(h.win);
  const closes = [];
  const handle = lib.acquireOverlayBack(() => closes.push("a"));
  handle.release();
  await Promise.resolve();
  h.flush(); // back to the main page entry
  h.history.forward(); // forward onto the stale overlay entry
  h.flush();
  assert.deepEqual(closes, [], "forward must not close any layer");
  assert.equal(h.entries[1].state.__piWebOverlayBack, null, "the stale marker is wiped");
  assert.equal(h.entries[1].state.__NA, true, "Next state is still preserved");
});

test("missing entry marker (external replaceState) still closes layers on back", async () => {
  const h = makeWindow();
  const lib = await freshLib(h.win);
  const closes = [];
  lib.acquireOverlayBack(() => closes.push("a"));
  // an external replaceState (e.g. Next route sync) wipes the marker on the current entry
  h.history.replaceState({ __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: ["base"] });
  lib.acquireOverlayBack(() => closes.push("b"));
  h.history.back();
  h.flush();
  assert.deepEqual(closes, ["b"]);
  // backing off an entry whose marker was wiped: no token to match → close the top layer LIFO;
  // "back does nothing while an overlay is open" must never happen
  h.history.back();
  h.flush();
  assert.deepEqual(closes, ["b", "a"]);
  assert.equal(h.index(), 0);
});

test("wiped top entry above an intact layer: back still closes the layer left behind", async () => {
  const h = makeWindow();
  const lib = await freshLib(h.win);
  const closes = [];
  lib.acquireOverlayBack(() => closes.push("a")); // E1 intact (lower active layer)
  lib.acquireOverlayBack(() => closes.push("b")); // E2 intact (lower active layer, e.g. an open right panel)
  lib.acquireOverlayBack(() => closes.push("c")); // E3 → simulates an external replaceState wiping the marker (current entry)
  h.history.replaceState({ __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: ["base"] });
  lib.acquireOverlayBack(() => closes.push("d")); // E4 intact (upper layer, e.g. a location menu)
  h.history.back();
  h.flush();
  assert.deepEqual(closes, ["d"], "the topmost layer closes first");
  // We land on the wiped E3: from=null, fromPos=0; backing again lands on E2 (the intact entry at
  // pos=2) — pos looks like a forward move but must be treated as a back, closing the leftover
  // upper layer (c), otherwise "back does nothing while an overlay is open"
  h.history.back();
  h.flush();
  assert.deepEqual(closes, ["d", "c"]);
  // back on E2 (b still active); the next back closes b per the usual LIFO
  h.history.back();
  h.flush();
  assert.deepEqual(closes, ["d", "c", "b"]);
});

test("forward onto an active layer entry never closes it", async () => {
  const h = makeWindow();
  const lib = await freshLib(h.win);
  const closes = [];
  lib.acquireOverlayBack(() => closes.push("a"));
  lib.acquireOverlayBack(() => closes.push("b"));
  h.history.back();
  h.flush();
  assert.deepEqual(closes, ["b"]);
  h.history.forward(); // forward onto the stale b entry (landing on a's active entry)
  h.flush();
  assert.deepEqual(closes, ["b"], "a certain forward must not close a");
  assert.equal(lib.overlayBackDepth(), 1);
  assert.equal(h.index(), 2);
});

test("UI close after the entry marker was wiped still cleans the slot", async () => {
  const h = makeWindow();
  const lib = await freshLib(h.win);
  const handle = lib.acquireOverlayBack(() => {});
  // simulate a Next route sync: the marker on the current entry is wiped entirely
  h.history.replaceState({ __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: ["base"] });
  handle.release();
  await Promise.resolve();
  h.flush();
  assert.equal(h.index(), 0, "the self-back must still clear the wiped-marker entry (otherwise entries accumulate each round and back lands on old URLs)");
});

test("acquire after a wiped release reuses the stale slot instead of stacking", async () => {
  const h = makeWindow();
  const lib = await freshLib(h.win);
  const closes = [];
  const a = lib.acquireOverlayBack(() => closes.push("a"));
  h.history.replaceState({ __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: ["base"] });
  a.release(); // marker wiped: should still self-clean (microtask already queued)
  const b = lib.acquireOverlayBack(() => closes.push("b")); // should reuse the same vacant slot
  await Promise.resolve(); // the release microtask must have been canceled (slot reused)
  h.flush();
  assert.equal(h.entries.length, 2, "the same entry is reused; entries must not pile up");
  h.history.back();
  h.flush();
  assert.deepEqual(closes, ["b"], "back should close the new layer");
  b.release();
  await Promise.resolve();
  h.flush();
});

test("release is idempotent", async () => {
  const h = makeWindow();
  const lib = await freshLib(h.win);
  const handle = lib.acquireOverlayBack(() => {});
  handle.release();
  handle.release();
  await Promise.resolve();
  h.flush();
  assert.equal(h.queue.length, 0);
  assert.equal(h.index(), 0);
});
