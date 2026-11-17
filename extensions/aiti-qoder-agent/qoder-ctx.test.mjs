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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 状态写盘隔离（session/new 换绑会 rename 模型状态文件）。
const sandbox = mkdtempSync(join(tmpdir(), "qoder-ctx-"));
process.env.EXT_MODEL_STATE_DIR = join(sandbox, "ext-agents");
process.env.PI_MODELS_CONFIG_PATH = join(sandbox, "models.json");

const { QoderHandle, qoderContextWindow } = await import("./index.ts");
const { makeReadyHandle, flush } = await import("./qoder-acp-stub.mjs");

test.after(() => { rmSync(sandbox, { recursive: true, force: true }); });

test("qoderContextWindow: claude/gpt 转发名可判，qmodel_* 不猜", () => {
  assert.equal(qoderContextWindow("claude-sonnet-4-5"), 200_000);
  assert.equal(qoderContextWindow("gpt-5"), 272_000);
  assert.equal(qoderContextWindow("qmodel_38max"), undefined);
  assert.equal(qoderContextWindow(undefined), undefined);
});

test("contextUsage：usage_update 帧（{used,size}）→ getContextUsage 直接可判", async () => {
  const { h, stub } = await makeReadyHandle(QoderHandle);
  stub.notify({ sessionUpdate: "usage_update", used: 610, size: 200_000 });
  await flush();
  const cu = h.getContextUsage();
  assert.ok(cu, "usage_update 帧直接给窗口 → 有数据");
  assert.equal(cu.tokens, 610);
  assert.equal(cu.contextWindow, 200_000);
});

test("contextUsage 兜底：session/prompt 响应 usage → totals 累计；无帧 → undefined 不编数据", async () => {
  const { h, stub } = await makeReadyHandle(QoderHandle);
  // prompt 响应带 usage（桩默认 autoAnswer）：inputTokens=10 累加
  await h.prompt("hi");
  await flush();
  const totals = h.getUsageTotals();
  assert.equal(totals.inputTokens, 10);
  assert.equal(totals.turns, 1);
  assert.equal(h.getContextUsage(), undefined, "无 usage_update 帧且模型窗口不可判 → 空轨");
  await h.dispose();
});
