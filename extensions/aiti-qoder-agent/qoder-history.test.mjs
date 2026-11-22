/**
 * aiti-qoder-agent — 冷恢复历史回放（seedHistory：IndexedMessage[] → liveHistory pi 形状）。
 *
 * 钉死行为（2026-09-21 回归：接管既有会话时工具调用退化为 🛠 {json} 纯文本行，
 * 丢了宿主原生工具卡片）：
 *   1. 结构化工具行（claude-like adapter 的 tool）→ assistant toolCall + toolResult
 *      两条，按 callID 配对；isError 透传；
 *   2. callID 缺席 → 合成稳定 id，结果仍与调用配对；
 *   3. 无 tool 的行（正文/老索引/混排）→ 原样文本，user 行保持字符串 content。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-qoder-agent/qoder-history.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

// 状态写盘隔离（seedHistory 本身不写盘，构造 handle 走的初始化会）：不隔离就刷真实
// ~/.pi/agent/ext-agents 的 last-used 模型。
const sandbox = mkdtempSync(join(tmpdir(), "qoder-history-"));
process.env.EXT_MODEL_STATE_DIR = join(sandbox, "ext-agents");
process.env.PI_MODELS_CONFIG_PATH = join(sandbox, "models.json");

const { QoderHandle } = await import("./index.ts");

test.after(() => { rmSync(sandbox, { recursive: true, force: true }); });

function makeHandle() {
  const child = {
    stdout: new PassThrough(),
    stderr: { on() {} },
    once() {},
    stdin: { write: () => true, writable: true, on() {} },
    kill() {},
    exitCode: null,
  };
  return new QoderHandle("qodercn:new-history", child, null, "/tmp", "cn");
}

const rows = (seed) => {
  const h = makeHandle();
  h.seedHistory(seed);
  return h.getMessages();
};

test("结构化工具行回放成原生 toolCall + toolResult（按 callID 配对）", () => {
  const out = rows([
    { role: "user", text: "pi 有 hook 吗" },
    {
      role: "assistant",
      text: '🛠 Bash {"command":"ls"}',
      toolName: "Bash",
      tool: { callID: "call_1", name: "Bash", input: { command: "ls" }, output: "CHANGELOG.md\ndist" },
    },
  ]);
  assert.equal(out.length, 3, "user + 调用 + 结果");
  assert.deepEqual(out[1], {
    role: "assistant",
    content: [{ type: "toolCall", toolCallId: "call_1", toolName: "Bash", input: { command: "ls" } }],
    model: "",
    provider: "aiti-qoder-agent",
  }, "宿主 normalizeHandleMessages 认的原生形状（🛠 文本行不再露出）");
  assert.equal(out[2].role, "toolResult");
  assert.equal(out[2].toolCallId, "call_1");
  assert.deepEqual(out[2].content, [{ type: "text", text: "CHANGELOG.md\ndist" }]);
  assert.equal(out[2].isError, undefined);
});

test("isError 与结果缺席：错误标记透传，无结果只出调用卡", () => {
  const out = rows([
    { role: "assistant", text: "🛠 Read /x", tool: { callID: "c1", name: "Read", input: { path: "/x" }, output: "boom", isError: true } },
    { role: "assistant", text: "🛠 Read /y", tool: { callID: "c2", name: "Read", input: { path: "/y" } } },
  ]);
  assert.equal(out[1].isError, true);
  assert.equal(out.length, 3, "c2 无结果 → 不凭空造 toolResult");
  assert.equal(out[2].content[0].toolCallId, "c2");
});

test("callID 缺席时合成 id，调用与结果仍配对", () => {
  const out = rows([
    { role: "assistant", text: "🛠 Bash ls", tool: { name: "Bash", input: { command: "ls" }, output: "ok" } },
    { role: "assistant", text: "🛠 Bash pwd", tool: { name: "Bash", input: { command: "pwd" }, output: "/tmp" } },
  ]);
  const ids = [out[0], out[2]].map((m) => m.content[0].toolCallId);
  assert.deepEqual(ids, ["qoder-tool-1", "qoder-tool-2"]);
  assert.equal(out[1].toolCallId, ids[0]);
  assert.equal(out[3].toolCallId, ids[1]);
});

test("无结构化信息仍走 🛠 文本兜底；user 行保持字符串 content", () => {
  const out = rows([
    { role: "user", text: "继续" },
    { role: "assistant", text: "🛠 Bash {\"command\":\"ls\"}" },
    { role: "assistant", text: "   " },
    { role: "assistant", text: "正文", tool: { name: "" } },
    { role: "assistant", text: "混排", model: "Qwen3.8-Flash", provider: "qoder" },
  ]);
  assert.deepEqual(out.map((m) => m.role), ["user", "assistant", "assistant", "assistant"]);
  assert.equal(out[0].content, "继续");
  assert.equal(out[1].content[0].type, "text", "结构化缺席 → 保留兜底文本行（交棒上下文不丢内容）");
  assert.equal(out[1].provider, "aiti-qoder-agent", "provider 缺省补扩展名（消息徽标依赖）");
  assert.equal(out[2].content[0].text, "正文", "tool 无名视为无效结构化 → 退回文本");
  assert.equal(out[3].content[0].text, "混排");
  assert.deepEqual({ model: out[3].model, provider: out[3].provider }, { model: "Qwen3.8-Flash", provider: "qoder" });
});
