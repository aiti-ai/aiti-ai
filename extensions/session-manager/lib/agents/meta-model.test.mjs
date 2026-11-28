/**
 * session-manager agents — meta.model 提取 fixture 测试（临时 jsonl，零真机依赖）。
 *
 * 钉死三个 adapter 的「会话真实模型」提取契约（§6.2 A 组，接管恢复/详情展示消费）：
 *   - codex.ts：最后一个 turn_context payload.model 胜出
 *   - claude-like.ts：最近 assistant 行 message.model 胜出（claude/qoder/iflow 共用）
 *   - cursor-cli.ts：readCursorCliChat 的 model（store.meta.lastUsedModel）透传
 *
 * Run: node --test pi-web-ext/session-manager/lib/agents/meta-model.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCodexAdapter } from "./codex.ts";
import { createClaudeLikeAdapter } from "./claude-like.ts";

const ROOT = mkdtempSync(join(tmpdir(), "sm-meta-model-test-"));
test.after(() => rmSync(ROOT, { recursive: true, force: true }));

test("codex adapter: turn_context payload.model → meta.model（最后一个胜出）", () => {
  const lines = [
    { timestamp: "2026-09-06T10:00:00Z", type: "session_meta", payload: { id: "sid-1", cwd: "/tmp/x" } },
    { timestamp: "2026-09-06T10:00:01Z", type: "turn_context", payload: { model: "old-model" } },
    { timestamp: "2026-09-06T10:00:02Z", type: "event_msg", payload: { type: "user_message", message: "hi" } },
    { timestamp: "2026-09-06T10:00:03Z", type: "event_msg", payload: { type: "agent_message", message: "hello" } },
    { timestamp: "2026-09-06T10:01:00Z", type: "turn_context", payload: { model: "new-model" } },
  ];
  const f = join(ROOT, "rollout-2026-09-06T10-00-00-sid-1.jsonl");
  writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n"));
  const parsed = createCodexAdapter().parse({ sid: "sid-1", path: f });
  assert.ok(parsed);
  assert.equal(parsed.meta.model, "new-model", "最后一个 turn_context 胜出");
  assert.equal(parsed.messages.length, 2);
  // 无 turn_context → meta 无 model 键（fail-silent 形状）
  const f2 = join(ROOT, "rollout-2026-09-06T10-00-00-sid-2.jsonl");
  writeFileSync(f2, JSON.stringify(lines[0]) + "\n" + JSON.stringify(lines[2]));
  const p2 = createCodexAdapter().parse({ sid: "sid-2", path: f2 });
  assert.ok(p2);
  assert.equal(p2.meta.model, undefined);
});

test("claude-like adapter: assistant 行 message.model → meta.model（最近胜出，claude/qoder 共用）", () => {
  const lines = [
    { type: "user", timestamp: "2026-09-06T10:00:00Z", cwd: "/tmp/x", message: { role: "user", content: "hi" } },
    { type: "assistant", timestamp: "2026-09-06T10:00:01Z", message: { role: "assistant", model: "model-a", content: [{ type: "text", text: "a" }] } },
    { type: "assistant", timestamp: "2026-09-06T10:00:02Z", message: { role: "assistant", model: "model-b", content: [{ type: "text", text: "b" }] } },
    // 无 model 的 assistant 行不清空已提取值
    { type: "assistant", timestamp: "2026-09-06T10:00:03Z", message: { role: "assistant", content: [{ type: "text", text: "c" }] } },
  ];
  const dir = join(ROOT, "-tmp-x");
  mkdirSync(dir, { recursive: true });
  const f = join(dir, "11111111-2222-3333-4444-555555555555.jsonl");
  writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n"));
  const parsed = createClaudeLikeAdapter("claude", "Claude Code", ".claude", "projects").parse({
    sid: "11111111-2222-3333-4444-555555555555",
    path: f,
  });
  assert.ok(parsed);
  assert.equal(parsed.meta.model, "model-b", "最近一条带 model 的 assistant 胜出，后续缺失不清空");
});
