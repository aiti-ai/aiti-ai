/**
 * toolbar-squeeze.ts squeezeStep state machine tests — FileToolbar mid-band overflow squeeze.
 *
 * Background: compact has a single 620px breakpoint; between it and the toolbar's full natural
 * width the row genuinely overflows (the tail incl. the ⋯ menu button gets clipped, unreachable).
 * squeezeStep drives graduated collapse from a real overflow reading (L1 close row → L2
 * new-window/terminal/download → L3 ‹› nav + count), force-compacts when still overflowing at
 * max (ratcheted exit threshold), and restores with hysteresis. These tests pin down: cascade
 * convergence, stability at a fixed width (no oscillation), monotonic ratchet, restore
 * hysteresis, and the compact boundary.
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-editor/client/src/toolbar-squeeze.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

const { squeezeStep, COMPACT_AT, SQUEEZE_MAX, RESTORE_SLACK, SQUEEZE_FORCE_MARGIN } = await import("./toolbar-squeeze.ts");

/**
 * Iterate N ticks at a fixed width starting from (cur, fc) and return the final state —
 * used to prove fixed-point convergence (no oscillation).
 * needByLevel: natural toolbar width per squeeze level [L0, L1, L2, L3].
 */
function settle(cur, fc, width, needByLevel, iterations = 40) {
  let s = { squeeze: cur, forceCompactAt: fc, compact: width < COMPACT_AT || width < fc };
  for (let i = 0; i < iterations; i++) {
    const need = needByLevel[s.squeeze];
    const overflow = !s.compact && need > width;
    const slack = s.compact ? width - (needByLevel[0] * 0.6) - 8 : Math.max(width - need - 8, 0);
    s = squeezeStep(s.squeeze, s.forceCompactAt, width, overflow, slack);
  }
  return s;
}

test("constants sanity: restore hysteresis exceeds any single restorable group; level cap is 3", () => {
  assert.equal(SQUEEZE_MAX, 3);
  assert.ok(RESTORE_SLACK > 160, "RESTORE_SLACK must exceed the widest group (nav+count ~115px) so a restore never re-overflows");
  assert.ok(SQUEEZE_FORCE_MARGIN >= 40, "exit ratchet margin must cover sub-pixel variance between two same-width readings");
});

test("ample width: no squeeze, no compact (idempotent across repeated measurements)", () => {
  for (let i = 0; i < 5; i++) {
    const s = squeezeStep(0, 0, 1100, false, 300);
    assert.deepEqual(s, { squeeze: 0, forceCompactAt: 0, compact: false });
  }
});

test("mid-band overflow: cascade down to the level that fits (one level per tick, no skipping)", () => {
  // full natural width 860: L1=750 / L2=646 / L3=531; at width 700 it should settle at L2
  const end = settle(0, 0, 700, [860, 750, 646, 531]);
  assert.equal(end.squeeze, 2);
  assert.equal(end.compact, false);
  assert.equal(end.forceCompactAt, 0);
  // at 940 the full layout fits → stays at L0
  assert.equal(settle(0, 0, 940, [860, 750, 646, 531]).squeeze, 0);
});

test("while overflowing each tick climbs exactly one level, capped at SQUEEZE_MAX", () => {
  let s = { squeeze: 0, forceCompactAt: 0, compact: false };
  s = squeezeStep(s.squeeze, s.forceCompactAt, 560, true, 0); // below the compact boundary the cascade still applies (compact itself is decided by width)
  assert.equal(s.squeeze, 1);
  s = squeezeStep(s.squeeze, s.forceCompactAt, 560, true, 0);
  assert.equal(s.squeeze, 2);
  s = squeezeStep(s.squeeze, s.forceCompactAt, 560, true, 0);
  assert.equal(s.squeeze, 3);
  s = squeezeStep(s.squeeze, s.forceCompactAt, 560, true, 0);
  assert.equal(s.squeeze, 3, "already at SQUEEZE_MAX — must not climb further");
});

test("still overflowing at max level → force compact + ratcheted exit threshold; no loop at a fixed width", () => {
  // L3 needs 635 > width 630 → force compact, exit threshold = 630 + 60 = 690
  let s = squeezeStep(3, 0, 630, true, 0);
  assert.equal(s.compact, true);
  assert.equal(s.forceCompactAt, 690);
  // compact face (fits, no overflow): repeated ticks keep compact and freeze the level — no loop
  for (let i = 0; i < 20; i++) {
    s = squeezeStep(s.squeeze, s.forceCompactAt, 630, false, 400);
    assert.equal(s.compact, true, "must not exit forced compact while below the threshold");
    assert.equal(s.squeeze, 3, "level stays frozen while forced compact is active");
  }
  // below the threshold still compact; at/above it, exit renders straight at L3 (fits → no re-force)
  assert.equal(squeezeStep(3, 690, 650, false, 400).compact, true);
  const exit = squeezeStep(3, 690, 700, false, 60);
  assert.equal(exit.compact, false);
  assert.equal(exit.squeeze, 3);
  assert.equal(exit.forceCompactAt, 690);
});

test("exit ratchet only moves up; a new failure at a higher width raises it", () => {
  assert.equal(squeezeStep(3, 690, 500, true, 0).forceCompactAt, 690, "a failure below the existing threshold never lowers it");
  const up = squeezeStep(3, 690, 720, true, 0);
  assert.equal(up.forceCompactAt, 780, "new failure width + 60 raises the ratchet");
});

test("restore hysteresis: no move without enough slack; one level back when slack is ample", () => {
  // slack=100 < RESTORE_SLACK → hold
  assert.equal(squeezeStep(2, 0, 660, false, 100).squeeze, 2);
  // ample slack → restore one level
  assert.equal(squeezeStep(2, 0, 900, false, 260).squeeze, 1);
});

test("compact boundary: 619 → compact, 620 → not compact (independent of squeeze level)", () => {
  assert.equal(squeezeStep(0, 0, COMPACT_AT - 1, false, 400).compact, true);
  assert.equal(squeezeStep(0, 0, COMPACT_AT, false, 0).compact, false);
});

test("pure function: same inputs → same outputs", () => {
  const a = squeezeStep(1, 0, 700, true, 20);
  const b = squeezeStep(1, 0, 700, true, 20);
  assert.deepEqual(a, b);
});
