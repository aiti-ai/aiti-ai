import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./provider-usage.ts");
}

const { isOfficialProviderUsageOrigin, isProviderUsageId, normalizeProviderUsagePayload } = await loadSubject();

test("recognizes only providers with usage adapters", () => {
  assert.equal(isProviderUsageId("openai-codex"), true);
  assert.equal(isProviderUsageId("anthropic"), false);
});

test("accepts only the official origin for provider usage credentials", () => {
  assert.equal(isOfficialProviderUsageOrigin("deepseek", "https://api.deepseek.com/v1"), true);
  assert.equal(isOfficialProviderUsageOrigin("deepseek", "https://proxy.example.com/v1"), false);
  assert.equal(isOfficialProviderUsageOrigin("deepseek", "not a URL"), false);
});

test("normalizes Codex windows into remaining percentages and reset times", () => {
  const report = normalizeProviderUsagePayload("openai-codex", {
    rate_limit: {
      primary_window: { used_percent: 12, limit_window_seconds: 18_000, reset_at: 1_800_000_000 },
      secondary_window: { used_percent: 40, limit_window_seconds: 604_800 },
    },
  }, 123);
  assert.deepEqual(report.buckets.map((bucket) => [bucket.label, bucket.groupLabel, bucket.remaining, bucket.resetsAt]), [
    ["5h", undefined, 88, 1_800_000_000],
    ["Weekly", undefined, 60, undefined],
  ]);
});

test("normalizes MiniMax token-plan counts using the reported remaining percent", () => {
  const report = normalizeProviderUsagePayload("minimax", {
    model_remains: [{
      model_name: "MiniMax-M2",
      current_interval_usage_count: 20,
      current_interval_total_count: 100,
      current_interval_remaining_percent: 80,
      current_interval_status: 1,
      start_time: 1_700_000_000_000,
      end_time: 1_700_360_000_000,
      current_weekly_usage_count: 1,
      current_weekly_total_count: 1,
      current_weekly_remaining_percent: 0,
      current_weekly_status: 3,
      weekly_start_time: 1_700_000_000_000,
      weekly_end_time: 1_706_000_000_000,
    }],
  }, 123);
  assert.equal(report.buckets[0].remaining, 80);
  assert.equal(report.buckets[0].used, 20);
  assert.equal(report.buckets[1].period, "Unlimited");
});

// ── registry + new adapters (2026-09-13 rewrite) ─────────────────────────────

async function loadRegistry() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./provider-usage/adapters/index.ts");
}
const registryLoaded = await loadRegistry();
assert.ok(registryLoaded);

test("provider id table covers the P0 adapter set", async () => {
  const { PROVIDER_USAGE_IDS } = await loadSubject();
  for (const id of ["zai", "zai-coding-cn", "kimi-coding", "opencode-go", "github-copilot", "baseten", "siliconflow", "siliconflow-cn"]) {
    assert.equal(PROVIDER_USAGE_IDS.includes(id), true, id);
  }
});

test("custom baseUrl aliases resolve only via unambiguous official origins", async () => {
  const { getUsageAdapter } = await loadSubject();
  assert.equal(getUsageAdapter("deepseek", "https://api.deepseek.com/v1")?.id, "deepseek");
  // zai-coding-cn is bigmodel origin; a custom alias provider on that origin matches uniquely.
  assert.equal(getUsageAdapter("my-glm", "https://open.bigmodel.cn/api")?.id, "zai-coding-cn");
  // Two adapters share nothing ambiguous → unknown origin never matches.
  assert.equal(getUsageAdapter("unknown-provider", "https://example.com"), undefined);
});

