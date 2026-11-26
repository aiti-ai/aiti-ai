/**
 * late-result · unit tests for the pull-after-timeout store.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLateResultStore } from "./late-result.ts";

test("track → get null until settle → get text", () => {
  const s = createLateResultStore();
  s.track("s1", 1000);
  assert.equal(s.isTracked("s1"), true);
  assert.equal(s.get("s1", 1000), null);
  assert.equal(s.settle("s1", "feat: x", 2000), true);
  assert.equal(s.get("s1", 2000), "feat: x");
});

test("settle for an untracked session is ignored (no leak from unrelated runs)", () => {
  const s = createLateResultStore();
  assert.equal(s.settle("other", "feat: y", 1000), false);
  assert.equal(s.get("other", 1000), null);
  assert.equal(s.size(1000), 0);
});

test("entries expire after the TTL", () => {
  const s = createLateResultStore({ ttlMs: 5000 });
  s.track("s1", 1000);
  s.settle("s1", "fix: z", 1000);
  assert.equal(s.get("s1", 5999), "fix: z");
  assert.equal(s.get("s1", 6001), null);
  assert.equal(s.size(6001), 0);
});

test("tracking is bounded: the oldest session is dropped first", () => {
  const s = createLateResultStore({ max: 2 });
  s.track("a", 1000);
  s.track("b", 1001);
  s.track("c", 1002);
  assert.equal(s.isTracked("a"), false);
  assert.equal(s.isTracked("b"), true);
  assert.equal(s.isTracked("c"), true);
  assert.equal(s.size(1002), 2);
});

test("empty ids are ignored", () => {
  const s = createLateResultStore();
  s.track("", 1000);
  assert.equal(s.size(1000), 0);
  assert.equal(s.get("", 1000), null);
  assert.equal(s.settle("", "x", 1000), false);
});

test("fail() records the reason instead of an answer", () => {
  const s = createLateResultStore();
  s.track("s1", 1000);
  assert.equal(s.fail("s1", "all keys failed", 2000), true);
  assert.equal(s.get("s1", 2000), null);
  assert.equal(s.errorOf("s1", 2000), "all keys failed");
  // A later settle (retry succeeded) clears the failure.
  s.settle("s1", "feat: ok", 3000);
  assert.equal(s.errorOf("s1", 3000), null);
  assert.equal(s.get("s1", 3000), "feat: ok");
});

test("fail() for an untracked session is ignored and expires like answers", () => {
  const s = createLateResultStore({ ttlMs: 1000 });
  assert.equal(s.fail("other", "x", 1000), false);
  s.track("s1", 1000);
  s.fail("s1", "boom", 1000);
  assert.equal(s.errorOf("s1", 1500), "boom");
  assert.equal(s.errorOf("s1", 2500), null);
});
