/**
 * session-manager — ACP-family adapter tests（omp 实测 wire + kiro/auggie/vibe/qwen
 * 证据链形状；HOME 隔离到临时目录）。
 *
 * omp = 真机 18.x 落盘帧（title/session/message pi-wire，cwd-enc 目录）；
 * kiro = Q-CLI 形状（sessions/<sid>/conversation_log.jsonl + session.json）；
 * auggie = turns[].chunks[] + chatHistory[] 双形状；
 * vibe = JSONL role/content 行 + 单 JSON messages[] 文档双形状；
 * qwen = gemini 同构（~/.qwen/tmp/<hash>/chats/session-*.json）。
 *
 * Run: node --test pi-web-ext/session-manager/lib/agents/acp-agents.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

const ROOT = mkdtempSync(join(tmpdir(), "acp-agents-test-"));
process.env.HOME = ROOT;
delete process.env.KIRO_HOME;
const { createOmpAdapter, createKiroAdapter, createAuggieAdapter, createVibeAdapter } = await import("./acp-agents.ts");
const { createGeminiAdapter } = await import("./gemini.ts");

test.after(() => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ } });

/* ── omp ── */
test("omp: cwd-enc 目录 + pi-wire 帧（title/session/message），sid 取文件名 uuid", () => {
	const dir = join(homedir(), ".omp", "agent", "sessions", "-tmp-proj");
	mkdirSync(dir, { recursive: true });
	const sid = "01a0b6ca-b45a-768b-9317-69c641cedf0d";
	writeFileSync(join(dir, `2026-09-18T23-12-12-890Z_${sid}.jsonl`), [
		JSON.stringify({ type: "title", v: 1, title: "smoke", updatedAt: "2026-09-18T23:12:12.890Z" }),
		JSON.stringify({ type: "session", version: 3, id: sid, timestamp: "2026-09-18T23:12:12.890Z", cwd: "/tmp/proj" }),
		JSON.stringify({ type: "model_change", model: "deepseek-v4-pro" }),
		JSON.stringify({ type: "message", id: "216fa240", parentId: "4aea0a44", timestamp: "2026-09-18T23:12:16.555Z", message: { role: "user", content: [{ type: "text", text: "只回复两个字：正常" }], attribution: "user" } }),
		JSON.stringify({ type: "message", id: "b1df0a21", parentId: "216fa240", timestamp: "2026-09-18T23:12:20.080Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "..." }, { type: "text", text: "正常" }], provider: "ds", model: "deepseek-v4-pro", stopReason: "stop" } }),
	].join("\n") + "\n");
	const a = createOmpAdapter();
	const ref = a.list().find((r) => r.sid === sid);
	assert.ok(ref, "session listed");
	const p = a.parse(ref);
	assert.ok(p);
	assert.equal(p.meta.cwd, "/tmp/proj");
	assert.equal(p.meta.name, "smoke");
	assert.equal(p.meta.messageCount, 2);
	assert.equal(p.messages[0].text, "只回复两个字：正常");
	assert.equal(p.messages[1].role, "assistant");
	assert.equal(p.messages[1].text, "正常", "thinking 块不进文本");
});

/* ── kiro ── */
test("kiro: sessions/<sid>/conversation_log.jsonl + session.json 元数据（Q-CLI 形状）", () => {
	const sid = "3f2a1b4c-0000-4111-8222-9abcd9f19a5a";
	const dir = join(homedir(), ".kiro", "sessions", sid);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "conversation_log.jsonl"), [
		JSON.stringify({ type: "user", content: [{ type: "text", text: "List the files" }] }),
		JSON.stringify({ type: "assistant", content: [{ type: "text", text: "There are 3 files." }], timestamp: "2026-11-08T10:00:00Z" }),
		// toolUse/reasoning 形状不得计入
		JSON.stringify({ type: "toolUse", name: "fsList", content: [] }),
	].join("\n") + "\n");
	writeFileSync(join(dir, "session.json"), JSON.stringify({ conversation_id: sid, createdAt: "2026-11-08T09:59:00Z", title: "list files" }));
	const a = createKiroAdapter();
	const ref = a.list().find((r) => r.sid === sid);
	assert.ok(ref, "session listed");
	const p = a.parse(ref);
	assert.ok(p);
	assert.equal(p.meta.messageCount, 2);
	assert.equal(p.meta.name, "list files");
	assert.equal(p.meta.created, "2026-11-08T09:59:00Z");
	assert.equal(p.messages[1].role, "assistant");
});

