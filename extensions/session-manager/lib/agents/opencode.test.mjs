/**
 * session-manager — OpenCode adapter modern-db 测试（直读改造 2026-09-12 配套）。
 * 真 sqlite 造库，AITI_OPENCODE_HOME 隔离。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/session-manager/lib/agents/opencode.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const ROOT = mkdtempSync(join(tmpdir(), "opencode-adapter-test-"));
process.env.AITI_OPENCODE_HOME = ROOT;
// 无 legacy storage 目录 → list 走 modern db 分支

const DB_PATH = join(ROOT, "opencode.db");

function buildModernDb() {
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE session (id text primary key, project_id text, directory text, title text,
      time_created integer, time_updated integer, data text);
    CREATE TABLE session_message (id text primary key, session_id text not null, seq integer, data text, time_created integer);
  `);
  db.prepare("INSERT INTO session VALUES (?,?,?,?,?,?,?)").run(
    "ses_1", "p1", "/tmp/proj", "modern 会话", 1788660000000, 1788660500000, "{}");
  db.prepare("INSERT INTO session_message VALUES (?,?,?,?,?)").run(
    "msg_1", "ses_1", 0,
    JSON.stringify({ role: "user", parts: [{ type: "text", text: "直读测试" }] }), 1788660010000);
  db.prepare("INSERT INTO session_message VALUES (?,?,?,?,?)").run(
    "msg_2", "ses_1", 1,
    JSON.stringify({ role: "assistant", parts: [{ type: "text", text: "收到" }] }), 1788660020000);
  db.close();
}

test.after(() => rmSync(ROOT, { recursive: true, force: true }));

test("opencode modern db：list 直读 + rev refs + parse 直开源库", async () => {
  buildModernDb();
  const { createOpencodeAdapter } = await import("./opencode.ts");
  const adapter = createOpencodeAdapter();

  const probe = adapter.probe();
  assert.equal(probe.ok, true, "probe: modern db 存在即 ok");

  const refs = adapter.list();
  assert.equal(refs.length, 1, "legacy 为空 → modern db 分支");
  assert.equal(refs[0].sid, "ses_1");
  assert.ok(refs[0].path.startsWith(DB_PATH), "ref.path 指向源库（非 /tmp 副本）");
  assert.equal(refs[0].rev, 1788660500000, "rev = time_updated");

  const parsed = adapter.parse(refs[0]);
  assert.ok(parsed, "parse 成功");
  assert.equal(parsed.meta.id, "ses_1");
  assert.equal(parsed.meta.name, "modern 会话");
  assert.equal(parsed.meta.messageCount, 2);
  assert.equal(parsed.meta.firstMessage, "直读测试");
});

test("opencode modern db：rev 水位联动——time_updated 变 → refs.rev 变 → syncExt 只重解析它", async () => {
  const { createOpencodeAdapter } = await import("./opencode.ts");
  const { openSessionIndex } = await import("../session-index.ts");
  const dir = mkdtempSync(join(tmpdir(), "opencode-rev-test-"));
  try {
    const idx = openSessionIndex(join(dir, "i.sqlite"));
    const adapter = createOpencodeAdapter();
    const parseCalls = [];
    const parse = (ref) => { parseCalls.push(ref.sid); return adapter.parse(ref); };

    let r = await idx.syncExt("opencode", adapter.list(), parse);
    assert.equal(r.indexed, 1);

    parseCalls.length = 0;
    r = await idx.syncExt("opencode", adapter.list(), parse);
    assert.equal(r.indexed, 0);
    assert.deepEqual(parseCalls, [], "rev 未变 → 跳过");

    // 源库会话前进（模拟 opencode 运行中写入）
    const db = new DatabaseSync(DB_PATH);
    db.prepare("UPDATE session SET time_updated = ? WHERE id = ?").run(1788660999999, "ses_1");
    db.close();
    parseCalls.length = 0;
    r = await idx.syncExt("opencode", adapter.list(), parse);
    assert.equal(r.indexed, 1, "rev 前进 → 重解析");
    assert.deepEqual(parseCalls, ["ses_1"]);

    idx.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 1.19.5 schema（2026-11-05 实测）：新会话只写 opencode.db 的 message + part 两表
// （session_message 恒空）；legacy JSON storage 停写但存量照读，list 恒合并两源。
test("opencode 1.19.5 db：message+part 两表解析 + legacy 合并去重", async () => {
  const { createOpencodeAdapter } = await import("./opencode.ts");
  const home2 = mkdtempSync(join(tmpdir(), "opencode-195-test-"));
  try {
    const db = new DatabaseSync(join(home2, "opencode.db"));
    db.exec(`
      CREATE TABLE session (id text primary key, directory text, title text,
        time_created integer, time_updated integer);
      CREATE TABLE message (id text primary key, session_id text not null,
        time_created integer, time_updated integer, data text);
      CREATE TABLE part (id text primary key, message_id text not null, session_id text not null,
        time_created integer, time_updated integer, data text);
      CREATE TABLE session_message (id text primary key, session_id text not null,
        seq integer, data text, time_created integer);
    `);
    db.prepare("INSERT INTO session VALUES (?,?,?,?,?)").run(
      "ses_new1", "/tmp/proj195", "glm-5.3 探针", 1793809243007, 1793809270682);
    // message.data：1.19.5 形状（role/modelID/time 顶格）
    db.prepare("INSERT INTO message VALUES (?,?,?,?,?)").run(
      "msg_u1", "ses_new1", 1793809243007, 1793809243007,
      JSON.stringify({ role: "user", path: { cwd: "/tmp" }, time: { created: 1793809243007 } }));
    db.prepare("INSERT INTO message VALUES (?,?,?,?,?)").run(
      "msg_a1", "ses_new1", 1793809270680, 1793809270680,
      JSON.stringify({ role: "assistant", modelID: "glm-5.3", providerID: "zhipuai-coding-plan", time: { created: 1793809243007, completed: 1793809270680 }, finish: "stop" }));
    // parts：text + step-start/step-finish 噪声 + tool
    db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?)").run(
      "prt_u1", "msg_u1", "ses_new1", 1793809243007, 1793809243007,
      JSON.stringify({ type: "text", text: "\"Reply with exactly: ok\"" }));
    db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?)").run(
      "prt_a0", "msg_a1", "ses_new1", 1793809270613, 1793809270613,
      JSON.stringify({ type: "step-start" }));
    db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?)").run(
      "prt_a1", "msg_a1", "ses_new1", 1793809270619, 1793809270661,
      JSON.stringify({ type: "text", text: "ok", time: { start: 1793809270619, end: 1793809270661 } }));
    db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?)").run(
      "prt_a2", "msg_a1", "ses_new1", 1793809270680, 1793809270680,
      JSON.stringify({ reason: "stop", type: "step-finish", tokens: {} }));
    // legacy JSON 会话（迁移两源并存场景）——db 优先去重
    mkdirSync(join(home2, "storage", "session", "global"), { recursive: true });
    writeFileSync(join(home2, "storage", "session", "global", "ses_new1.json"),
      JSON.stringify({ id: "ses_new1", title: "旧 json 残留", directory: "/old", time: { created: 1, updated: 2 } }));
    db.close();

    const adapter = createOpencodeAdapter(home2);
    const refs = adapter.list();
    assert.equal(refs.filter((r) => r.sid === "ses_new1").length, 1, "两源同 sid 去重");
    assert.ok(refs[0].path.includes("#session:"), "db 优先（ref 指向 db）");
    const parsed = adapter.parse(refs[0]);
    assert.ok(parsed, "1.19.5 会话 parse 成功");
    assert.equal(parsed.meta.name, "glm-5.3 探针", "title 取 db 行而非 legacy 残留");
    assert.equal(parsed.meta.cwd, "/tmp/proj195");
    assert.equal(parsed.meta.messageCount, 2);
    assert.equal(parsed.messages[0].text, "\"Reply with exactly: ok\"");
    assert.equal(parsed.messages[1].role, "assistant");
    assert.equal(parsed.messages[1].text, "ok");
    assert.equal(parsed.messages[1].model, "glm-5.3");
  } finally {
    rmSync(home2, { recursive: true, force: true });
  }
});
