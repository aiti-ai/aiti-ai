/**
 * codex-quota 单测（防御式归一化 + 凭据读取 + fetch 注入）。
 * 注意：本机无 codex 登录，响应形状按社区已知 rate_limits 结构做防御式解析（待真机校准）；
 * 本测试用假响应钉住「多命名兼容 + 解析不到回落 unparsed」契约。
 *
 * Run: node --test pi-web-ext/aiti-codex-agent/codex-quota.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { normalizeCodexUsage, fetchCodexQuota, readCodexCreds } = await import("./codex-quota.ts");

const SAMPLE = {
  plan_type: "plus",
  rate_limits: {
    primary_window: { used_percent: 12.5, window_minutes: 300, resets_in_seconds: 3600 },
    secondary_window: { used_percent: 40, window_minutes: 10080, resets_in_seconds: 600000 },
  },
};

test("normalizeCodexUsage：rate_limits 双窗口 → 5h/周 剩余百分比", () => {
  const v = normalizeCodexUsage(SAMPLE, 1_700_000_000_000);
  assert.equal(v.available, true);
  assert.equal(v.unit, "%");
  assert.equal(v.display, "额度 5h 剩余 87.5% · 周 剩余 60%");
  assert.equal(v.usedPercent, 40, "主指标取次窗口（周）");
  assert.deepEqual(v.packages.map((p) => [p.name, p.usedPercent]), [["5h", 12.5], ["周", 40]]);
  assert.match(v.packages[0].note, /^重置于 /);
  assert.equal(v.note, "套餐：plus");
  assert.equal(v.fetchedAt, 1_700_000_000_000);
});

test("normalizeCodexUsage：命名兼容（camelCase / window_seconds / data 包裹）+ 单窗口", () => {
  const camel = normalizeCodexUsage({
    data: {
      planType: "pro",
      rateLimits: {
        primaryWindow: { usedPercent: 20, windowSeconds: 18000 },
        secondaryWindow: { usedPercent: 55, windowSeconds: 604800 },
      },
    },
  }, 1);
  assert.equal(camel.available, true);
  assert.equal(camel.display, "额度 5h 剩余 80% · 周 剩余 45%");
  assert.equal(camel.note, "套餐：pro");

  const single = normalizeCodexUsage({ rate_limits: { primary_window: { used_percent: 10, window_minutes: 300 } } }, 1);
  assert.equal(single.available, true);
  assert.equal(single.display, "额度 5h 剩余 90%");
  assert.equal(single.usedPercent, 10, "仅单窗口时主指标回落该窗口");
});

test("normalizeCodexUsage：解析不到 → unparsed（不误报）", () => {
  for (const bad of [{}, { rate_limits: {} }, { rate_limits: { primary_window: {} } }, null]) {
    const v = normalizeCodexUsage(bad, 1);
    assert.equal(v.available, false);
    assert.equal(v.reason, "unparsed");
    assert.match(v.note, /待真机校准/);
  }
});

test("fetchCodexQuota：成功（注入 fetch 校验 headers 含 account-id）+ 非 200 抛错", async () => {
  const ok = await fetchCodexQuota({
    token: "tok",
    accountId: "acct-1",
    fetchImpl: async (url, init) => {
      assert.equal(String(url), "https://chatgpt.com/backend-api/wham/usage");
      assert.equal(init.headers.Authorization, "Bearer tok");
      assert.equal(init.headers["chatgpt-account-id"], "acct-1");
      return { ok: true, status: 200, json: async () => SAMPLE };
    },
  });
  assert.equal(ok.available, true);

  const noAcct = await fetchCodexQuota({
    token: "tok",
    fetchImpl: async (url, init) => {
      assert.equal(init.headers["chatgpt-account-id"], undefined, "无 accountId 时不带该头");
      return { ok: true, status: 200, json: async () => SAMPLE };
    },
  });
  assert.equal(noAcct.available, true);

  await assert.rejects(
    fetchCodexQuota({ token: "t", fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }) }),
    /HTTP 429/,
  );
});

test("readCodexCreds：tokens.access_token 形态 / 顶层兼容 / 无凭据", () => {
  const home = mkdtempSync(join(tmpdir(), "codex-quota-"));
  try {
    assert.equal(readCodexCreds(home), null, "无文件 → null");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: "tok-1", account_id: "acct-1" } }));
    assert.deepEqual(readCodexCreds(home), { token: "tok-1", accountId: "acct-1" });
    writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ access_token: "tok-2" }));
    assert.deepEqual(readCodexCreds(home), { token: "tok-2" }, "顶层兼容且无 accountId 省略");
    writeFileSync(join(home, ".codex", "auth.json"), '{"tokens":{}}');
    assert.equal(readCodexCreds(home), null, "无 token → null");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
