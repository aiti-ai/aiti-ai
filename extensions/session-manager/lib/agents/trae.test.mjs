/**
 * session-manager — Trae adapter tests（真 sqlite 造库，零外部依赖；parse 路径不触发 sqlcipher 解密）。
 *
 * Run: node --test pi-web-ext/session-manager/lib/agents/trae.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const { createTraeAdapter, stripSystemReminder, stripToolWrapper, stripUserInput, TRAE_KNOWN_KEY } =
  await import("./trae.ts");

const ROOT = mkdtempSync(join(tmpdir(), "trae-adapter-test-"));

/** 按实测 schema 造最小明文库（parse() 只读这些列）。 */
function buildPlainDb(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE chat_session (session_id text primary key, session_title text, project_id text,
      created_at integer, updated_at integer, deleted_at integer default 0);
    CREATE TABLE project (project_id text primary key, absolute_path text);
    CREATE TABLE history_v2 (id integer primary key, session_id text not null,
      messages text, created_at integer, deleted_at integer default 0);
  `);
  db.prepare("INSERT INTO project VALUES (?,?)").run("p1", "/home/pi/proj");
  db.prepare("INSERT INTO chat_session VALUES (?,?,?,?,?,?)").run(
    "sess_a1", "Greeting", "p1", 1788660000, 1788660500, 0);
  // turns: user(wrapper) → assistant(+tool_calls) → tool(wrapper) → pure-reminder user turn
  const turns = [
    {
      role: "user",
      content: [
        { type: "text", text: "\n<system-reminder>\nToday's date: 2026-08-24\n</system-reminder>\n" },
        { type: "text", text: "<user_input>\nhi\n</user_input>" },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "Hi there! 👋" }],
      tool_calls: [{ function_call: { name: "RunCommand", arguments: "{\"command\":\"pwd\"}" } }],
    },
    {
      role: "tool",
      content: [{ type: "text", text: "<toolcall_status>done</toolcall_status> <toolcall_result> /home/pi/proj </toolcall_result>" }],
    },
    {
      role: "user",
      content: [{ type: "text", text: "\n<system-reminder>\nThe maximum number of terminals is 5\n</system-reminder>\n" }],
    },
  ];
  db.prepare("INSERT INTO history_v2 (session_id, messages, created_at, deleted_at) VALUES (?,?,?,0)").run(
    "sess_a1", JSON.stringify({ raw_messages: turns }), 1788660010);
  db.close();
}

test("strip helpers unwrap trae wrappers", () => {
  assert.equal(stripSystemReminder("\n<system-reminder>x</system-reminder>\nkeep"), "keep");
  assert.equal(stripSystemReminder("no wrappers"), "no wrappers");
  assert.equal(stripToolWrapper("<toolcall_status>done</toolcall_status> <toolcall_result> body </toolcall_result>"), "body");
  assert.equal(stripUserInput("<user_input>\nhi\n</user_input>"), "hi");
  assert.equal(TRAE_KNOWN_KEY, "3605f6691095a993f03d5009c918352ef5be31ae31e8f000212b81ff058da773");
});

test("parse() reads decrypted plain db: user unwrapped, reminder-only turns dropped", async () => {
  const dbPath = join(ROOT, "trae-plain.sqlite");
  buildPlainDb(dbPath);
  const adapter = createTraeAdapter();
  const p = await adapter.parse({ sid: "sess_a1", path: `${dbPath}#session:sess_a1` });
  assert.ok(p, "parse should return a session");
  assert.equal(p.meta.name, "Greeting");
  assert.equal(p.meta.cwd, "/home/pi/proj");
  assert.equal(p.meta.firstMessage, "hi");
  const roles = p.messages.map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant", "toolResult"], "pure-reminder turn must be dropped");
  assert.equal(p.messages[1].text, "Hi there! 👋\n🛠 RunCommand {\"command\":\"pwd\"}");
  assert.equal(p.messages[2].text, "/home/pi/proj");
  // parse with unknown sid → null（不抛）
  assert.equal(await adapter.parse({ sid: "nope", path: `${dbPath}#session:nope` }), null);
});

test("parse() returns null for non-session marker", async () => {
  const adapter = createTraeAdapter();
  assert.equal(await adapter.parse({ sid: "x", path: "/tmp/whatever.sqlite" }), null);
});

test.after(() => rmSync(ROOT, { recursive: true, force: true }));
