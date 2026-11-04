/**
 * _shared/seed-tool — 索引工具行 → pi 原生工具条目的共享口径单测（D18 归一）。
 *
 * 钉死四家（zcode/opencode/qoder/codebuddy）seedHistory 收敛后的统一行为：
 * coerce 严格形状（自 zcode-core 搬来）、空结果占位 vs 结果缺席不造条目、
 * callID 缺席时合成配对 id 的递增语义、model/provider 的「缺席省略 / 空串保留」。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/_shared/seed-tool.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

const { EMPTY_TOOL_ERROR, EMPTY_TOOL_OUTPUT, createSeedToolReplay, normalizeSeedTool, seedToolResultText } =
  await import("@aiti-ai/ext-shared/seed-tool");

test("normalizeSeedTool：严格形状归一 + 非法回退 null", () => {
  assert.deepEqual(
    normalizeSeedTool({ callID: "call_1", name: "Bash", input: { command: "pwd" }, output: "/home" }),
    { callID: "call_1", name: "Bash", input: { command: "pwd" }, output: "/home" },
  );
  assert.deepEqual(normalizeSeedTool({ name: "Read", input: null, isError: true }), { name: "Read", input: {}, isError: true });
  assert.equal(normalizeSeedTool({ input: {} }), null, "缺 name");
  assert.equal(normalizeSeedTool("text"), null);
  assert.equal(normalizeSeedTool(null), null);
  assert.equal(normalizeSeedTool([{ name: "Bash" }]), null, "数组不是工具行");
  assert.deepEqual(normalizeSeedTool({ name: "B", input: "raw" })?.input, {}, "input 非对象 → 空对象兜底");
  assert.equal(normalizeSeedTool({ name: "B", output: 123 }).output, undefined, "非字符串 output 丢");
});

test("空 output 与缺席 output 语义分开", () => {
  assert.equal(normalizeSeedTool({ name: "B" }).output, undefined);
  assert.equal(seedToolResultText({ name: "B", input: {}, output: "ok" }), "ok");
  assert.equal(seedToolResultText({ name: "B", input: {}, output: "" }), EMPTY_TOOL_OUTPUT);
  assert.equal(seedToolResultText({ name: "B", input: {}, output: "  \n", isError: true }), EMPTY_TOOL_ERROR);
});

test("回放：按 callID 配对出 toolCall + toolResult 两条", () => {
  const replay = createSeedToolReplay("x-tool");
  const out = replay.entries({ callID: "call_1", name: "Bash", input: { command: "ls" }, output: "dist" });
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], {
    role: "assistant",
    content: [{ type: "toolCall", toolCallId: "call_1", toolName: "Bash", input: { command: "ls" } }],
  });
  assert.deepEqual(out[1], {
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "Bash",
    content: [{ type: "text", text: "dist" }],
  });
});

test("回放：isError 透传；空结果仍配对（占位文案）", () => {
  const replay = createSeedToolReplay("x-tool");
  const err = replay.entries({ callID: "c1", name: "Read", output: "boom", isError: true });
  assert.equal(err[1].isError, true);
  const empty = replay.entries({ callID: "c2", name: "Touch", output: "" });
  assert.deepEqual(empty[1].content, [{ type: "text", text: EMPTY_TOOL_OUTPUT }]);
});

test("回放：结果缺席只出调用卡（不凭空造 toolResult）", () => {
  const replay = createSeedToolReplay("x-tool");
  const out = replay.entries({ callID: "c3", name: "Read", input: { path: "/y" } });
  assert.equal(out.length, 1);
  assert.equal(out[0].content[0].toolCallId, "c3");
});

test("回放：callID 缺席按前缀合成，跨行递增；新回放器重新计数", () => {
  const replay = createSeedToolReplay("qoder-tool");
  const a = replay.entries({ name: "Bash", output: "1" });
  const b = replay.entries({ name: "Bash", output: "2" });
  assert.equal(a[0].content[0].toolCallId, "qoder-tool-1");
  assert.equal(b[0].content[0].toolCallId, "qoder-tool-2");
  assert.equal(b[1].toolCallId, "qoder-tool-2", "结果条目与合成 id 配对");
  assert.equal(createSeedToolReplay("zcode-tool").entries({ name: "Bash" })[0].content[0].toolCallId, "zcode-tool-1");
});

test("回放：model/provider 缺席省略、空串保留（各家既有写法）", () => {
  const replay = createSeedToolReplay("x-tool");
  assert.equal("model" in replay.entries({ name: "B" })[0], false);
  assert.equal("provider" in replay.entries({ name: "B" })[0], false);
  const withOpts = replay.entries({ name: "B" }, { model: "glm-4.7", provider: undefined })[0];
  assert.equal(withOpts.model, "glm-4.7");
  assert.equal("provider" in withOpts, false);
  const qoderish = replay.entries({ name: "B" }, { model: "", provider: "aiti-qoder-agent" })[0];
  assert.equal(qoderish.model, "", "qoder 直播同形状：空 model 也照写");
  assert.equal(qoderish.provider, "aiti-qoder-agent");
});

test("回放：非法/非工具行返回 null，交调用方走文本兜底", () => {
  const replay = createSeedToolReplay("x-tool");
  assert.equal(replay.entries(undefined), null);
  assert.equal(replay.entries('🛠 Bash {"command":"ls"}'), null);
  assert.equal(replay.entries({ name: "" }), null);
});
