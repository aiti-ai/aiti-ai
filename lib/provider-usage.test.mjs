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

async function loadModule(path) {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import(path);
}

test("provider id table covers the P0 adapter set", async () => {
  const { PROVIDER_USAGE_IDS } = await loadSubject();
  for (const id of ["zai", "zai-coding-cn", "kimi-coding", "opencode-go", "github-copilot", "baseten", "siliconflow", "siliconflow-cn"]) {
    assert.equal(PROVIDER_USAGE_IDS.includes(id), true, id);
  }
  // Zen has no usage API (balance is console-only) — no adapter, no id.
  for (const id of ["opencode", "opencode-zen"]) {
    assert.equal(PROVIDER_USAGE_IDS.includes(id), false, id);
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

test("zai marks a used-up window as exhausted with a blocking note", async () => {
  const { getUsageAdapter } = await loadSubject();
  const report = getUsageAdapter("zai-coding-cn").normalize({
    code: 200,
    success: true,
    data: {
      level: "max",
      limits: [
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 0 },
        { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 100, nextResetTime: 1_789_454_630_999 },
        { type: "TIME_LIMIT", unit: 5, number: 1, usage: 4000, currentValue: 4000, percentage: 100 },
      ],
    },
  }, { providerId: "zai-coding-cn", auth: {} });
  const weekly = report.buckets.find((bucket) => bucket.label === "1w");
  assert.equal(weekly.status, "exhausted");
  assert.equal(weekly.remaining, 0);
  assert.equal(report.exhausted, true);
  assert.ok(report.notes.some((note) => note.includes("blocks requests")));
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

test("opencode-go normalizes percent/status/resetsAt windows and flags exhaustion", async () => {
  const { getUsageAdapter } = await loadSubject();
  const payload = {
    usage: {
      rolling: { status: "ok", percent: 0, resetsAt: "2026-09-13T17:55:37.433Z" },
      weekly: { status: "ok", percent: 12, resetsAt: "2026-09-14T00:00:00.433Z" },
      monthly: { status: "rate-limited", percent: 100, resetsAt: "2026-09-17T00:07:23.433Z" },
    },
  };
  const report = getUsageAdapter("opencode-go").normalize(payload, { providerId: "opencode-go", auth: {} });
  assert.equal(report.buckets.length, 3);
  assert.equal(report.buckets[1].remaining, 88);
  assert.equal(report.buckets[1].resetsAt, Math.floor(Date.parse("2026-09-14T00:00:00.433Z") / 1000));
  assert.equal(report.buckets[2].status, "rate-limited");
  assert.equal(report.buckets[2].remaining, 0);
  assert.equal(report.exhausted, true);
});

test("openrouter prefers /credits account balance over the key limit", async () => {
  const { getUsageAdapter } = await loadSubject();
  const credits = getUsageAdapter("openrouter").normalize({
    data: { total_credits: 10, total_usage: 0.024686792 },
  }, { providerId: "openrouter", auth: {} });
  assert.equal(credits.buckets[0].remaining > 9.97, true);
  assert.equal(credits.buckets[0].limit, 10);
  assert.equal(credits.metrics.find((metric) => metric.id === "topped-up").value, "10");
  assert.equal(credits.metrics.find((metric) => metric.id === "spent").value, "0.02");
  const key = getUsageAdapter("openrouter").normalize({
    data: { limit: 20, limit_remaining: 5, usage_daily: 0.5, is_free_tier: false },
  }, { providerId: "openrouter", auth: {} });
  assert.equal(key.buckets[0].remaining, 5);
  assert.equal(key.metrics.find((metric) => metric.id === "daily").value, 0.5);
  const free = getUsageAdapter("openrouter").normalize({
    data: { limit: 0, limit_remaining: null, is_free_tier: true },
  }, { providerId: "openrouter", auth: {} });
  assert.equal(free.metrics.some((metric) => metric.id === "tier"), true);
  // A $0 paid balance is a zero balance, not an overdrawn account.
  const zero = getUsageAdapter("openrouter").normalize({
    data: { total_credits: 0, total_usage: 0 },
  }, { providerId: "openrouter", auth: {} });
  assert.equal(zero.buckets[0].status, "ok");
  assert.notEqual(zero.exhausted, true);
  // Missing total_credits means the balance is unknown: the /key branch handles it.
  assert.throws(() => getUsageAdapter("openrouter").normalize({
    data: { total_usage: 5 },
  }, { providerId: "openrouter", auth: {} }));
});

test("openrouter query falls back to /key when /credits fails", async () => {
  const { getUsageAdapter } = await loadSubject();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/credits")) return new Response("{}", { status: 401 });
    return new Response(JSON.stringify({ data: { limit: 20, limit_remaining: 5 } }), { status: 200 });
  };
  try {
    const report = await getUsageAdapter("openrouter").query({ providerId: "openrouter", auth: { apiKey: "test-key" } });
    assert.equal(report.buckets[0].remaining, 5);
    assert.deepEqual(calls, ["https://openrouter.ai/api/v1/credits", "https://openrouter.ai/api/v1/key"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a fallback URL on a non-official origin is refused before fetching", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return new Response("{}", { status: 200 });
  };
  try {
    const { createJsonAdapter } = await loadModule("./provider-usage/declarative.ts");
    const adapter = createJsonAdapter({
      id: "openrouter",
      displayName: "Test",
      origins: ["https://openrouter.ai"],
      url: () => "https://openrouter.ai/api/v1/credits",
      fallbackUrls: () => ["https://evil.example/usage"],
      normalize: () => {
        throw new Error("normalize failed");
      },
    });
    await assert.rejects(adapter.query({ providerId: "openrouter", auth: {} }), /custom provider origin/);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("epochSeconds accepts ms/seconds numbers, numeric strings and ISO", async () => {
  const { epochSeconds } = await loadModule("./provider-usage/helpers.ts");
  assert.equal(epochSeconds(1_789_454_630_999), 1_789_454_630);
  assert.equal(epochSeconds(1_789_454_630), 1_789_454_630);
  assert.equal(epochSeconds("1789454630999"), 1_789_454_630);
  assert.equal(epochSeconds("2026-09-13T17:55:37.433Z"), Math.floor(Date.parse("2026-09-13T17:55:37.433Z") / 1000));
  assert.equal(epochSeconds(null), undefined);
  assert.equal(epochSeconds("abc"), undefined);
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

test("only opencode-go is adapted; Zen ids stay unsupported", async () => {
  const { getUsageAdapter } = await loadSubject();
  assert.equal(getUsageAdapter("opencode-go").displayName, "OpenCode Go");
  // Zen is a different product without a usage API — no row instead of
  // relabeling Go-plan windows or guessing from the shared origin.
  assert.equal(getUsageAdapter("opencode"), undefined);
  assert.equal(getUsageAdapter("opencode-zen"), undefined);
  assert.equal(getUsageAdapter("opencode-zen", "https://opencode.ai"), undefined);
});

test("rotation pools read enabled apiKeys and skip disabled entries", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "usage-pool-"));
  writeFileSync(join(dir, "models.json"), JSON.stringify({
    providers: {
      "pooled": {
        apiKey: "sk-plain",
        apiKeys: [
          { name: "liyong", key: "sk-one" },
          { name: "off", key: "sk-off", enabled: false },
          { key: "sk-two" },
          { name: "empty", key: "  " },
        ],
      },
      "single": { apiKey: "sk-just-one" },
    },
  }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const { readProviderPoolKeys } = await loadModule("./provider-usage/key-pool.ts");
    assert.deepEqual(readProviderPoolKeys("pooled"), [
      { name: "liyong", key: "sk-one" },
      { name: "key-3", key: "sk-two" },
    ]);
    assert.deepEqual(readProviderPoolKeys("single"), []);
    assert.deepEqual(readProviderPoolKeys("missing"), []);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("proxied multi-key providers query every pool key instead of the dummy token", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "usage-pool-"));
  writeFileSync(join(dir, "models.json"), JSON.stringify({
    providers: { pooled: { apiKeys: [{ name: "a", key: "sk-a" }, { name: "b", key: "sk-b" }] } },
  }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const { resolveUsageTargets } = await loadModule("./provider-usage/key-pool.ts");
    // pi-models-combo registers proxied providers with a per-session dummy token.
    const runtime = { getAuth: async () => ({ auth: { apiKey: "sk-dummy-abc", headers: { "x-opencode-session": "1" } } }) };
    const targets = await resolveUsageTargets(runtime, "pooled");
    assert.deepEqual(targets, [
      { name: "a", auth: { apiKey: "sk-a", headers: { "x-opencode-session": "1" } } },
      { name: "b", auth: { apiKey: "sk-b", headers: { "x-opencode-session": "1" } } },
    ]);
    // Non-proxied providers keep the runtime credential untouched.
    const plain = await resolveUsageTargets({ getAuth: async () => ({ auth: { apiKey: "sk-real" } }) }, "plain");
    assert.deepEqual(plain, [{ auth: { apiKey: "sk-real" } }]);
    // Nothing usable → auth-unavailable.
    assert.equal(await resolveUsageTargets({ getAuth: async () => undefined }, "empty"), null);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("pooled queries merge per-key reports and note failed keys", async () => {
  const { queryUsageTargets } = await loadModule("./provider-usage/key-pool.ts");
  const adapter = {
    id: "opencode-go",
    displayName: "OpenCode Go",
    origins: ["https://opencode.ai"],
    query: async ({ auth }) => {
      if (auth.apiKey === "sk-bad") throw new Error("Usage endpoint returned 403.");
      const percent = auth.apiKey === "sk-a" ? 3 : 19;
      return {
        providerId: "opencode-go",
        providerName: "OpenCode Go",
        capturedAt: 1,
        buckets: [{ id: "window-rolling", label: "Rolling", used: percent, remaining: 100 - percent, limit: 100, unit: "percent" }],
        metrics: [],
      };
    },
  };
  const merged = await queryUsageTargets(adapter, [
    { name: "a", auth: { apiKey: "sk-a" } },
    { name: "bad", auth: { apiKey: "sk-bad" } },
    { name: "c", auth: { apiKey: "sk-c" } },
  ]);
  assert.deepEqual(merged.buckets.map((bucket) => [bucket.id, bucket.label, bucket.used]), [
    ["a:window-rolling", "Rolling · a", 3],
    ["c:window-rolling", "Rolling · c", 19],
  ]);
  assert.deepEqual(merged.notes, ["bad: Usage endpoint returned 403."]);
  // A single healthy key keeps its report untouched (no key suffix).
  const single = await queryUsageTargets(adapter, [{ name: "a", auth: { apiKey: "sk-a" } }]);
  assert.deepEqual(single.buckets.map((bucket) => bucket.label), ["Rolling"]);
  // Every key failing surfaces the upstream error.
  await assert.rejects(queryUsageTargets(adapter, [{ name: "bad", auth: { apiKey: "sk-bad" } }]), /403/);
});
test("normalizes Kimi For Coding quota, rate-limit windows and plan details", () => {
  assert.equal(isProviderUsageId("kimi-coding"), true);
  // The provider's base URL; the usage endpoint lives on the same origin.
  assert.equal(isOfficialProviderUsageOrigin("kimi-coding", "https://api.kimi.com/coding"), true);
  assert.equal(isOfficialProviderUsageOrigin("kimi-coding", "https://proxy.example.com/coding"), false);
  // Response sample from #848 (GET https://api.kimi.com/coding/v1/usages).
  const report = normalizeProviderUsagePayload("kimi-coding", {
    user: { membership: { level: "LEVEL_ADVANCED" } },
    usage: { limit: "100", remaining: "100", resetTime: "2026-09-21T03:17:42Z" },
    limits: [{
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: { limit: "100", used: "1", remaining: "99", resetTime: "2026-09-14T10:17:42Z" },
    }],
    parallel: { limit: "30" },
    authentication: { method: "METHOD_API_KEY", scope: "FEATURE_CODING" },
  }, 123);
  assert.deepEqual(report.buckets, [
    { id: "usage", label: "Overall", used: 0, remaining: 100, limit: 100, unit: "count", resetsAt: Math.floor(Date.parse("2026-09-21T03:17:42Z") / 1_000) },
    { id: "limit-0", label: "5h", used: 1, remaining: 99, limit: 100, unit: "count", windowMinutes: 300, resetsAt: Math.floor(Date.parse("2026-09-14T10:17:42Z") / 1_000) },
  ]);
  assert.deepEqual(report.metrics, [
    { id: "parallel", label: "Parallel requests", value: 30, unit: "count" },
    { id: "membership", label: "Membership", value: "ADVANCED" },
  ]);
  assert.throws(() => normalizeProviderUsagePayload("kimi-coding", { usage: { limit: "x" }, limits: [] }), /no usage data/);
});

test("normalizes OpenCode Go windows into remaining percentages and reset times", () => {
  const report = normalizeProviderUsagePayload("opencode-go", {
    usage: {
      rolling: { status: "ok", percent: 3, resetsAt: "2026-09-14T05:53:50.774Z" },
      weekly: { status: "ok", percent: 1, resetsAt: "2026-09-21T00:00:00.774Z" },
      monthly: { status: "ok", percent: 98, resetsAt: "2026-09-19T02:38:27.774Z" },
    },
  }, 123);
  assert.deepEqual(report.buckets.map((bucket) => [bucket.label, bucket.remaining, bucket.unit, bucket.resetsAt]), [
    ["Rolling", 97, "percent", Math.floor(Date.parse("2026-09-14T05:53:50.774Z") / 1_000)],
    ["Weekly", 99, "percent", Math.floor(Date.parse("2026-09-21T00:00:00.774Z") / 1_000)],
    ["Monthly", 2, "percent", Math.floor(Date.parse("2026-09-19T02:38:27.774Z") / 1_000)],
  ]);
});
