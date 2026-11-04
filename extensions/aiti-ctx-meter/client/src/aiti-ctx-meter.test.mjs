import assert from "node:assert/strict";
import test from "node:test";
import { barFillHeight, barPercentLabel, formatWindow, barTitleText, shouldShowPercentLabel } from "./aiti-ctx-meter-client.mjs";

test("barFillHeight: clamp 0-100、下限 2px 可见、非数字 0", () => {
  const H = 12.5;
  assert.equal(barFillHeight(0, H), 0);
  assert.equal(barFillHeight(100, H), 12.5); // 满 = innerH（round(12.5)=13 被 clamp 回 12.5）
  assert.equal(barFillHeight(50, H), 6);
  assert.equal(barFillHeight(200, H), 12.5);
  assert.equal(barFillHeight(-5, H), 0);
  assert.equal(barFillHeight(null, H), 0);
  assert.equal(barFillHeight(undefined, H), 0);
  assert.equal(barFillHeight(Number.NaN, H), 0);
  assert.equal(barFillHeight(1, H), 2); // 下限可见（否则空条看不出有数据）
});

test("barPercentLabel: 整数化，无数据 --", () => {
  assert.equal(barPercentLabel(72.4), "72");
  assert.equal(barPercentLabel(0), "0");
  assert.equal(barPercentLabel(null), "--");
  assert.equal(barPercentLabel(undefined), "--");
  assert.equal(barPercentLabel(Number.NaN), "--");
});

test("shouldShowPercentLabel: 小屏只显示比例条本体（数字文案省位），桌面保留整数百分比", () => {
  assert.equal(shouldShowPercentLabel(true), false); // isMobile → 隐藏数字
  assert.equal(shouldShowPercentLabel(false), true);
  assert.equal(shouldShowPercentLabel(undefined), true); // 桌面 compactLead 不透传 isMobile
});

test("formatWindow: K/M 紧凑格式，非法入参空串", () => {
  assert.equal(formatWindow(200000), "200K");
  assert.equal(formatWindow(999), "999");
  assert.equal(formatWindow(1e6), "1M");
  assert.equal(formatWindow(1.5e6), "1.5M");
  assert.equal(formatWindow(2000000), "2M");
  assert.equal(formatWindow(null), "");
  assert.equal(formatWindow(-1), "");
});

test("barTitleText: percent 一位小数 + 窗口 + 压缩三态附加；无数据走兜底文案", () => {
  assert.equal(barTitleText({ percent: 72.4, contextWindow: 200000 }, null, null), "72.4% · 窗口 200K");
  assert.equal(
    barTitleText({ percent: 90.5, contextWindow: 200000 }, { isCompacting: true }, null),
    "90.5% · 窗口 200K · 压缩中…",
  );
  assert.equal(
    barTitleText({ percent: 10, contextWindow: 200000 }, { compactQueued: true }, null),
    "10.0% · 窗口 200K · 压缩已排队",
  );
  assert.equal(barTitleText(null, null, null), "暂无上下文数据（空闲会话或外部后端）");
  // tr 命中（返回非 key 字符串）时用 tr 值
  assert.equal(barTitleText(null, null, () => "No context"), "No context");
});
