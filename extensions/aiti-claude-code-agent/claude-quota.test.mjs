/**
 * claude-quota 单测（归一化 + 凭据读取 + fetch 注入）。
 * 注意：本机无 claude 登录，接口形状按社区已知实现（待真机校准）；本测试用假响应钉住归一化契约。
 *
 * Run: node --test pi-web-ext/aiti-claude-code-agent/claude-quota.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { normalizeClaudeUsage, fetchClaudeQuota, readClaudeCreds } = await import("./claude-quota.ts");

const SAMPLE = {
  five_hour: { utilization: 12.5, resets_at: "2026-09-13T15:00:00.000Z" },
  seven_day: { utilization: 40, resets_at: "2026-09-15T00:00:00.000Z" },
  seven_day_opus: { utilization: 5, resets_at: "2026-09-15T00:00:00.000Z" },
};

test("normalizeClaudeUsage：5h/7d 双窗口 → 剩余百分比 + 分包（含 reset 注记）", () => {
  const v = normalizeClaudeUsage(SAMPLE, 1_700_000_000_000);
  assert.equal(v.available, true);
  assert.equal(v.unit, "%");
  assert.equal(v.usedPercent, 40, "主指标取 7d");
  assert.equal(v.remaining, 60);
  assert.equal(v.display, "额度 5h 剩余 87.5% · 7d 剩余 60%");
  assert.deepEqual(v.packages.map((p) => [p.name, p.usedPercent]), [["5 小时窗口", 12.5], ["7 天窗口", 40], ["7 天 Opus", 5]]);
  assert.match(v.packages[0].note, /^重置于 /);
  assert.equal(v.fetchedAt, 1_700_000_000_000);
});

test("normalizeClaudeUsage：窗口缺失优雅降级（仅 7d / 仅 5h / 全缺 = unparsed）", () => {
  const only7 = normalizeClaudeUsage({ seven_day: { utilization: 90 } }, 1);
  assert.equal(only7.available, true);
  assert.equal(only7.display, "额度 7d 剩余 10%");
  assert.equal(only7.usedPercent, 90);

  const only5 = normalizeClaudeUsage({ five_hour: { utilization: 25 } }, 1);
  assert.equal(only5.available, true);
  assert.equal(only5.display, "额度 5h 剩余 75%");
  assert.equal(only5.usedPercent, 25, "仅 5h 时主指标回落 5h");

  const none = normalizeClaudeUsage({ five_hour: {} }, 1);
  assert.equal(none.available, false);
  assert.equal(none.reason, "unparsed");
});

test("normalizeClaudeUsage：tokenExpiresAt 透出为 expiresAt", () => {
  const v = normalizeClaudeUsage(SAMPLE, 1, 1_800_000_000_000);
  assert.equal(v.expiresAt, 1_800_000_000_000);
});

test("fetchClaudeQuota：成功（注入 fetch 校验 headers）+ 非 200 抛错", async () => {
  const ok = await fetchClaudeQuota({
    token: "tok",
    expiresAt: 1_800_000_000_000,
    fetchImpl: async (url, init) => {
      assert.equal(String(url), "https://api.anthropic.com/api/oauth/usage");
      assert.equal(init.headers.Authorization, "Bearer tok");
      assert.equal(init.headers["anthropic-beta"], "oauth-2025-04-20");
      return { ok: true, status: 200, json: async () => SAMPLE };
    },
  });
  assert.equal(ok.available, true);
  assert.equal(ok.expiresAt, 1_800_000_000_000);

  await assert.rejects(
    fetchClaudeQuota({ token: "t", fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }) }),
    /HTTP 403/,
  );
});

test("readClaudeCreds：claudeAiOauth 形态 / 顶层兼容 / 无凭据", () => {
  const home = mkdtempSync(join(tmpdir(), "claude-quota-"));
  try {
    assert.equal(readClaudeCreds(home), null, "无文件 → null");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "oauth-tok", expiresAt: 1_799_000_000_000 } }));
    assert.deepEqual(readClaudeCreds(home), { token: "oauth-tok", expiresAt: 1_799_000_000_000 });
    writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ accessToken: "flat-tok" }));
    assert.deepEqual(readClaudeCreds(home), { token: "flat-tok" }, "顶层兼容");
    writeFileSync(join(home, ".claude", ".credentials.json"), '{"claudeAiOauth":{}}');
    assert.equal(readClaudeCreds(home), null, "无 token → null");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
