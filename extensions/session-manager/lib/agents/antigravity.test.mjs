/**
 * session-manager — Antigravity adapter tests（desktop brain 面 + CLI/agy 面 wire-walk）。
 * HOME 隔离到临时目录；CLI fixture 用手搓 protobuf wire 编码器模拟无 schema steps。
 *
 * Run: node --test pi-web-ext/session-manager/lib/agents/antigravity.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

const ROOT = mkdtempSync(join(tmpdir(), "antigravity-adapter-test-"));
// Sandbox must set HOME + USERPROFILE: Windows os.homedir() reads USERPROFILE only —
// with HOME alone the ~/.gemini fixtures would leak into the real home dir
// (lessons §2 incident pattern; the adapter resolves roots via homedir() lazily).
process.env.HOME = ROOT;
process.env.USERPROFILE = ROOT;
const { createAntigravityAdapter } = await import("./antigravity.ts");

test.after(() => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ } });

/** 手搓 protobuf wire 编码器（field 1, wt 2 嵌套）——模拟 agy steps.step_payload。 */
function pbEncode(...parts) {
	return Buffer.concat(parts.map((t) => {
		let buf = Buffer.from(t, "utf8");
		for (let depth = 0; depth < 4; depth++) {
			buf = Buffer.concat([Buffer.from([0x0a]), Buffer.from([buf.length & 0x7f]), buf]);
		}
		return buf;
	}));
}

test("agy CLI 面: summaries 索引 + conversations/<sid>.db wire-walk（step_type 14/15）", async () => {
	const { DatabaseSync } = await import("node:sqlite");
	const cliDir = join(ROOT, ".gemini", "antigravity-cli");
	mkdirSync(join(cliDir, "conversations"), { recursive: true });
	const sdb = new DatabaseSync(join(cliDir, "conversation_summaries.db"));
	sdb.exec(`CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, preview TEXT, step_count INTEGER, last_modified_time TEXT, workspace_uris TEXT, status TEXT, source TEXT);`);
	sdb.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
		"agy-session-1", "pong roundtrip", "", 2,
		"2026-11-10 16:44:17.6358045+00:00",
		'["file:///tmp/proj"]', "CASCADE_RUN_STATUS_IDLE", "antigravity");
	sdb.close();
	const cdb = new DatabaseSync(join(cliDir, "conversations", "agy-session-1.db"));
	cdb.exec(`CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB);
CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT, trajectory_type INTEGER, source INTEGER);`);
	cdb.prepare("INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)").run(0, 14, pbEncode("Reply with exactly one word: PONG", "read_file(/tmp/proj)"));
	cdb.prepare("INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)").run(1, 15, pbEncode("PONG"));
	cdb.close();
	const a = createAntigravityAdapter();
	const ref = a.list().find((r) => r.sid === "agy-session-1");
	assert.ok(ref, "session listed（CLI 面并入总 list）");
	assert.ok(ref.path.includes("#"), "CLI ref 带 db#sid 标记");
	const p = a.parse(ref);
	assert.ok(p);
	assert.equal(p.meta.cwd, "/tmp/proj", "cwd 从 workspace_uris 解析");
	assert.equal(p.meta.name, "pong roundtrip");
	assert.equal(p.meta.messageCount, 2);
	assert.equal(p.messages[0].role, "user");
	assert.equal(p.messages[0].text, "Reply with exactly one word: PONG", "read_file 噪声被滤");
	assert.equal(p.messages[1].role, "assistant");
	assert.equal(p.messages[1].text, "PONG");
	const probe = a.probe();
	assert.ok(probe.ok && probe.watermarkMs > 0, "probe 水位含 CLI 会话");
});
