/**
 * aiti-qoder-agent — 账号额度归一单测（quotaFromUsage 纯函数 → agent-manager 显示契约）。
 *
 * Run: node --test pi-web-ext/aiti-qoder-agent/qoder-quota.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

const { quotaFromUsage } = await import("./qoder-core.mjs");

test("quotaFromUsage：credits 剩余 + 分包 + 套餐 note", () => {
  const v = quotaFromUsage({
    provider: "qoder",
    plan: "Pro",
    buckets: [
      { name: "user_quota", total: 1000, used: 400, remaining: 600, usedPercent: 40 },
      { name: "add_on_quota", total: 500, used: 100, remaining: 400 },
    ],
    credits: { remaining: 1000, unit: "credits", usedPercent: 40, expiresAt: 1790000000000 },
  }, 1700000000000);

  assert.equal(v.available, true);
  assert.equal(v.unit, "credits");
  assert.equal(v.remaining, 1000);
  assert.equal(v.usedPercent, 40);
  assert.equal(v.expiresAt, 1790000000000);
  assert.equal(v.display, "额度 剩余 1,000 credits");
  assert.equal(v.note, "套餐：Pro");
  assert.equal(v.packages.length, 2);
  assert.deepEqual(v.packages[0], { name: "基础配额", total: 1000, used: 400, remaining: 600, usedPercent: 40 });
  assert.deepEqual(v.packages[1], { name: "增购包", total: 500, used: 100, remaining: 400 });
  assert.equal(v.fetchedAt, 1700000000000);
});

test("quotaFromUsage：配额耗尽 → note 追加；未知名桶保留原名", () => {
  const v = quotaFromUsage({
    buckets: [{ name: "other_pack", remaining: 5 }],
    credits: { remaining: 5, unit: "credits" },
    quotaExceeded: true,
  }, 1);
  assert.equal(v.note, "配额已耗尽");
  assert.equal(v.packages[0].name, "other_pack");
});

test("quotaFromUsage：仅有 usedPercent → display 已用 %；空 usage → available 仍 true", () => {
  const onlyPct = quotaFromUsage({ credits: { usedPercent: 72 } }, 2);
  assert.equal(onlyPct.display, "额度 已用 72%");
  assert.equal(onlyPct.remaining, undefined);
  assert.equal(onlyPct.usedPercent, 72);

  const empty = quotaFromUsage({}, 3);
  assert.equal(empty.available, true);
  assert.equal(empty.display, "额度");
  assert.deepEqual(empty.packages, []);
});

test("quotaFromUsage：数字千分位（小数最多 2 位）", () => {
  const v = quotaFromUsage({ credits: { remaining: 1234.567, unit: "credits" } }, 4);
  assert.equal(v.display, "额度 剩余 1,234.57 credits");
});
