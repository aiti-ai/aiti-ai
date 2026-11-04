/**
 * cursor-quota 单测（归一化 + 凭据读取 + fetch 注入；响应样本来自 2026-09-13 真机实测）。
 *
 * Run: node --test pi-web-ext/aiti-cursor-agent/cursor-quota.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { normalizeCursorUsage, fetchCursorQuota, readCursorToken, cursorAuthPath } = await import("./cursor-quota.ts");

/** 真机实测样本（GetCurrentPeriodUsage）。 */
const SAMPLE = {
  billingCycleStart: "1787582660974",
  billingCycleEnd: "1790261060974",
  planUsage: { totalSpend: 46, bonusSpend: 46, remainingBonus: false, autoPercentUsed: 46, apiPercentUsed: 0, totalPercentUsed: 23 },
  spendLimitUsage: { pooledLimit: 0, pooledRemaining: 0, individualLimit: 0, limitType: "user", overallLimit: 0, overallRemaining: 0 },
  displayThreshold: 200,
  displayMessage: "You've used 0% of your included usage",
  autoModelSelectedDisplayMessage: "You've used 23% of your included total usage",
};

test("normalizeCursorUsage：实测样本 → 剩余 77% + auto/api 分包", () => {
  const v = normalizeCursorUsage(SAMPLE, 1_700_000_000_000);
  assert.equal(v.available, true);
  assert.equal(v.unit, "%");
  assert.equal(v.usedPercent, 23);
  assert.equal(v.remaining, 77);
  assert.equal(v.total, 100);
  assert.equal(v.display, "额度 剩余 77%");
  assert.deepEqual(v.packages.map((p) => [p.name, p.usedPercent]), [["自动模型（auto）", 46], ["API 模型", 0], ["总用量", 23]]);
  assert.equal(v.expiresAt, 1790261060974);
  assert.equal(v.note, "You've used 0% of your included usage");
  assert.equal(v.fetchedAt, 1_700_000_000_000);
});

test("normalizeCursorUsage：消费上限非 0 → 追加一行；缺 totalPercentUsed → unparsed", () => {
  const v = normalizeCursorUsage({ planUsage: { totalPercentUsed: 10, autoPercentUsed: 20, apiPercentUsed: 1 }, spendLimitUsage: { overallLimit: 500, overallRemaining: 120 } });
  assert.equal(v.available, true);
  assert.equal(v.packages.at(-1).name, "消费上限");
  assert.match(v.packages.at(-1).note, /上限 500 \/ 剩余 120/);

  const bad = normalizeCursorUsage({ planUsage: {} });
  assert.equal(bad.available, false);
  assert.equal(bad.reason, "unparsed");
});

test("fetchCursorQuota：成功（fetchImpl 注入）+ 非 200 抛错", async () => {
  const ok = await fetchCursorQuota({
    token: "tok",
    fetchImpl: async (url, init) => {
      assert.match(String(url), /GetCurrentPeriodUsage$/);
      assert.equal(init.method, "POST");
      assert.equal(init.headers.Authorization, "Bearer tok");
      assert.equal(init.headers["Connect-Protocol-Version"], "1");
      return { ok: true, status: 200, json: async () => SAMPLE };
    },
  });
  assert.equal(ok.available, true);
  assert.equal(ok.remaining, 77);

  await assert.rejects(
    fetchCursorQuota({ token: "t", fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) }),
    /HTTP 401/,
  );
});

test("readCursorToken：primary/legacy 路径优先 + 坏文件兜底", () => {
  const home = mkdtempSync(join(tmpdir(), "cursor-quota-"));
  try {
    assert.equal(cursorAuthPath(home), null, "无凭据时 null");
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(join(home, ".cursor", "auth.json"), JSON.stringify({ accessToken: "legacy-tok" }));
    assert.equal(readCursorToken(home), "legacy-tok", "旧路径兜底");
    mkdirSync(join(home, ".config", "cursor"), { recursive: true });
    writeFileSync(join(home, ".config", "cursor", "auth.json"), JSON.stringify({ accessToken: "primary-tok" }));
    assert.equal(readCursorToken(home), "primary-tok", "primary 优先");
    writeFileSync(join(home, ".config", "cursor", "auth.json"), "{broken");
    assert.equal(readCursorToken(home), null, "坏文件 → null");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
