/**
 * cbc-model-catalog 单测（钉死 cbc 2.150 --help 真实输出样本，2026-09-12 采集）。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-acp-agent/cbc-model-catalog.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

const { parseCbcHelpModels } = await import("../_shared/cbc-model-catalog.ts");

/** 真实 `npx -y @tencent-ai/codebuddy-code --help` 的 --model 行（逐字节截取，勿手改）。 */
const HELP_SAMPLE = `  --model <model>                                  Model for the current session. Please provide the model ID. Currently supported: (hy4-preview, hy3, hy3-x, deepseek-v4.1-flash, glm-5.3, glm-5.3-flash, glm-5.2, glm-5.1, glm-5v-turbo, minimax-m3, minimax-m2.7, kimi-k3-1, kimi-k2.8-preview, kimi-k2.7, kimi-k2.6, deepseek-v4-pro)
  --text-to-image-model <model>                    Model for text-to-image generation`;

test("parseCbcHelpModels：钉死 2.150 全量 16 档", () => {
  const models = parseCbcHelpModels(HELP_SAMPLE);
  assert.deepEqual(models.map((m) => m.id), [
    "hy4-preview", "hy3", "hy3-x", "deepseek-v4.1-flash", "glm-5.3", "glm-5.3-flash",
    "glm-5.2", "glm-5.1", "glm-5v-turbo", "minimax-m3", "minimax-m2.7", "kimi-k3-1",
    "kimi-k2.8-preview", "kimi-k2.7", "kimi-k2.6", "deepseek-v4-pro",
  ]);
});

test("parseCbcHelpModels：格式漂移/截断 → []（调用方回落静态兜底）", () => {
  assert.deepEqual(parseCbcHelpModels("--model <model>  no list here"), []);
  assert.deepEqual(parseCbcHelpModels(""), []);
  assert.deepEqual(parseCbcHelpModels("Currently supported: ()"), []);
  // 空白/脏条目过滤
  assert.deepEqual(parseCbcHelpModels("Currently supported: ( a ,, b-c )"), [{ id: "a" }, { id: "b-c" }]);
});

test("parseCbcHelpModels：旧文案（无括号清单）不误匹配其他行", () => {
  // CBC_MODELS 时代旧 --help 无 Currently supported 段
  assert.deepEqual(parseCbcHelpModels("  --model <model>   Model for the current session"), []);
});
