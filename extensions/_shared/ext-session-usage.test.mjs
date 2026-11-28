/**
 * ext-session-usage tests — fixtures pin each external agent session's usage wire assumptions,
 * guarding against silent breakage from upstream format drift (aligned with the cursor-cli-store.test.mjs pattern).
 *
 * Covered (sample shapes measured locally 2026-09, see docs/aiti-ai-usage-ext-agent-token-ingest-plan.md §2.2):
 *   - claude-like (CC): assistant rows' message.usage{input_tokens,...} + message.model
 *   - claude-like (Qoder 0.1.24): usage always 0 with no model/credits → no row produced
 *   - claude-like (QoderCN 1.1.44): model + usage.credits (tokens always 0) → model/credits row produced
 *   - codebuddy: providerData.rawUsage (OpenAI-compatible field names) + providerData.model
 *   - zcode: SQLite message.data JSON's tokens{...}+modelID/providerID (from 3.16.3 the new modelId/providerId keys, both supported) + cost; timeline noise filtered out
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

// ── claude-like family ───────────────────────────────────────────────────

test("claude-like: CC assistant usage full-field extraction (including cache categories)", () => {
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
  assert.equal(rows.length, 2, "both assistant usage rows produce output");
  const [r1, r2] = rows;
  assert.deepEqual(
    [r1.input, r1.output, r1.cacheRead, r1.cacheWrite, r1.totalTokens],
    [44783, 108, 1920, 0, 44891],
    "CC field mapping input/output/cacheRead/cacheWrite/total",
  );
  assert.equal(r1.model, "glm-5.3");
  assert.equal(r1.provider, "zhipu", "glm-* → zhipu");
  assert.equal(r1.ts, Date.parse("2026-09-01T10:00:01Z"));
  assert.equal(r1.agent, "claude");
  assert.equal(r2.provider, "anthropic", "claude-* → anthropic");
});

test("claude-like: Qoder 0.1.24 empty billing (usage always 0, no model/credits) → nothing produced", () => {
  const f = writeSession("qoder-old", "22222222-2222-3333-4444-555555555555.jsonl", [
    { type: "assistant", timestamp: "2026-01-29T03:01:57.282Z",
      message: { role: "assistant",
        usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 0, output_tokens: 0 } } },
  ]);
  const rows = parseClaudeLikeSession("qoder", f, "22222222-2222-3333-4444-555555555555");
  assert.equal(rows.length, 0, "Qoder 0.1.24 empty-billing rows must be filtered");
});

test("claude-like: QoderCN 1.1.44 model + credits extraction (tokens always 0)", () => {
  const f = writeSession("qodercn", "33333333-2222-3333-4444-555555555555.jsonl", [
    { type: "assistant", timestamp: "2026-09-05T12:38:10.000Z",
      message: { role: "assistant", model: "qmodel_38max",
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
                 credits: 11.14515204, original_credits: 11.14515204, billable: true, context_usage_ratio: 0.185 } } },
  ]);
  const rows = parseClaudeLikeSession("qodercn", f, "33333333-2222-3333-4444-555555555555");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, "qmodel_38max");
  assert.equal(rows[0].credits, 11.14515204, "credits = Qoder's own credit unit, a separate field");
  assert.equal(rows[0].input, 0, "Qoder tokens always 0");
  assert.equal(rows[0].provider, "qoder", "qmodel_* → qoder");
});

test("claude-like: rows missing usage skipped; missing timestamp skipped", () => {
  const f = writeSession("cc-edge", "44444444-2222-3333-4444-555555555555.jsonl", [
    { type: "assistant", message: { role: "assistant", model: "glm-4", content: [] } },           // no usage
    { type: "assistant", message: { role: "assistant", model: "glm-4",
      usage: { input_tokens: 5, output_tokens: 5 } } },                                           // no timestamp
  ]);
  const rows = parseClaudeLikeSession("claude", f, "44444444-2222-3333-4444-555555555555");
  assert.equal(rows.length, 0, "both should be skipped");
});

// ── CodeBuddy ────────────────────────────────────────────────────────────

test("codebuddy: providerData.rawUsage extraction (OpenAI-compatible field names + reasoning)", () => {
  const f = writeSession("cbc", "55555555-2222-3333-4444-555555555555.jsonl", [
    { type: "message", timestamp: 1789057352340, role: "assistant",
      providerData: { model: "hy4-preview", requestModelId: "hy4-preview",
        rawUsage: { prompt_tokens: 22869, completion_tokens: 109, total_tokens: 22978,
          cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
          completion_tokens_details: { reasoning_tokens: 76 } } } },
    { type: "reasoning", timestamp: 1789057233974,
      providerData: { model: "hy4-preview" }, content: [] },                       // non-message row skipped
  ]);
  const rows = parseCodebuddySession(f, "55555555-2222-3333-4444-555555555555");
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.input, 22869);
  assert.equal(r.output, 109);
  assert.equal(r.reasoning, 76);
  assert.equal(r.totalTokens, 22978);
  assert.equal(r.model, "hy4-preview");
  assert.equal(r.provider, "codebuddy", "cbc has no explicit provider → agent name");
  assert.equal(r.ts, 1789057352340, "cbc timestamp is a numeric epoch in milliseconds");
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

test("zcode: session-cumulative token diffing (input/cacheRead accumulate per row)", () => {
  const dbPath = join(ROOT, "zcode-test.sqlite");
  const sid = "66666666-2222-3333-4444-555555555555";
  buildZcodeDb(dbPath, [
    // first row: no previous value, input/cacheRead taken as-is
    { sid, seq: 0, data: JSON.stringify({
        role: "assistant", modelID: "GLM-5.3-Flash", providerID: "builtin:bigmodel-coding-plan",
        time: { created: 1788664736131 },
        tokens: { total: 38889, input: 38562, output: 327, reasoning: 0, cache: { read: 16384, write: 0 } },
        cost: 0 }) },
    // second row: input 38562→39374 (+812), cacheR 16384→38528 (+22144), output per-turn as-is
    { sid, seq: 1, data: JSON.stringify({
        role: "assistant", modelID: "GLM-5.3-Flash", providerID: "bigmodel",
        time: { created: 1788664736132 },
        tokens: { total: 39456, input: 39374, output: 82, reasoning: 0, cache: { read: 38528, write: 0 } },
        cost: 0 }) },
    // timeline_event noise (tokens all 0 + cost 0) → filtered out
    { sid, seq: 2, data: JSON.stringify({
        role: "assistant", modelID: "GLM-5.3-Flash", providerID: "bigmodel",
        time: { created: 1788664736133 },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 0, finish: "completed", semantics: { kind: "timeline_event" } }) },
    // user rows skipped
    { sid, seq: 3, data: JSON.stringify({
        role: "user", time: { created: 1788664736000 }, content: "hi" }) },
  ]);
  const rows = parseZcodeSession(dbPath, sid);
  assert.equal(rows.length, 2, "only the 2 real assistant rows produced; timeline noise and user rows filtered out");
  const [r1, r2] = rows;
  assert.equal(r1.input, 38562, "first row's input taken as-is");
  assert.equal(r1.output, 327);
  assert.equal(r1.cacheRead, 16384);
  assert.equal(r1.totalTokens, 38889, "total taken as-is on the first row");
  assert.equal(r2.input, 812, "second row's input = 39374 − 38562 (diffed)");
  assert.equal(r2.cacheRead, 22144, "second row's cacheRead = 38528 − 16384 (diffed)");
  assert.equal(r2.output, 82, "output per-turn taken as-is");
  assert.equal(r2.totalTokens, 39456 - 38889, "total diffed");
  assert.equal(r2.provider, "bigmodel", "builtin:/-coding-plan suffix normalized");
  assert.equal(r2.agent, "zcode");
});

test("zcode: 3.16.3+ new key names modelId/providerId + account: provider normalization", () => {
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
  assert.equal(rows[0].model, "GLM-5.3-Flash", "new key modelId read");
  assert.equal(rows[0].provider, "bigmodel", "account: prefix + -start-plan suffix normalized");
});

// ── provider inference ───────────────────────────────────────────────────

test("inferProvider: prefix inference table", () => {
  assert.equal(inferProvider("claude", "glm-5.3"), "zhipu");
  assert.equal(inferProvider("claude", "claude-sonnet-4-5"), "anthropic");
  assert.equal(inferProvider("qodercn", "qmodel_38max"), "qoder");
  assert.equal(inferProvider("codex", "nvidia/nemotron-3.5"), "nvidia");
  assert.equal(inferProvider("codex", "openai/gpt-5"), "openai");
  assert.equal(inferProvider("codebuddy", "hy4-preview"), "codebuddy");
});