/* ── auggie ── */
test("auggie: turns[].chunks[] 主形状 + chatHistory[] 兜底", () => {
	const root = join(homedir(), ".augment", "sessions");
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "11111111-2222-4333-8444-555555555555.json"), JSON.stringify({
		sessionId: "11111111-2222-4333-8444-555555555555",
		workspaceId: "w1",
		createdAt: "2026-11-08T08:00:00Z",
		turns: [
			{ role: "user", chunks: [{ type: "user_message", text: "Fix the typo" }] },
			{ role: "assistant", chunks: [{ type: "assistant_message", text: "Fixed." }, { type: "tool_call", text: "should-not-count" }] },
		],
	}));
	writeFileSync(join(root, "99999999-8888-4777-8666-555555555555.json"), JSON.stringify({
		chatHistory: [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi" },
		],
	}));
	const a = createAuggieAdapter();
	assert.equal(a.list().length, 2, "两个会话都列出");
	const p = a.parse(a.list().find((r) => r.sid.startsWith("11111111")));
	assert.ok(p);
	assert.equal(p.meta.messageCount, 2, "tool_call 块不计入");
	assert.equal(p.messages[0].text, "Fix the typo");
	const p2 = a.parse(a.list().find((r) => r.sid.startsWith("99999999")));
	assert.ok(p2);
	assert.equal(p2.meta.messageCount, 2, "chatHistory 兜底形状");
});

/* ── vibe ── */
test("vibe: JSONL role/content 行 + 单 JSON messages[] 文档双形状", () => {
	const root = join(homedir(), ".vibe", "logs", "session");
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "conv-a.jsonl"), [
		JSON.stringify({ role: "user", content: "Write a haiku" }),
		JSON.stringify({ role: "assistant", content: "Quiet terminal glows" }),
	].join("\n") + "\n");
	writeFileSync(join(root, "conv-b.json"), JSON.stringify({
		messages: [
			{ role: "user", content: "second shape" },
			{ role: "assistant", content: "received" },
		],
	}));
	const a = createVibeAdapter();
	assert.equal(a.list().length, 2);
	const p = a.parse(a.list().find((r) => r.sid === "conv-a"));
	assert.ok(p);
	assert.equal(p.meta.messageCount, 2);
	assert.equal(p.messages[1].role, "assistant");
	const p2 = a.parse(a.list().find((r) => r.sid === "conv-b"));
	assert.ok(p2, "单 JSON 文档形状");
	assert.equal(p2.meta.messageCount, 2);
});

/* ── qwen（gemini 同构） ── */
test("qwen: ~/.qwen/tmp/<hash>/chats/session-*.json（gemini 形状复用）", () => {
	const chats = join(homedir(), ".qwen", "tmp", "abc123", "chats");
	mkdirSync(chats, { recursive: true });
	writeFileSync(join(chats, "session-qq1.json"), JSON.stringify({
		sessionId: "qq1",
		startTime: "2026-11-08T07:00:00Z",
		lastUpdated: "2026-11-08T07:01:00Z",
		messages: [
			{ type: "user", content: "explain qwen store" },
			{ type: "gemini", content: "Same as gemini tmp layout" },
		],
	}));
	const a = createGeminiAdapter(".qwen", "qwen", "Qwen Code");
	const ref = a.list().find((r) => r.sid === "qq1");
	assert.ok(ref, "session listed");
	assert.equal(a.id, "qwen");
	const p = a.parse(ref);
	assert.ok(p);
	assert.equal(p.meta.messageCount, 2);
	assert.equal(p.messages[1].role, "assistant");
});
