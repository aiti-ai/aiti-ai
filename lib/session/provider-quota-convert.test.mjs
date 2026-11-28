import assert from "node:assert/strict";
import test from "node:test";
import { providerReportToUsageSnapshot } from "./provider-quota-convert.ts";

// Pure-conversion tests for the pi-session provider-quota fallback
// (plan: pi-web-pi-session-provider-quota §4-A2). Zero runtime imports —
// this file never touches the ModelRuntime chain.

const ZAI_LIKE = {
  providerId: "zai-coding-cn",
  providerName: "Z.AI Coding CN",
  capturedAt: 1,
  buckets: [
    // count window (real allowance) → detail row
    { id: "limit-0", label: "5h", used: 4000, remaining: 16000, limit: 20000, unit: "count", status: "ok" },
    // percent window (limit=100) → folded into credits.usedPercent, NOT a detail row
    { id: "limit-1", label: "1mo", used: 55, remaining: 45, limit: 100, unit: "percent", status: "ok" },
  ],
  metrics: [],
};

test("count windows become detail rows with stable i18n names; percent share windows are emitted too (total=100)", () => {
  const snapshot = providerReportToUsageSnapshot(ZAI_LIKE);
  assert.equal(snapshot.provider, "zai-coding-cn");
  // Every window the provider reports shows up: the count row + the percent share row.
  assert.equal(snapshot.buckets?.length, 2);
  assert.equal(snapshot.buckets?.[0]?.name, "five_hour");
  assert.equal(snapshot.buckets?.[0]?.total, 20000);
  assert.equal(snapshot.buckets?.[0]?.remaining, 16000);
  assert.equal(snapshot.buckets?.[0]?.usedPercent, 20);
  // percent share row: remaining stays the leftover share, total pins 100; the
  // "1mo" label maps to the stable monthly_credits name (i18n match works).
  assert.equal(snapshot.buckets?.[1]?.name, "monthly_credits");
  assert.equal(snapshot.buckets?.[1]?.total, 100);
  assert.equal(snapshot.buckets?.[1]?.remaining, 45);
  assert.equal(snapshot.buckets?.[1]?.usedPercent, 55);
  // tightest window = the percent one (55% used) — credits lead with what is LEFT (45%),
  // total/unit make the share explicit (remaining-first language, mirrors the provider rows).
  assert.equal(snapshot.credits?.remaining, 45);
  assert.equal(snapshot.credits?.total, 100);
  assert.equal(snapshot.credits?.usedPercent, 55);
  assert.equal(snapshot.credits?.unit, "%");
  assert.equal(snapshot.quotaExceeded, undefined);
});

test("exhausted status maps to both limitReached and quotaExceeded", () => {
  const report = {
    ...ZAI_LIKE,
    buckets: [{ ...ZAI_LIKE.buckets[0], remaining: 0, used: 20000, status: "exhausted" }],
    exhausted: true,
  };
  const snapshot = providerReportToUsageSnapshot(report);
  assert.equal(snapshot.quotaExceeded, true);
  assert.equal(snapshot.buckets?.[0]?.limitReached, true);
  assert.equal(snapshot.credits?.remaining, 0);
  assert.equal(snapshot.credits?.usedPercent, 100);
});

test("balance-style providers (currency metrics only) map to credits {remaining, unit}", () => {
  const snapshot = providerReportToUsageSnapshot({
    providerId: "deepseek",
    providerName: "DeepSeek",
    capturedAt: 1,
    buckets: [],
    metrics: [
      { id: "availability", label: "API calls", value: "Available" },
      { id: "cny-total", label: "Total balance", value: 12.5, unit: "currency", currency: "CNY" },
    ],
  });
  assert.equal(snapshot.buckets, undefined);
  assert.equal(snapshot.credits?.remaining, 12.5);
  assert.equal(snapshot.credits?.unit, "CNY");
  assert.equal(snapshot.credits?.usedPercent, undefined);
});

test("unrecognizable window labels fall back to the raw label", () => {
  const snapshot = providerReportToUsageSnapshot({
    ...ZAI_LIKE,
    buckets: [{ id: "x", label: "weird window", used: 1, remaining: 9, limit: 10, unit: "count", status: "ok" }],
  });
  assert.equal(snapshot.buckets?.[0]?.name, "weird window");
});

test("weekly/monthly windows map to their stable names", () => {
  const snapshot = providerReportToUsageSnapshot({
    ...ZAI_LIKE,
    buckets: [
      { id: "a", label: "1w", used: 0, remaining: 5, limit: 5, unit: "count", status: "ok" },
      { id: "b", label: "30d", used: 0, remaining: 6, limit: 6, unit: "count", status: "ok" },
    ],
  });
  assert.deepEqual(snapshot.buckets?.map((b) => b.name), ["weekly", "monthly_credits"]);
});
