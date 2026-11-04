/**
 * aiti-opencode-agent — 上下文用量单测（docs/pi-web-external-agent-context-usage-plan.md）。
 *
 * 钉死：guessOcContextWindow 族表 / 桩 CLI 全事件流 → getContextUsage（input+cache 三项）
 * + getUsageTotals 逐轮累计 / 模型未捕获 → undefined（不编数字）。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-opencode-agent/opencode-ctx.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { guessOcContextWindow, default: mod } = await import("./index.ts");

/**
 * 桩 CLI 落 tmpdir 真实路径：产品以 `node <脚本>` 直跑（脚本形态免 shebang 依赖），
 * 三平台同构。旧写法把桩放 `/tmp/oc-ctx-test/`——48 上靠作者机残留文件跑绿（重启即失），
 * Windows 上 node 把 `/tmp` 解析成盘符相对路径必不命中 → CLI 判定未安装 → provider 不注册。
 */
const WORK = mkdtempSync(join(tmpdir(), "oc-ctx-test-"));
const STUB = join(WORK, "oc-stub.mjs");
writeFileSync(STUB, [
  'const ev = (type, part) => process.stdout.write(JSON.stringify({ type, sessionID: "oc-stub-sess", part }) + "\\n");',
  'ev("step_start", { id: "s1" });',
  'ev("text", { id: "p1", modelID: "claude-sonnet-4-5", text: "桩回答：上下文用量一轮" });',
  'ev("step_finish", { id: "s1", tokens: { input: 1000, output: 200, reasoning: 40, cache: { read: 5000, write: 300 } } });',
].join("\n"));
test.after(() => rmSync(WORK, { recursive: true, force: true }));

test("guessOcContextWindow: 已知族命中 / 未知与空值 undefined", () => {
  assert.equal(guessOcContextWindow("gpt-5.1"), 272_000);
  assert.equal(guessOcContextWindow("gpt-4o"), 128_000);
  assert.equal(guessOcContextWindow("claude-sonnet-4-5"), 200_000);
  assert.equal(guessOcContextWindow("claude-sonnet-4-5[1m]"), 1_000_000);
  assert.equal(guessOcContextWindow("gemini-2.5-pro"), 1_000_000);
  assert.equal(guessOcContextWindow("kimi-k2"), 256_000);
  assert.equal(guessOcContextWindow("some-local-llama"), undefined, "未命中不猜");
  assert.equal(guessOcContextWindow(undefined), undefined);
  assert.equal(guessOcContextWindow(""), undefined);
});

test("handle: 桩 CLI 轮次 → getContextUsage（input+cache.read+cache.write）+ getUsageTotals", async () => {
  process.env.OPENCODE_CLI_PATH = STUB;
  // startup 内 register 是同步派发：直接收捕获到的 provider，不套 Promise
  // （CLI 未解析到时 startup 早退，Promise 永不 settle → 整轮套件挂死）
  let provider = null;
  mod.server.startup({
    sessionProviders: { register: (p) => { provider = p; return "opencode"; } },
    services: { get: () => null },
  });
  assert.ok(provider, "CLI 可解析即注册 provider（null = 桩路径没被 resolveOcBin 命中）");

  const handle = await provider.createSession({ cwd: WORK });
  assert.equal(handle.getContextUsage(), undefined, "首轮未完成 → undefined");

  await handle.prompt("ctx 一轮");
  const cu = handle.getContextUsage();
  assert.ok(cu, "step_finish 后有数据");
  assert.equal(cu.tokens, 6300, "input 1000 + cache.read 5000 + cache.write 300（reasoning 不计）");
  assert.equal(cu.contextWindow, 200_000, "modelID=claude-sonnet-4-5 → 200K");
  assert.ok(cu.percent > 0 && cu.percent <= 100);

  const totals = handle.getUsageTotals();
  assert.equal(totals.inputTokens, 1000);
  assert.equal(totals.outputTokens, 200);
  assert.equal(totals.cacheReadTokens, 5000);
  assert.equal(totals.cacheWriteTokens, 300);
  assert.equal(totals.turns, 1);
  await handle.dispose();
});
