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
// Sandbox must set HOME + USERPROFILE: Windows os.homedir() reads USERPROFILE only.
// With HOME alone every ~/.omp/.grok/.vibe/.hermes/.augment/.kiro fixture would leak
// into the real home dir (lessons §2 incident pattern; adapters call homedir() lazily).
process.env.HOME = ROOT;
process.env.USERPROFILE = ROOT;
delete process.env.KIRO_HOME;
const { createOmpAdapter, createKiroAdapter, createAuggieAdapter, createVibeAdapter, createGrokAdapter, createHermesAdapter } = await import("./acp-agents.ts");
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

/* ── grok（真机 2026-11-09 登录会话形状）── */
test("grok: <enc-cwd>/<uuid>/summary.json + updates.jsonl ACP 帧（thought 不进文本）", () => {
	const sid = "01a1c031-57a9-7682-806f-0746d8f3c23f";
	const dir = join(homedir(), ".grok", "sessions", "%2Ftmp%2Fproj", sid);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "summary.json"), JSON.stringify({
		info: { id: sid, cwd: "/tmp/proj" },
		session_summary: "",
		created_at: "2026-11-09T12:03:41.616592Z",
		updated_at: "2026-11-09T12:03:45.516723Z",
		num_messages: 3,
		current_model_id: "grok-4.7",
	}));
	writeFileSync(join(dir, "updates.jsonl"), [
		JSON.stringify({ timestamp: 1794225822, method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Reply with exactly one word: PONG" } } } }),
		JSON.stringify({ timestamp: 1794225825, method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "should not count" } } } }),
		JSON.stringify({ timestamp: 1794225825, method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "PONG" } } } }),
	].join("\n") + "\n");
	const a = createGrokAdapter();
	const ref = a.list().find((r) => r.sid === sid);
	assert.ok(ref, "session listed");
	const p = a.parse(ref);
	assert.ok(p);
	assert.equal(p.meta.cwd, "/tmp/proj", "cwd 来自 summary.info（真实路径非编码目录名）");
	assert.equal(p.meta.messageCount, 2, "thought 块不计入");
	assert.equal(p.messages[1].text, "PONG");
});

/* ── hermes（state.db SQLite，真机 2026-11-09 PONG 会话形状）── */
test("hermes: ~/.hermes/state.db sessions+messages 双表（只读打开，空会话跳过）", async () => {
	const { DatabaseSync } = await import("node:sqlite");
	const dbPath = join(ROOT, ".hermes", "state.db");
	mkdirSync(join(ROOT, ".hermes"), { recursive: true });
	const db = new DatabaseSync(dbPath);
	db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, display_name TEXT, model TEXT, started_at REAL, last_activity_at REAL, message_count INTEGER);
CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, active INTEGER DEFAULT 1);`);
	db.prepare("INSERT INTO sessions (id, cwd, title, started_at, last_activity_at, message_count) VALUES (?, ?, ?, ?, ?, ?)").run("local-abc123", "/tmp/proj", "pong title", 1794225594.3, 1794225846.9, 2);
	db.prepare("INSERT INTO sessions (id, cwd, started_at, message_count) VALUES (?, ?, ?, ?)").run("local-empty", "/tmp/proj", 1794225590.0, 0);
	const ins = db.prepare("INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)");
	ins.run("m1", "local-abc123", "user", "Reply with exactly one word: PONG", 1794225835.7);
	ins.run("m2", "local-abc123", "assistant", "PONG", 1794225846.9);
	ins.run("m3", "local-abc123", "system", "system prompt row — not session text", 1794225594.4);
	db.close();
	const a = createHermesAdapter();
	const refs = a.list();
	assert.equal(refs.length, 2, "两个会话都列出（空会话也在）");
	const ref = refs.find((r) => r.sid === "local-abc123");
	assert.ok(ref, "PONG 会话 listed");
	assert.ok(ref.rev > 0, "rev = last_activity_at ms");
	const p = a.parse(ref);
	assert.ok(p);
	assert.equal(p.meta.cwd, "/tmp/proj");
	assert.equal(p.meta.name, "pong title");
	assert.equal(p.meta.messageCount, 2, "system 行不计入");
	assert.equal(p.messages[0].text, "Reply with exactly one word: PONG");
	assert.equal(p.messages[1].role, "assistant");
	const empty = a.parse(refs.find((r) => r.sid === "local-empty"));
	assert.equal(empty, null, "空会话 parse → null");
	const probe = a.probe();
	assert.ok(probe.ok && probe.count === 2 && probe.watermarkMs > 0);
});


/* ── junie（JetBrains：index.jsonl 索引 + transcript.md markdown 轮次）── */
test("junie: index.jsonl 元数据 + transcript.md 轮次（Error 节跳过）", async () => {
	const { createJunieAdapter } = await import("./acp-agents.ts");
	const sessDir = join(ROOT, ".junie", "sessions", "session-test-1");
	mkdirSync(sessDir, { recursive: true });
	writeFileSync(join(ROOT, ".junie", "sessions", "index.jsonl"),
		JSON.stringify({ sessionId: "session-test-1", createdAt: 1794327755528, updatedAt: 1794327855528, projectDir: "/tmp/jproj" }) + "\n" +
		JSON.stringify({ sessionId: "session-empty", createdAt: 1794327755000 }) + "\n");
	writeFileSync(join(sessDir, "transcript.md"), [
		"# Session transcript",
		"",
		"## User",
		"",
		"fix the bug in login",
		"",
		"## Junie",
		"",
		"Fixed. The null check was missing.",
		"",
		"## Error",
		"",
		"task stopped due to an error",
		"",
	].join("\n") + "\n");
	const a = createJunieAdapter();
	const ref = a.list().find((r) => r.sid === "session-test-1");
	assert.ok(ref, "session listed");
	assert.ok(ref.rev === 1794327855528, "rev = updatedAt");
	const p = a.parse(ref);
	assert.ok(p);
	assert.equal(p.meta.cwd, "/tmp/jproj", "cwd 从 index projectDir");
	assert.equal(p.meta.messageCount, 2, "Error 节不进文本面");
	assert.equal(p.messages[0].role, "user");
	assert.equal(p.messages[0].text, "fix the bug in login");
	assert.equal(p.messages[1].role, "assistant");
	assert.equal(p.messages[1].text, "Fixed. The null check was missing.");
	// 空 index 行（无 transcript 的目录）→ parse null
	const emptyRef = a.list().find((r) => r.sid === "session-empty");
	const pe = a.parse(emptyRef);
	assert.equal(pe, null, "无 transcript 的会话 → null");
	const probe = a.probe();
	assert.ok(probe.ok && probe.count === 2 && probe.watermarkMs === 1794327855528);
});
