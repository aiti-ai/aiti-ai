/**
 * ext-session-usage tests — fixture 钉死各外部 agent 会话的 usage wire 假设，
 * 防上游格式漂移静默破坏（对齐 cursor-cli-store.test.mjs 范式）。
 *
 * 覆盖（本机 2026-09 实测样本形状，见 docs/aiti-ai-usage-ext-agent-token-ingest-plan.md §2.2）：
 *   - claude-like（CC）：assistant 行 message.usage{input_tokens,...} + message.model
 *   - claude-like（Qoder 0.1.24）：usage 恒 0 且无 model/credits → 不产出行
 *   - claude-like（QoderCN 1.1.44）：model + usage.credits（token 恒 0）→ 产出 model/credits 行
 *   - codebuddy：providerData.rawUsage（OpenAI 兼容字段名）+ providerData.model
 *   - zcode：SQLite message.data JSON 的 tokens{...}+modelID/providerID（3.16.3 起新键 modelId/providerId，双键兼容）+cost；timeline 噪音剔除
 *
 * Run: node --experimental-strip-types --test pi-web-ext/_shared/ext-session-usage.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const { parseClaudeLikeSession, parseCodebuddySession, parseZcodeSession, inferProvider } =
  await import("./ext-session-usage.ts");

const ROOT = mkdtempSync(join(tmpdir(), "ext-usage-test-"));

test.after(() => rmSync(ROOT, { recursive: true, force: true }));

function writeSession(sub, name, lines) {
  const dir = join(ROOT, sub);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n"));
  return p;
}

// ── claude-like 家族 ───────────────────────────────────────────────────────

test("claude-like: CC assistant usage 全字段提取（含 cache 分类）", () => {
  const f = writeSession("cc", "11111111-2222-3333-4444-555555555555.jsonl", [
    { type: "session", id: "11111111-2222-3333-4444-555555555555", cwd: "/tmp/x" },
    { type: "user", timestamp: "2026-09-01T10:00:00Z", message: { role: "user", content: "hi" } },
    {
      type: "assistant",
      timestamp: "2026-09-01T10:00:01Z",
      message: {
        role: "assistant", model: "glm-5.3",
        usage: { input_tokens: 44783, cache_creation_input_tokens: 0, cache_read_input_tokens: 1920, output_tokens: 108 },
      },
    },
    {
      type: "assistant",
      timestamp: "2026-09-01T10:00:02Z",
      message: {
        role: "assistant", model: "claude-sonnet-4-5",
        usage: { input_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 20, output_tokens: 30 },
      },
    },
  ]);
  const rows = parseClaudeLikeSession("claude", f, "11111111-2222-3333-4444-555555555555");
  assert.equal(rows.length, 2, "两条 assistant usage 行都产出");
  const [r1, r2] = rows;
  assert.deepEqual(
    [r1.input, r1.output, r1.cacheRead, r1.cacheWrite, r1.totalTokens],
    [44783, 108, 1920, 0, 44891],
    "CC 字段映射 input/output/cacheRead/cacheWrite/total",
  );
  assert.equal(r1.model, "glm-5.3");
  assert.equal(r1.provider, "zhipu", "glm-* → zhipu");
  assert.equal(r1.ts, Date.parse("2026-09-01T10:00:01Z"));
  assert.equal(r1.agent, "claude");
  assert.equal(r2.provider, "anthropic", "claude-* → anthropic");
});

test("claude-like: Qoder 0.1.24 空计费（usage 恒 0 且无 model/credits）→ 不产出", () => {
  const f = writeSession("qoder-old", "22222222-2222-3333-4444-555555555555.jsonl", [
    { type: "assistant", timestamp: "2026-01-29T03:01:57.282Z",
      message: { role: "assistant",
        usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 0, output_tokens: 0 } } },
  ]);
  const rows = parseClaudeLikeSession("qoder", f, "22222222-2222-3333-4444-555555555555");
  assert.equal(rows.length, 0, "Qoder 0.1.24 空计费行必须被过滤");
});

test("claude-like: QoderCN 1.1.44 model + credits 提取（token 恒 0）", () => {
  const f = writeSession("qodercn", "33333333-2222-3333-4444-555555555555.jsonl", [
    { type: "assistant", timestamp: "2026-09-05T12:38:10.000Z",
      message: { role: "assistant", model: "qmodel_38max",
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
                 credits: 11.14515204, original_credits: 11.14515204, billable: true, context_usage_ratio: 0.185 } } },
  ]);
  const rows = parseClaudeLikeSession("qodercn", f, "33333333-2222-3333-4444-555555555555");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, "qmodel_38max");
  assert.equal(rows[0].credits, 11.14515204, "credits = Qoder 自有积分，独立字段");
  assert.equal(rows[0].input, 0, "Qoder token 恒 0");
  assert.equal(rows[0].provider, "qoder", "qmodel_* → qoder");
});

test("claude-like: usage 缺失的行跳过；timestamp 缺失跳过", () => {
  const f = writeSession("cc-edge", "44444444-2222-3333-4444-555555555555.jsonl", [
    { type: "assistant", message: { role: "assistant", model: "glm-4", content: [] } },           // 无 usage
    { type: "assistant", message: { role: "assistant", model: "glm-4",
      usage: { input_tokens: 5, output_tokens: 5 } } },                                           // 无 timestamp
  ]);
  const rows = parseClaudeLikeSession("claude", f, "44444444-2222-3333-4444-555555555555");
  assert.equal(rows.length, 0, "两者都应被跳过");
});

// ── CodeBuddy ──────────────────────────────────────────────────────────────

test("codebuddy: providerData.rawUsage 提取（OpenAI 兼容字段名 + reasoning）", () => {
  const f = writeSession("cbc", "55555555-2222-3333-4444-555555555555.jsonl", [
    { type: "message", timestamp: 1789057352340, role: "assistant",
      providerData: { model: "hy4-preview", requestModelId: "hy4-preview",
        rawUsage: { prompt_tokens: 22869, completion_tokens: 109, total_tokens: 22978,
          cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
          completion_tokens_details: { reasoning_tokens: 76 } } } },
    { type: "reasoning", timestamp: 1789057233974,
      providerData: { model: "hy4-preview" }, content: [] },                       // 非 message 行跳过
  ]);
  const rows = parseCodebuddySession(f, "55555555-2222-3333-4444-555555555555");
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.input, 22869);
  assert.equal(r.output, 109);
  assert.equal(r.reasoning, 76);
  assert.equal(r.totalTokens, 22978);
  assert.equal(r.model, "hy4-preview");
  assert.equal(r.provider, "codebuddy", "cbc 无显式 provider → agent 名");
  assert.equal(r.ts, 1789057352340, "cbc timestamp 是数字 epoch 毫秒");
});

// ── ZCode ─────────────────────────────────────────────────────────────────

function buildZcodeDb(path, messages) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, sequence INTEGER, time_created INTEGER);
  `);
  const ins = db.prepare("INSERT OR REPLACE INTO message (id, session_id, data, sequence) VALUES (?, ?, ?, ?)");
  const seen = new Set();
  for (const m of messages) {
    if (seen.has(m.sid)) continue;
    seen.add(m.sid);
    db.prepare("INSERT OR REPLACE INTO session (id, directory, time_created, time_updated) VALUES (?, '/tmp/x', ?, ?)")
      .run(m.sid, 1_788_000_000_000, 1_788_000_600_000);
  }
  messages.forEach((m, i) => ins.run(`msg-${i}`, m.sid, m.data, m.seq ?? i));
  db.close();
}

test("zcode: tokens 会话累积值差分（input/cacheRead 逐条累积）", () => {
  const dbPath = join(ROOT, "zcode-test.sqlite");
  const sid = "66666666-2222-3333-4444-555555555555";
  buildZcodeDb(dbPath, [
    // 第一条：无前值，input/cacheRead 直取
    { sid, seq: 0, data: JSON.stringify({
        role: "assistant", modelID: "GLM-5.3-Flash", providerID: "builtin:bigmodel-coding-plan",
        time: { created: 1788664736131 },
        tokens: { total: 38889, input: 38562, output: 327, reasoning: 0, cache: { read: 16384, write: 0 } },
        cost: 0 }) },
    // 第二条：input 38562→39374（增 812）、cacheR 16384→38528（增 22144）、output 单轮直取
    { sid, seq: 1, data: JSON.stringify({
        role: "assistant", modelID: "GLM-5.3-Flash", providerID: "bigmodel",
        time: { created: 1788664736132 },
        tokens: { total: 39456, input: 39374, output: 82, reasoning: 0, cache: { read: 38528, write: 0 } },
        cost: 0 }) },
    // timeline_event 噪音（tokens 全 0 + cost 0）→ 剔除
    { sid, seq: 2, data: JSON.stringify({
        role: "assistant", modelID: "GLM-5.3-Flash", providerID: "bigmodel",
        time: { created: 1788664736133 },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 0, finish: "completed", semantics: { kind: "timeline_event" } }) },
    // user 行跳过
    { sid, seq: 3, data: JSON.stringify({
        role: "user", time: { created: 1788664736000 }, content: "hi" }) },
  ]);
  const rows = parseZcodeSession(dbPath, sid);
  assert.equal(rows.length, 2, "只产出 2 条真实 assistant；timeline 噪音与 user 行剔除");
  const [r1, r2] = rows;
  assert.equal(r1.input, 38562, "首条 input 直取");
  assert.equal(r1.output, 327);
  assert.equal(r1.cacheRead, 16384);
  assert.equal(r1.totalTokens, 38889, "total 首条直取");
  assert.equal(r2.input, 812, "第二条 input = 39374 − 38562（差分）");
  assert.equal(r2.cacheRead, 22144, "第二条 cacheRead = 38528 − 16384（差分）");
  assert.equal(r2.output, 82, "output 单轮直取");
  assert.equal(r2.totalTokens, 39456 - 38889, "total 差分");
  assert.equal(r2.provider, "bigmodel", "builtin:/－coding-plan 后缀归一");
  assert.equal(r2.agent, "zcode");
});

test("zcode: 3.16.3+ 新键名 modelId/providerId + account: provider 归一", () => {
  const dbPath = join(ROOT, "zcode-test-v3163.sqlite");
  const sid = "77777777-2222-3333-4444-555555555555";
  buildZcodeDb(dbPath, [
    { sid, seq: 0, data: JSON.stringify({
        role: "assistant", modelId: "GLM-5.3-Flash", providerId: "account:bigmodel-start-plan",
        time: { created: 1788664740000 },
        tokens: { total: 50000, input: 49500, output: 500, reasoning: 0, cache: { read: 30000, write: 0 } },
        cost: 0 }) },
  ]);
  const rows = parseZcodeSession(dbPath, sid);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, "GLM-5.3-Flash", "新键 modelId 读取");
  assert.equal(rows[0].provider, "bigmodel", "account: 前缀 + -start-plan 后缀归一");
});

// ── provider 推断 ─────────────────────────────────────────────────────────

test("inferProvider: 前缀推断表", () => {
  assert.equal(inferProvider("claude", "glm-5.3"), "zhipu");
  assert.equal(inferProvider("claude", "claude-sonnet-4-5"), "anthropic");
  assert.equal(inferProvider("qodercn", "qmodel_38max"), "qoder");
  assert.equal(inferProvider("codex", "nvidia/nemotron-3.5"), "nvidia");
  assert.equal(inferProvider("codex", "openai/gpt-5"), "openai");
  assert.equal(inferProvider("codebuddy", "hy4-preview"), "codebuddy");
});