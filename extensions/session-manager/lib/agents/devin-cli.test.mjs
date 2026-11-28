/**
 * session-manager — Devin CLI adapter tests (fixture sqlite db, zero external deps).
 *
 * Run: node --test pi-web-ext/session-manager/lib/agents/devin-cli.test.mjs
 * (AITI_DEVIN_CLI_HOME isolates to a temp dir; sessions.db built with node:sqlite per the measured schema)
 *
 * Pinned:
 *   1. probe/list/listFresh: hidden sessions excluded; rev = last_activity_at*1000 (db-backed
 *      per-session watermark prevents full re-parsing); fresh carries title.
 *   2. parse walks the parent chain backwards from main_chain_id — abandoned branches stay off the timeline.
 *   3. role mapping: system skipped, tool -> toolResult, assistant carries model/provider.
 *   4. meta: title/cwd/created/modified/messageCount/firstMessage/lastMessage.
 *   5. NULL main_chain_id (older dbs) falls back to node_id order; hidden/unknown sid -> null.
 *   6. read-only: no archive primitives (artifact-level remove on a shared db = nukes all sessions).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const ROOT = mkdtempSync(join(tmpdir(), "devin-cli-adapter-test-"));
process.env.AITI_DEVIN_CLI_HOME = ROOT;

function buildDb() {
  const db = new DatabaseSync(join(ROOT, "sessions.db"));
  db.exec(`
    CREATE TABLE sessions (id text primary key, working_directory text, backend_type text, model text, agent_mode text,
      created_at integer, last_activity_at integer, title text, main_chain_id integer, shell_last_seen_index integer,
      cogs_json text, workspace_dirs text, hidden integer, metadata text);
    CREATE TABLE message_nodes (row_id integer primary key, session_id text, node_id integer,
      parent_node_id integer, chat_message text, created_at integer);
  `);
  // sess_a1: active chain 0(system)->1(user)->2(assistant)->3(tool)->4(assistant), abandoned branch 5, empty assistant 6
  db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    "sess_a1", "/home/pi/proj", "windsurf", "swe-2-flash-medium", "accept-edits",
    1795872000, 1795872600, "Greeting", 4, 0, "[]", "[]", 0, "{}");
  const nodes = [
    // row_id, session, node_id, parent, role, content, created_at
    [1, "sess_a1", 0, null, "system", "You are Devin, an interactive command line agent from Cognition.", 1795872000],
    [2, "sess_a1", 1, 0, "user", "运行 pwd", 1795872100],
    [3, "sess_a1", 2, 1, "assistant", "当前在 /home/pi/proj", 1795872200],
    [4, "sess_a1", 3, 2, "tool", "Output from command in shell d0cb16: AGENTS.md\nREADME.md", 1795872300],
    [5, "sess_a1", 4, 3, "assistant", "done", 1795872400],
    [6, "sess_a1", 5, 1, "assistant", "abandoned branch draft", 1795872450], // off the active chain
    [7, "sess_a1", 6, 4, "assistant", "", 1795872500], // empty text, skipped
  ];
  for (const [rid, sid, nid, parent, role, content, created] of nodes) {
    db.prepare("INSERT INTO message_nodes VALUES (?,?,?,?,?,?)").run(
      rid, sid, nid, parent, JSON.stringify({ role, content }), created);
  }
  // hidden session
  db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    "sess_hidden", "/tmp", "windsurf", "swe-2-flash-medium", "accept-edits",
    1795872000, 1795872601, "hidden one", 1, 0, "[]", "[]", 1, "{}");
  db.prepare("INSERT INTO message_nodes VALUES (?,?,?,?,?,?)").run(
    20, "sess_hidden", 0, null, JSON.stringify({ role: "user", content: "hi" }), 1795872000);
  // legacy NULL-chain session: falls back to node_id order
  db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    "sess_legacy", "/tmp", "windsurf", "swe-1-6-slow", "accept-edits",
    1787629489, 1787629491, null, null, 0, "[]", "[]", 0, "{}");
  db.prepare("INSERT INTO message_nodes VALUES (?,?,?,?,?,?)").run(
    30, "sess_legacy", 0, null, JSON.stringify({ role: "user", content: "hi" }), 1787629489);
  db.prepare("INSERT INTO message_nodes VALUES (?,?,?,?,?,?)").run(
    31, "sess_legacy", 1, 0, JSON.stringify({ role: "assistant", content: "hello" }), 1787629491);
  db.close();
}
buildDb();

test.after(() => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ } });

test("probe：visible 计数、hidden 排除、watermark = max(last_activity_at)", async () => {
  const { createDevinCliAdapter } = await import("./devin-cli.ts");
  const p = await createDevinCliAdapter().probe();
  assert.equal(p.ok, true);
  assert.equal(p.count, 2, "hidden sessions not counted");
  assert.equal(p.watermarkMs, 1795872600 * 1000, "watermark counts visible sessions only");
});

test("list：rev = last_activity_at*1000（db 型源 per-session 水位）", async () => {
  const { createDevinCliAdapter } = await import("./devin-cli.ts");
  const refs = await createDevinCliAdapter().list();
  const a1 = refs.find((r) => r.sid === "sess_a1");
  assert.ok(a1, "sess_a1 listed");
  assert.equal(a1.rev, 1795872600 * 1000);
  assert.ok(!refs.some((r) => r.sid === "sess_hidden"), "hidden sessions not listed");
});

test("listFresh：title + timeUpdatedMs，零 message parse", async () => {
  const { createDevinCliAdapter } = await import("./devin-cli.ts");
  const fresh = await createDevinCliAdapter().listFresh();
  const a1 = fresh.find((f) => f.sid === "sess_a1");
  assert.equal(a1?.title, "Greeting");
  assert.equal(a1?.timeUpdatedMs, 1795872600 * 1000);
});

test("parse：活跃链遍历（废弃分支/空文本不入），role 映射与 meta 面", async () => {
  const { createDevinCliAdapter } = await import("./devin-cli.ts");
  const parsed = await createDevinCliAdapter().parse({ sid: "sess_a1", path: join(ROOT, "sessions.db") });
  assert.ok(parsed, "parse succeeds");
  const msgs = parsed.messages;
  assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant", "toolResult", "assistant"], "system skipped; tool->toolResult; empty skipped");
  assert.equal(msgs[0].text, "运行 pwd");
  assert.equal(msgs[2].text.includes("AGENTS.md"), true, "tool result text within the 2000-char cap");
  const asst = msgs[1];
  assert.equal(asst.model, "swe-2-flash-medium");
  assert.equal(asst.provider, "devin");
  assert.equal(parsed.meta.cwd, "/home/pi/proj");
  assert.equal(parsed.meta.name, "Greeting");
  assert.equal(parsed.meta.firstMessage, "运行 pwd");
  assert.equal(parsed.meta.lastMessage, "done");
  assert.equal(parsed.meta.messageCount, 4);
  assert.equal(parsed.meta.created, new Date(1795872000 * 1000).toISOString());
  assert.equal(parsed.meta.modified, new Date(1795872600 * 1000).toISOString());
});

test("parse：hidden / 未知 sid → null", async () => {
  const { createDevinCliAdapter } = await import("./devin-cli.ts");
  const adapter = createDevinCliAdapter();
  assert.equal(await adapter.parse({ sid: "sess_hidden", path: "x" }), null);
  assert.equal(await adapter.parse({ sid: "nope", path: "x" }), null);
});

test("parse：NULL main_chain_id 老库回落 node_id 序", async () => {
  const { createDevinCliAdapter } = await import("./devin-cli.ts");
  const parsed = await createDevinCliAdapter().parse({ sid: "sess_legacy", path: "x" });
  assert.ok(parsed);
  assert.deepEqual(parsed.messages.map((m) => m.role), ["user", "assistant"]);
  assert.equal(parsed.meta.firstMessage, "hi", "without a title firstMessage = first user text");
});

test("只读：不挂 archive primitives（共享库按 artifact 删 = 删整库）", async () => {
  const { createDevinCliAdapter } = await import("./devin-cli.ts");
  const adapter = createDevinCliAdapter();
  assert.equal(adapter.capabilities, undefined, "capabilities 缺省 = 纯只读");
  assert.equal(adapter.removeSession, undefined);
  assert.equal(adapter.snapshot, undefined);
});
