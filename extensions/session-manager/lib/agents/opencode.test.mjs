/**
 * session-manager — OpenCode adapter modern-db 测试（直读改造 2026-09-12 配套）。
 * 真 sqlite 造库，AITI_OPENCODE_HOME 隔离。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/session-manager/lib/agents/opencode.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, rmSync } from "node:fs";
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
