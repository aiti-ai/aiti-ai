/**
 * asr-usage 单测 —— 语音流量统计的数据层（本地日 / 模式维度 / 旧格式迁移 / 90 天滚动 / 单价 / reset）。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-ai-input/asr-usage.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  localDay, readSeries, readUsage, recordUsage, resetUsage, setUsageDir, setUsagePrice, usageFile,
} from "./asr-usage.ts";

const dir = () => { const d = mkdtempSync(join(tmpdir(), "asr-usage-")); setUsageDir(d); return d; };

test("localDay：按本地日历取日（不是 UTC 日）", () => {
  // 2026-09-13 22:30 UTC = 东八区 2026-09-14 06:30 → 本地日应为 09-14
  const ts = Date.parse("2026-09-13T22:30:00Z");
  const utc = new Date(ts).toISOString().slice(0, 10);
  assert.equal(localDay(ts), "2026-09-14");
  assert.equal(utc, "2026-09-13");
  assert.equal(localDay(Date.now()).length, 10);
});

test("recordUsage：按天 × 引擎 × 模式聚合", () => {
  dir();
  recordUsage({ provider: "xfyun", mode: "quick", seconds: 3.8, ok: true });
  recordUsage({ provider: "xfyun", mode: "final", seconds: 6.8, ok: true });
  recordUsage({ provider: "xfyun", mode: "vad", seconds: 4, ok: false });
  recordUsage({ provider: "baidu", mode: "quick", seconds: 1.5, ok: true });
  const u = readUsage();
  assert.equal(u.today, localDay(Date.now()));
  assert.equal(u.totals.xfyun.requests, 3);
  assert.equal(u.totals.xfyun.errors, 1);
  assert.equal(Number(u.totals.xfyun.seconds.toFixed(1)), 14.6);
  assert.deepEqual(u.totals.xfyun.byMode.quick, { requests: 1, seconds: 3.8 });
  assert.deepEqual(u.totals.xfyun.byMode.vad, { requests: 1, seconds: 4 });
  assert.equal(u.totals.baidu.requests, 1);
  assert.ok(u.lastAt.xfyun > 0);
});

test("readSeries：补齐空天 + 顺序（最近 n 天，升序）", () => {
  dir();
  recordUsage({ provider: "xfyun", mode: "quick", seconds: 2, ok: true });
  const s = readSeries(5);
  assert.equal(s.days.length, 5);
  assert.equal(s.days[s.days.length - 1].day, localDay(Date.now()));
  assert.equal(s.days[0].providers.xfyun, undefined, "更早的天应为空");
  assert.equal(s.totals.xfyun.requests, 1);
});

test("旧格式（UTC 日键 + 无 byMode）迁移：并入本地日且不丢数据", () => {
  const d = dir();
  writeFileSync(join(d, "asr-usage.json"), JSON.stringify({
    days: { "2026-09-13": { xfyun: { requests: 4, seconds: 20, errors: 1 } } },
    price: { xfyun: 0.5 }, lastAt: { xfyun: 1 },
  }), "utf8");
  const u = readUsage();
  const key = localDay(Date.parse("2026-09-13T12:00:00Z"));
  assert.equal(u.totals.xfyun.requests, 4, "旧行必须保留");
  assert.equal(u.totals.xfyun.errors, 1);
  // 迁移后写入的新数据落在本地日，不与旧行冲突
  recordUsage({ provider: "xfyun", mode: "vad", seconds: 1, ok: true });
  const u2 = readUsage();
  assert.equal(u2.todayRows.xfyun.requests >= 1, true);
  assert.equal(u2.price.xfyun, 0.5, "价格必须保留");
  // 落盘应带上 schema 版本
  const raw = JSON.parse(readFileSync(usageFile(), "utf8"));
  assert.equal(raw.v, 2);
  assert.ok(key.length === 10);
});

test("90 天滚动：写入时清理更老的日期", () => {
  const d = dir();
  const old = localDay(Date.now() - 120 * 86400000);
  const recent = localDay(Date.now() - 3 * 86400000);
  writeFileSync(join(d, "asr-usage.json"), JSON.stringify({
    v: 2,
    days: { [old]: { xfyun: { requests: 9, seconds: 9, errors: 0 } }, [recent]: { xfyun: { requests: 2, seconds: 2, errors: 0 } } },
    price: {}, lastAt: {},
  }), "utf8");
  recordUsage({ provider: "xfyun", mode: "quick", seconds: 1, ok: true });
  const raw = JSON.parse(readFileSync(usageFile(), "utf8"));
  assert.equal(raw.days[old], undefined, "超过 90 天的应被清理");
  assert.ok(raw.days[recent], "90 天内的应保留");
});

test("setUsagePrice / resetUsage：价格可设，reset 只清用量保留单价", () => {
  dir();
  recordUsage({ provider: "xfyun", mode: "quick", seconds: 6, ok: true }); // 0.1 分钟
  setUsagePrice({ xfyun: 1.2, baidu: "bad" });
  let u = readUsage();
  assert.equal(u.price.xfyun, 1.2);
  assert.equal(u.price.baidu, undefined, "非法值写不进");
  // 费用 = 分钟 × 单价（UI 侧计算口径）：0.1 × 1.2 = 0.12
  assert.equal(Number(((u.totals.xfyun.seconds / 60) * u.price.xfyun).toFixed(2)), 0.12);
  resetUsage();
  u = readUsage();
  assert.deepEqual(u.totals, {});
  assert.equal(u.price.xfyun, 1.2, "reset 保留单价");
});
