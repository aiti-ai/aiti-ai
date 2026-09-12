import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./context-urgency.ts");
}

test("四档阈值边界（69/70/90/97 附近）", async () => {
  const { contextUrgency } = await loadSubject();

  assert.equal(contextUrgency(0).level, "calm");
  assert.equal(contextUrgency(69.9).level, "calm");
  assert.equal(contextUrgency(70).level, "calm"); // 阈值是 >70，不含 70
  assert.equal(contextUrgency(70.1).level, "warn");
  assert.equal(contextUrgency(90).level, "warn");
  assert.equal(contextUrgency(90.1).level, "urgent");
  assert.equal(contextUrgency(97).level, "urgent");
  assert.equal(contextUrgency(97.1).level, "critical");
  assert.equal(contextUrgency(100).level, "critical");
});

test("null / undefined / 非法值按 calm 灰兜底", async () => {
  const { contextUrgency } = await loadSubject();

  for (const v of [null, undefined, NaN]) {
    const u = contextUrgency(v);
    assert.equal(u.level, "calm");
    assert.equal(u.color, "var(--text-muted)");
  }
});

test("色值与方案定稿一致（顶栏现状为基准 + critical 深红）", async () => {
  const { contextUrgency } = await loadSubject();

  assert.equal(contextUrgency(50).color, "var(--text-muted)");
  assert.equal(contextUrgency(80).color, "rgba(234,179,8,0.95)");
  assert.equal(contextUrgency(95).color, "#ef4444");
  assert.equal(contextUrgency(99).color, "#dc2626");
  // 按钮淡底/描边三态齐备
  for (const p of [50, 80, 95, 99]) {
    const u = contextUrgency(p);
    assert.ok(typeof u.bg === "string" && u.bg.length > 0 || u.bg === "none");
    assert.ok(typeof u.border === "string" && u.border.length > 0);
  }
});

test("呼吸动画名导出稳定", async () => {
  const { CTX_BREATHE_ANIMATION, CTX_BREATHE_CSS } = await loadSubject();
  assert.equal(CTX_BREATHE_ANIMATION, "ctx-urgency-breathe");
  assert.ok(CTX_BREATHE_CSS.startsWith("ctx-urgency-breathe "));
  assert.ok(CTX_BREATHE_CSS.includes("infinite alternate"));
});