test("zai normalizes coding-plan windows and per-model usage details", async () => {
  const { getUsageAdapter } = await loadSubject();
  const adapter = getUsageAdapter("zai-coding-cn");
  const report = adapter.normalize({
    code: 200,
    success: true,
    data: {
      level: "max",
      limits: [
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 0 },
        { type: "TIME_LIMIT", unit: 5, number: 1, usage: 4000, currentValue: 678, remaining: 3322, percentage: 16,
          nextResetTime: 1_789_454_630_999,
          usageDetails: [{ modelCode: "search-prime", usage: 456 }, { modelCode: "web-reader", usage: 222 }] },
      ],
    },
  }, { providerId: "zai-coding-cn", auth: {} });
  assert.equal(report.providerId, "zai-coding-cn");
  assert.equal(report.buckets[0].unit, "percent");
  assert.equal(report.buckets[0].remaining, 100);
  assert.equal(report.buckets[1].unit, "count");
  assert.equal(report.buckets[1].remaining, 3322);
  assert.equal(report.buckets[1].resetsAt, 1_789_454_630);
  assert.deepEqual(report.metrics.map((metric) => metric.label), ["search-prime", "web-reader"]);
  assert.ok(report.notes[0].includes("max"));
});

test("siliconflow normalizes the user/info balance envelope", async () => {
  const { getUsageAdapter } = await loadSubject();
  const report = getUsageAdapter("siliconflow-cn").normalize({
    code: 200, status: true,
    data: { balance: "1.37", chargeBalance: "9.9", voucherBalance: "0", totalBalance: "11.27" },
  }, { providerId: "siliconflow-cn", auth: {} });
  assert.equal(report.metrics.find((metric) => metric.id === "total").value, "11.27");
  assert.equal(report.metrics[0].currency, "CNY");
});

test("github-copilot normalizes quota snapshots into remaining buckets", async () => {
  const { getUsageAdapter } = await loadSubject();
  const report = getUsageAdapter("github-copilot").normalize({
    copilot_plan: "pro",
    quota_reset_date: "2026-10-01",
    quota_snapshots: {
      chat: { entitlement: 300, remaining: 250, unlimited: false },
      premium_interactions: { entitlement: 1000, remaining: 100, unlimited: false },
      completions: { entitlement: 0, remaining: 0, unlimited: true },
    },
  }, { providerId: "github-copilot", auth: {} });
  const premium = report.buckets.find((bucket) => bucket.label === "premium interactions");
  assert.equal(premium.remaining, 100);
  assert.equal(premium.used, 900);
  assert.equal(report.metrics.find((metric) => metric.id === "plan").value, "pro");
});

test("opencode-go normalizes rolling/weekly/monthly windows", async () => {
  const { getUsageAdapter } = await loadSubject();
  const report = getUsageAdapter("opencode-go").normalize({
    usage: {
      rolling: { used: 12, limit: 100 },
      weekly: { used: 40, limit: 200 },
    },
  }, { providerId: "opencode-go", auth: {} });
  assert.equal(report.buckets.length, 2);
  assert.equal(report.buckets[0].remaining, 88);
});

test("kimi-coding tolerates window maps and booster wallet", async () => {
  const { getUsageAdapter } = await loadSubject();
  const report = getUsageAdapter("kimi-coding").normalize({
    usage: { five_hour: { used_percent: 30, reset_at: 1_700_000_000_000 }, weekly: { used_percent: 10 } },
    booster_wallet: { balance: "12.5" },
  }, { providerId: "kimi-coding", auth: {} });
  assert.equal(report.buckets.length, 2);
  assert.equal(report.metrics.find((metric) => metric.id === "booster").value, "12.5");
});

test("baseten normalizes the 30d rated spend", async () => {
  const { getUsageAdapter } = await loadSubject();
  const report = getUsageAdapter("baseten").normalize({
    total_rated_usage_cents: 1234,
    usage: [{ model_id: "deepseek-v3", rated_usage_cents: 1000 }],
  }, { providerId: "baseten", auth: {} });
  assert.equal(report.metrics[0].value, "12.34");
  assert.equal(report.metrics[1].value, "10.00");
});
