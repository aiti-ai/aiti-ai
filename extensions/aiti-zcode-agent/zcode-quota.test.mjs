/**
 * aiti-zcode-agent tests — coding-plan account quota (pure functions + injectable fetch, zero network).
 *
 * Run: node --test extensions/aiti-zcode-agent/zcode-quota.test.mjs
 * （node 24 原生 TS strip-types，import .ts 与 zcode-core.test.mjs 同款）
 *
 * fixtures 形状 = 2026-11-28 真机 quota/limit 响应（48 机 bigmodel-coding-plan 通道）+
 * writeProviderConfigFile 产物的真实文档结构；无真凭据无真网络。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchCodingPlanQuotaLimit,
  QUOTA_LIMIT_URL,
  quotaLimitToQuotaView,
  readProviderConfigApiKey,
} from "./zcode-core.ts";

/** 真机同构 payload（字段层级/取值域与 2026-11-28 实测一致）。 */
const REAL_PAYLOAD = {
  code: 200,
  msg: "操作成功",
  success: true,
  data: {
    level: "max",
    limits: [
      { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 5, nextResetTime: 1795853416090 },
      { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 50, nextResetTime: 1796081416984 },
      {
        type: "TIME_LIMIT",
        unit: 5,
        number: 1,
        usage: 4000,
        currentValue: 73,
        remaining: 3927,
        percentage: 1,
        nextResetTime: 1798187711998,
        usageDetails: [{ modelCode: "search-prime", usage: 54 }, { modelCode: "web-reader", usage: 19 }],
      },
    ],
  },
};

test("quotaLimitToQuotaView parses the real payload shape", () => {
  const v = quotaLimitToQuotaView(REAL_PAYLOAD, 1_000);
  assert.equal(v.available, true);
  // binding window = weekly (50% > 5%)
  assert.equal(v.usedPercent, 50);
  assert.equal(v.expiresAt, 1796081416984);
  // monthly credits surface as remaining/total/unit for the numeric fallback
  assert.equal(v.remaining, 3927);
  assert.equal(v.total, 4000);
  assert.equal(v.unit, "次");
  assert.match(String(v.note), /max/);
  const pkg = v.packages;
  assert.equal(pkg.length, 3);
  assert.deepEqual(pkg.map((p) => p.name), ["5小时窗口", "周窗口", "月度额度"]);
  assert.equal(pkg[2].remaining, 3927);
  assert.equal(pkg[2].used, 73);
  // display: windows sorted worst-first (weekly 50% binds harder than 5h 5%) + monthly remaining
  const display = String(v.display);
  assert.match(display, /额度 周窗口已用 50% · 5小时窗口已用 5% · 月度额度剩余 3,927 次/);
});

test("quotaLimitToQuotaView degrades without limits", () => {
  const v = quotaLimitToQuotaView({ code: 200, data: {} }, 1_000);
  assert.equal(v.available, false);
  assert.equal(v.reason, "no-limits");
  assert.deepEqual(v.packages, []);
  const v2 = quotaLimitToQuotaView({}, 1_000);
  assert.equal(v2.available, false);
});

test("quotaLimitToQuotaView handles monthly-only payloads", () => {
  const payload = {
    data: { level: "lite", limits: [{ type: "TIME_LIMIT", unit: 5, usage: 100, currentValue: 10, remaining: 90, percentage: 10 }] },
  };
  const v = quotaLimitToQuotaView(payload, 1_000);
  assert.equal(v.available, true);
  assert.equal(v.usedPercent, undefined);
  assert.equal(v.remaining, 90);
  assert.match(String(v.display), /月度额度剩余 90 次/);
  assert.match(String(v.note), /lite/);
});

test("fetchCodingPlanQuotaLimit sends bearer auth to the family endpoint", async () => {
  let captured = null;
  const f = async (url, init) => {
    captured = { url: String(url), headers: init?.headers };
    return new Response(JSON.stringify(REAL_PAYLOAD), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const payload = await fetchCodingPlanQuotaLimit("k-test", "bigmodel", f);
  assert.equal(payload.code, 200);
  assert.equal(captured.url, QUOTA_LIMIT_URL.bigmodel);
  assert.equal(captured.headers.Authorization, "Bearer k-test");

  const fail = async () => new Response("nope", { status: 401 });
  await assert.rejects(() => fetchCodingPlanQuotaLimit("k-test", "bigmodel", fail), /HTTP 401/);
});

test("readProviderConfigApiKey reads writeProviderConfigFile-shaped documents", () => {
  const dir = mkdtempSync(join(tmpdir(), "zcode-quota-test-"));
  try {
    const pcDir = join(dir, "provider-config");
    mkdirSync(pcDir, { recursive: true });
    const doc = {
      schemaVersion: 1,
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: "bigmodel-coding-plan",
              config: { access: { type: "zhipu-coding-plan", apiKey: "abc123" }, api: { type: "anthropic-messages", baseUrl: "https://open.bigmodel.cn/api/anthropic" } },
            },
          ],
        },
        modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      },
    };
    writeFileSync(join(pcDir, "bigmodel-coding-plan.json"), JSON.stringify(doc));
    assert.equal(readProviderConfigApiKey(dir, "bigmodel-coding-plan"), "abc123");
    assert.equal(readProviderConfigApiKey(dir, "zai-coding-plan"), null);
    assert.equal(readProviderConfigApiKey(join(dir, "missing"), "bigmodel-coding-plan"), null);
    // entry without a key → null, not throw
    writeFileSync(join(pcDir, "zai-coding-plan.json"), JSON.stringify({
      config: { providerConfigRules: { providerRules: [{ providerId: "zai-coding-plan", config: { access: {} } }] } },
    }));
    assert.equal(readProviderConfigApiKey(dir, "zai-coding-plan"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
