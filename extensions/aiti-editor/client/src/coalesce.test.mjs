/**
 * coalesce.ts tests — quiet period + max wait + trailing guarantee (fake clock).
 *
 * Plan: docs/aiti-editor-silent-preview-refresh-plan.md §3.5
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-editor/client/src/coalesce.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

const { createCoalescer } = await import("./coalesce.ts");

/** Deterministic timer harness: advance(ms) fires everything due, in schedule order. */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const jobs = new Map();
  return {
    timers: {
      now: () => now,
      setTimeout: (fn, ms) => { const id = ++seq; jobs.set(id, { at: now + ms, fn, seq: id }); return id; },
      clearTimeout: (id) => { jobs.delete(id); },
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...jobs.entries()]
          .filter(([, j]) => j.at <= target)
          .sort((a, b) => (a[1].at - b[1].at) || (a[1].seq - b[1].seq));
        if (!due.length) break;
        const [id, job] = due[0];
        jobs.delete(id);
        now = job.at;
        job.fn();
      }
      now = target;
    },
    get pending() { return jobs.size; },
  };
}

function makeRunCounter() {
  const state = { count: 0 };
  return { state, run: () => { state.count += 1; } };
}

test("quiet period: fires once after silence", () => {
  const clock = fakeClock();
  const { state, run } = makeRunCounter();
  const c = createCoalescer({ quietMs: 300, maxMs: 2000, run, timers: clock.timers });

  c.schedule();
  clock.advance(299);
  assert.equal(state.count, 0);
  clock.advance(1);
  assert.equal(state.count, 1);
  assert.equal(c.pending, false);
});

test("quiet period resets on every schedule (burst merges into one run)", () => {
  const clock = fakeClock();
  const { state, run } = makeRunCounter();
  const c = createCoalescer({ quietMs: 300, maxMs: 2000, run, timers: clock.timers });

  c.schedule();          // t=0
  clock.advance(200);
  c.schedule();          // t=200 → deadline 500
  clock.advance(200);
  c.schedule();          // t=400 → deadline 700
  clock.advance(299);    // t=699
  assert.equal(state.count, 0, "still quiet");
  clock.advance(1);      // t=700
  assert.equal(state.count, 1, "merged burst → one run");
});

test("max wait: a continuous stream still refreshes (trailing guarantee)", () => {
  const clock = fakeClock();
  const { state, run } = makeRunCounter();
  const c = createCoalescer({ quietMs: 350, maxMs: 1500, run, timers: clock.timers });

  // A frame every 300ms for 3s (the agent-streaming shape), quiet period never reached.
  for (let t = 0; t < 3000; t += 300) {
    c.schedule();
    clock.advance(300);
  }
  // The max budget renews, so a long stream refreshes more than once (never frozen).
  assert.ok(state.count >= 1, "a continuous stream must refresh (max wait)");
  // ...and the tail is never left pending: after the stream stops, the last frame lands.
  clock.advance(2000);
  assert.ok(state.count >= 2, `expected the trailing run too, got ${state.count}`);
  const before = state.count;
  clock.advance(2000);
  assert.equal(state.count, before, "no duplicate run after the burst settled");
  assert.equal(c.pending, false);
});

test("trailing edge: the run always sees the newest state, not the throttled one", () => {
  const clock = fakeClock();
  const seen = [];
  let latest = "";
  const c = createCoalescer({
    quietMs: 100, maxMs: 1000,
    run: () => seen.push(latest),
    timers: clock.timers,
  });
  latest = "v1"; c.schedule();
  clock.advance(50);
  latest = "v2"; c.schedule();
  clock.advance(50);
  latest = "v3"; c.schedule();
  clock.advance(500);
  assert.deepEqual(seen, ["v3"], "one run, reading the latest value");
});

test("flush runs immediately and clears the pending timer", () => {
  const clock = fakeClock();
  const { state, run } = makeRunCounter();
  const c = createCoalescer({ quietMs: 300, maxMs: 2000, run, timers: clock.timers });

  c.schedule();
  c.flush();
  assert.equal(state.count, 1);
  assert.equal(clock.pending, 0);
  clock.advance(5000);
  assert.equal(state.count, 1, "flushed run is not replayed");
});

test("cancel drops the pending run (file switch / teardown)", () => {
  const clock = fakeClock();
  const { state, run } = makeRunCounter();
  const c = createCoalescer({ quietMs: 300, maxMs: 2000, run, timers: clock.timers });

  c.schedule();
  c.cancel();
  clock.advance(5000);
  assert.equal(state.count, 0);
  c.schedule();
  clock.advance(300);
  assert.equal(state.count, 1, "scheduler is reusable after cancel");
});

test("zero quiet period runs on the next tick", () => {
  const clock = fakeClock();
  const { state, run } = makeRunCounter();
  const c = createCoalescer({ quietMs: 0, maxMs: 0, run, timers: clock.timers });
  c.schedule();
  assert.equal(state.count, 0, "never synchronous");
  clock.advance(0);
  assert.equal(state.count, 1);
});
