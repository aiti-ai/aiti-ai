// aiti-sysmon · core.cjs unit tests (pure helpers, no systeminformation needed)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const core = require("../core.cjs");

test("fmtBytes", () => {
  assert.equal(core.fmtBytes(0), "0 B");
  assert.equal(core.fmtBytes(512), "512 B");
  assert.equal(core.fmtBytes(1024), "1.0 KB");
  assert.equal(core.fmtBytes(1536), "1.5 KB");
  assert.equal(core.fmtBytes(1024 * 1024 * 1024), "1.0 GB");
  assert.equal(core.fmtBytes(123.4 * 1024 * 1024 * 1024), "123 GB"); // ≥100 → 0 digits
  assert.equal(core.fmtBytes(-5), "—");
  assert.equal(core.fmtBytes(null), "—");
  assert.equal(core.fmtBytes(NaN), "—");
});

test("fmtRate", () => {
  assert.equal(core.fmtRate(2048), "2.0 KB/s");
  assert.equal(core.fmtRate(-1), "—");
  assert.equal(core.fmtRate(undefined), "—");
});

test("fmtUptime", () => {
  assert.equal(core.fmtUptime(42), "42s");
  assert.equal(core.fmtUptime(3600 * 5 + 120), "5h 2m");
  assert.equal(core.fmtUptime(86400 * 2 + 3600 * 3), "2d 3h");
  assert.equal(core.fmtUptime(-1), "—");
  assert.equal(core.fmtUptime(null), "—");
});

test("pickTemp filters platform non-readings", () => {
  assert.equal(core.pickTemp(45.6), 46);
  assert.equal(core.pickTemp(-1), null);   // si "not available" sentinel
  assert.equal(core.pickTemp(0), null);
  assert.equal(core.pickTemp(NaN), null);
  assert.equal(core.pickTemp(999), null);  // out of sane range
  assert.equal(core.pickTemp(null), null);
  assert.equal(core.pickTemp("52"), 52);   // numeric strings tolerated
});

test("histPush caps the ring", () => {
  const arr = [];
  for (let i = 0; i < 70; i++) core.histPush(arr, i, 60);
  assert.equal(arr.length, 60);
  assert.equal(arr[0], 10);       // oldest evicted
  assert.equal(arr[59], 69);      // newest kept
});

test("pct clamps", () => {
  assert.equal(core.pct(120), 100);
  assert.equal(core.pct(-3), 0);
  assert.equal(core.pct("55.7"), 55.7);
  assert.equal(core.pct(undefined), 0);
  assert.equal(core.pct(NaN), 0);
});

test("TTLCache expires and clears", async () => {
  const c = new core.TTLCache(20);
  c.set("a", 1);
  assert.equal(c.get("a"), 1);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(c.get("a"), undefined); // expired
  c.set("b", 2);
  c.clear();
  assert.equal(c.get("b"), undefined);
});
