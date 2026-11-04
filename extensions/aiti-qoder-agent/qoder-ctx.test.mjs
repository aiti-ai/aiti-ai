/**
 * aiti-qoder-agent — 上下文用量单测（机会式提取；docs/pi-web-external-agent-context-usage-plan.md）。
 *
 * 钉死：qoderContextWindow 族表 / result 帧 claude 形态 usage → getContextUsage +
 * getUsageTotals 累计 / 无 usage（部分 qodercli 版本恒缺）→ undefined 不编数据。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-qoder-agent/qoder-ctx.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";

const { QoderHandle, qoderContextWindow } = await import("./index.ts");

function makeHandle() {
  const stdout = new PassThrough();
  const child = {
    stdout,
    stderr: { on() {} },
    stdin: { write: () => true, writable: true, on() {} },
    once() {},
    kill() {},
    exitCode: null,
  };
  const h = new QoderHandle("qoder:sess-test", child, null, "/tmp", "cn");
  const write = (frame) => stdout.write(JSON.stringify(frame) + "\n");
  return { h, write };
}

test("qoderContextWindow: claude/gpt 转发名可判，qmodel_* 不猜", () => {
  assert.equal(qoderContextWindow("claude-sonnet-4-5"), 200_000);
  assert.equal(qoderContextWindow("gpt-5"), 272_000);
  assert.equal(qoderContextWindow("qmodel_38max"), undefined);
  assert.equal(qoderContextWindow(undefined), undefined);
});

test("contextUsage 机会式：result.usage → getContextUsage + getUsageTotals 累计", async () => {
  const { h, write } = makeHandle();
  write({ type: "system", subtype: "init", session_id: "sess-test", model: "claude-sonnet-4-5" });
  write({ type: "result", is_error: false,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 500, cache_creation_input_tokens: 10 } });
  const cu = h.getContextUsage();
  assert.ok(cu, "usage 齐全 + 模型可判 → 有数据");
  assert.equal(cu.tokens, 610);
  assert.equal(cu.contextWindow, 200_000);
  const totals = h.getUsageTotals();
  assert.equal(totals.inputTokens, 100);
  assert.equal(totals.turns, 1);
});

test("contextUsage 机会式：无 usage 帧（部分版本恒缺）→ undefined，不编数据", async () => {
  const { h, write } = makeHandle();
  write({ type: "system", subtype: "init", session_id: "sess-test", model: "qmodel_38max" });
  write({ type: "result", is_error: false, total_credits: 3 });
  assert.equal(h.getContextUsage(), undefined, "无 usage → 空轨");
  assert.equal(h.getUsageTotals().turns, 0);
});
