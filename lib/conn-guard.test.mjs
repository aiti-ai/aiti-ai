import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { installConnGuard } = await jiti.import("./conn-guard.ts");

// Anti-deadlock guard behavior tests: fetch observation registration,
// starve/unstarve broadcast timing, recovery delay.
// Browser environment stub + manually advanceable clock (Date.now /
// setTimeout are both replaced with locally controllable versions).
// Note: installConnGuard's module-level installed flag takes effect only
// once → all scenarios share the same environment.
function makeEnv({ fetchImpl }) {
  const listeners = new Map();
  const timers = [];
  let clock = Date.now();
  const window = {
    __connGuardInstalled: false,
    fetch: fetchImpl,
    dispatchEvent: (ev) => {
      for (const fn of listeners.get(ev.type) || []) fn(ev);
      return true;
    },
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => listeners.get(type)?.delete(fn),
  };
  const origSetTimeout = globalThis.setTimeout;
  const origCustomEvent = globalThis.CustomEvent;
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    static now() { return clock; }
  };
  globalThis.setTimeout = (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; };
  globalThis.CustomEvent = class { constructor(type, opts) { this.type = type; this.detail = opts?.detail; } };
  const env = {
    window,
    /** Advances the virtual clock by ms and manually runs due conn-guard timers (simulating the event loop) */
    advance(ms) {
      clock += ms;
      const run = timers.splice(0);
      for (const t of run) t.fn();
    },
    pendingTimerCount: () => timers.length,
    cleanup() {
      globalThis.Date = RealDate;
      globalThis.setTimeout = origSetTimeout;
      globalThis.CustomEvent = origCustomEvent;
      delete globalThis.window;
      delete globalThis.location;
    },
  };
  globalThis.window = window;
  globalThis.location = { origin: "http://x" };
  return env;
}

function hangPromise() {
  const p = { then(onF) { p.resolve = onF; return p; }, catch() { return p; } };
  return p;
}

test("conn-guard: idempotent install + starve/unstarve broadcast timing + recovery delay + no release while starvation persists", async () => {
  const env = makeEnv({ fetchImpl: () => hangPromise() });
  try {
    installConnGuard();
    assert.equal(env.window.__connGuardInstalled, true, "flag should be set after install");
    installConnGuard(); // idempotent: a second install does not double-wrap (passes if no exception)

    const starveEvents = [];
    env.window.addEventListener("piwe-conn-starve", (e) => starveEvents.push(e.detail?.starved));

    // ── Scenario 1: a single hanging request → starve past the threshold; settle → delayed unstarve ──
    const a = env.window.fetch("/api/a", {});
    assert.deepEqual(starveEvents, [], "no broadcast below the threshold (timer not yet due)");

    env.advance(9_000); // advance the clock past STARVE_THRESHOLD_MS, then fire due timers
    assert.deepEqual(starveEvents, [true], "above the threshold should broadcast starve=true");

    a.resolve({ ok: true }); // fetch settles → schedules the delayed recovery
    assert.equal(env.pendingTimerCount(), 1, "a delayed recovery timer should be scheduled after settle");
    assert.deepEqual(starveEvents, [true], "no unstarve broadcast during the delay window");

    env.advance(9_500); // past the max of UNSTARVE_REBUILD_DELAY_MS + UNSTARVE_JITTER_MS
    assert.deepEqual(starveEvents, [true, false], "after delay+jitter window should broadcast unstarve=false");

    // ── Scenario 2: two hanging requests; one completes while the other is still over-age → no release ──
    const b = env.window.fetch("/api/b", {});
    const c = env.window.fetch("/api/c", {});
    env.advance(9_000); // b/c timers due (clock already past the threshold) → starve (more than MIN_STARVE_GAP since the last broadcast, so it can broadcast again)
    assert.equal(starveEvents.at(-1), true, "re-starving should broadcast again");

    b.resolve({ ok: true }); // b completes, but c is still over-age → recovery must not be scheduled
    assert.equal(env.pendingTimerCount(), 0, "no recovery should be scheduled while an over-age request remains");
    assert.equal(starveEvents.includes(false), true ? starveEvents.filter((v) => v === false).length === 1 : false, "unstarve should happen exactly once (scenario 1's)");

    c.resolve({ ok: true }); // c completes too → recovery can be scheduled now
    assert.equal(env.pendingTimerCount(), 1, "recovery should be scheduled once everything settles");
    env.advance(9_500);
    assert.equal(starveEvents.at(-1), false, "recovery broadcast delivered");
  } finally {
    env.cleanup();
  }
});
