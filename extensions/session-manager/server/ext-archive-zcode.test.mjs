/**
 * A03 P2：zcode（rows 粒度，session/message/part 三表）真归档 fixture 测试。
 * 合成三表 db（含 parent_id 列，覆盖列动态发现）→ runExtArchive/restoreExtArchive roundtrip。
 * Run: node --test server/ext-archive-zcode.test.mjs
 */
import test from "node:test";
import { rmRf } from "../../_shared/test-rm-rf.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const { runtime, runExtArchive, restoreExtArchive } = await import("./runtime.ts");
const { findEntry, archivePackagesDir } = await import("../lib/session-archive.ts");
const { createZcodeAdapter } = await import("../lib/agents/zcode.ts");

const SID = "zcode-fixture-session-0001";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "sm-zcode-archive-"));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  const dbPath = join(root, "db.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, parent_id TEXT);
    CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, sequence INTEGER, time_created INTEGER, data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, sequence INTEGER, data TEXT);
  `);
  db.prepare("INSERT INTO session VALUES(?,?,?,?,?,?)")
    .run(SID, "/tmp/proj", "fixture zcode session", 1000, 2000, null);
  db.prepare("INSERT INTO message VALUES(?,?,?,?,?)")
    .run("m1", SID, 0, 1001, JSON.stringify({ role: "user", modelID: undefined, time: { created: 1001 } }));
  db.prepare("INSERT INTO part VALUES(?,?,?,?,?)")
    .run("p1", "m1", SID, 0, JSON.stringify({ type: "text", text: "hello zcode rows" }));
  db.prepare("INSERT INTO message VALUES(?,?,?,?,?)")
    .run("m2", SID, 1, 1002, JSON.stringify({ role: "assistant", modelID: "glm-4.7", providerID: "zhipuai", time: { created: 1002 } }));
  db.prepare("INSERT INTO part VALUES(?,?,?,?,?)")
    .run("p2", "m2", SID, 0, JSON.stringify({ type: "text", text: "hi!" }));
  db.close();
  return { root, configDir, dbPath };
}

const CORE = {
  async listSessions() { return []; },
  async getRunningSessionIds() { return []; },
  async getAliveSessionIds() { return []; },
  async getHomeDir() { return "/tmp"; },
};

test("A03 P2 zcode：三表 rows roundtrip（列动态发现 + 父表先插 + 幂等）", async () => {
  const { root, configDir, dbPath } = setup();
  const adapter = createZcodeAdapter(dbPath);
  const parsed = adapter.parse({ sid: SID, path: `${dbPath}#session:${SID}` });
  assert.ok(parsed, "parse 应成功");
  runtime(configDir).index.upsertExtParsed("zcode", SID, `${dbPath}#session:${SID}`, parsed);

  const ar = await runExtArchive(configDir, CORE, adapter, SID);
  assert.equal(ar.ok, true, "归档应成功：" + (ar.error ?? ""));
  const probe = new DatabaseSync(dbPath, { readOnly: true });
  const counts = probe.prepare(
    "SELECT (SELECT COUNT(*) FROM session WHERE id=?) a, (SELECT COUNT(*) FROM message WHERE session_id=?) b, (SELECT COUNT(*) FROM part WHERE session_id=?) c"
  ).get(SID, SID, SID);
  probe.close();
  assert.deepEqual([counts.a, counts.b, counts.c], [0, 0, 0], "三表行全删");

  const rr = await restoreExtArchive(configDir, CORE, adapter, SID);
  assert.equal(rr.ok, true, "恢复应成功：" + (rr.error ?? ""));
  const db2 = new DatabaseSync(dbPath, { readOnly: true });
  const sess = db2.prepare("SELECT id, directory, title, time_created, time_updated, parent_id FROM session WHERE id=?").get(SID);
  const parts = db2.prepare("SELECT COUNT(*) c FROM part WHERE session_id=?").get(SID);
  db2.close();
  assert.equal(sess.directory, "/tmp/proj");
  assert.equal(sess.parent_id, null);
  assert.equal(parts.c, 2, "part 行原样还原");
  assert.equal(findEntry(archivePackagesDir(configDir), `zcode:${SID}`), null, "包条目已撤");
  await rmRf(root, { closeSessionIndex: true, sessionIndexConfigDir: configDir });
});

test("A03 P2 zcode：parse 在删行后失败（源真没了，非幻读）", async () => {
  const { root, configDir, dbPath } = setup();
  const adapter = createZcodeAdapter(dbPath);
  const parsed = adapter.parse({ sid: SID, path: `${dbPath}#session:${SID}` });
  assert.ok(parsed);
  runtime(configDir).index.upsertExtParsed("zcode", SID, `${dbPath}#session:${SID}`, parsed);
  const ar = await runExtArchive(configDir, CORE, adapter, SID);
  assert.equal(ar.ok, true);
  assert.equal(adapter.parse({ sid: SID, path: `${dbPath}#session:${SID}` }), null, "删行后 parse=null（源确实没了）");
  await rmRf(root, { closeSessionIndex: true, sessionIndexConfigDir: configDir });
});
