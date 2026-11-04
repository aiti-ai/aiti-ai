/**
 * A03 P2：cursor-cli（artifact 粒度，每会话独立目录）真归档 fixture 测试。
 * 会话目录 = store.db（protobuf 引用图）+ summary——整目录打包/级联删/原样还原。
 * Run: node --test server/ext-archive-cursor-cli.test.mjs
 */
import test from "node:test";
import { rmRf } from "../../_shared/test-rm-rf.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const { runtime, runExtArchive, restoreExtArchive } = await import("./runtime.ts");
const { findEntry, archivePackagesDir } = await import("../lib/session-archive.ts");
const { createCursorCliAdapter } = await import("../lib/agents/cursor-cli.ts");

const SID = "c1a19e2e-5b7d-4c00-9000-1a2b3c4d5e6f";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "sm-cc-archive-"));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  const sessDir = join(root, "chats", "projhash", SID);
  mkdirSync(sessDir, { recursive: true });
  // 合成 store.db（protobuf 图 fixture：blobs 内容寻址 + meta '0' 根索引，形状对齐真库审计）
  const dbPath = join(sessDir, "store.db");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE blobs(id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta(key TEXT, value TEXT);");
  const rootBlob = Buffer.from("fixture-root-turn-chain");
  db.prepare("INSERT INTO blobs(id, data) VALUES(?,?)").run("root-1", rootBlob);
  db.prepare("INSERT INTO meta(key, value) VALUES('0', ?)").run(Buffer.from(JSON.stringify({ rootId: "root-1" }).replace(/root-1/g, "root-1")).toString("hex"));
  db.close();
  writeFileSync(join(sessDir, "summary"), JSON.stringify({ title: "fixture cursor-cli", updatedMs: Date.now() }));
  return { root, configDir, sessDir, dbPath };
}

const CORE = {
  async listSessions() { return []; },
  async getRunningSessionIds() { return []; },
  async getAliveSessionIds() { return []; },
  async getHomeDir() { return "/tmp"; },
};

test("A03 P2 cursor-cli：会话目录 artifact roundtrip（store.db 引用图整目录还原）", async () => {
  const { root, configDir, sessDir, dbPath } = setup();
  const adapter = createCursorCliAdapter();
  // fixture：adapter 的 chats root 指向真 home——这里直接以目录级原语为被测单元，
  // 走 runExtArchive/restoreExtArchive 全管线（守卫/快照/sha256/删/还原）。
  const parsed = {
    meta: { path: dbPath, id: SID, cwd: "/tmp/p", name: "fixture", created: "2026-09-19T00:00:00Z", modified: "2026-09-19T00:00:00Z", messageCount: 1, firstMessage: "hello", lastMessage: "hello" },
    messages: [{ entryId: "1", role: "user", ts: null, text: "hello" }],
  };
  runtime(configDir).index.upsertExtParsed("cursor", SID, dbPath, parsed);
  const id = `cursor:${SID}`;

  // 直接以会话目录为目标走管线（与 adapter 原语同一 targetOf 语义）
  const ar = await runExtArchive(configDir, CORE, { ...adapter,
    list: () => [{ sid: SID, path: sessDir }],   // 指向会话目录 → 真 artifact 原语以目录为目标
    parse: () => ({
      meta: { path: sessDir, id: SID, cwd: "/tmp/p", name: "fixture", created: "2026-09-19T00:00:00Z", modified: "2026-09-19T00:00:00Z", messageCount: 1, firstMessage: "hello", lastMessage: "hello" },
      messages: [{ entryId: "1", role: "user", ts: null, text: "hello" }],
    }),
  }, SID);
  assert.equal(ar.ok, true, "归档应成功：" + (ar.error ?? ""));
  assert.equal(existsSync(sessDir), false, "会话目录已删");

  // 还原：用真原语解包（目录容器）——直接构造快照验证 packDir/unpackDir 对称性
  const raw = readFileSync(join(archivePackagesDir(configDir), ar.packageName));
  assert.ok(raw.length > 0);
  const rr = await restoreExtArchive(configDir, CORE, {
    ...adapter,
    list: () => (existsSync(sessDir) ? [{ sid: SID, path: sessDir }] : []),
    parse: () => ({
      meta: { path: sessDir, id: SID, cwd: "/tmp/p", name: "fixture", created: "2026-09-19T00:00:00Z", modified: "2026-09-19T00:00:00Z", messageCount: 1, firstMessage: "hello", lastMessage: "hello" },
      messages: [{ entryId: "1", role: "user", ts: null, text: "hello" }],
    }),
  }, SID);
  assert.equal(rr.ok, true, "恢复应成功：" + (rr.error ?? ""));
  assert.equal(existsSync(dbPath), true, "store.db 已还原");
  const db2 = new DatabaseSync(dbPath, { readOnly: true });
  const blobs = db2.prepare("SELECT COUNT(*) c FROM blobs").get();
  const metaRow = db2.prepare("SELECT value FROM meta WHERE key='0'").get();
  db2.close();
  assert.ok(blobs.c >= 1 && metaRow, "引用图完整（blobs + meta 根索引）");
  assert.equal(findEntry(archivePackagesDir(configDir), id), null, "包条目已撤");
  await rmRf(root, { closeSessionIndex: true, sessionIndexConfigDir: configDir });
});
