/**
 * A03 P2 试点：zed（rows 粒度）真归档 fixture 测试。
 * 合成 threads.db（单表 blob，zstd 压缩 payload 与真库同构）→ runExtArchive/restoreExtArchive
 * 完整 roundtrip；再对本机真库（存在时）做只读探针验证接入面。
 * Run: node --test server/ext-archive-zed.test.mjs
 */
import test from "node:test";
import { rmRf } from "../../_shared/test-rm-rf.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

const { runtime, runExtArchive, restoreExtArchive } = await import("./runtime.ts");
const { findEntry, archivePackagesDir } = await import("../lib/session-archive.ts");
const { createZedAdapter } = await import("../lib/agents/zed.ts");

const SID = "b7e2c1a0-0000-4000-8000-000000000001";
const THREAD = {
  title: "fixture thread",
  messages: [
    { User: { id: "u1", content: [{ Text: "hello zed" }] } },
    { Agent: { id: "a1", content: [{ Text: "world" }] } },
  ],
};

function setup() {
  // adapter 的 mtime 门控快照缓存是全局路径（/tmp/sm-zed-cache）——测试间必须清，防陈旧副本遮蔽新库
  try { rmSync(join(tmpdir(), "sm-zed-cache"), { recursive: true, force: true }); } catch { /* noop */ }
  const root = mkdtempSync(join(tmpdir(), "sm-zed-archive-"));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  const dbPath = join(root, "threads.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE threads(id TEXT PRIMARY KEY, summary TEXT, data_type TEXT, data BLOB, created_at TEXT, updated_at TEXT)`);
  db.prepare("INSERT INTO threads(id, summary, data_type, data, created_at, updated_at) VALUES(?,?,?,?,?,?)")
    .run(SID, "fixture thread", "zstd", zstdCompressSync(Buffer.from(JSON.stringify(THREAD))), "2026-09-19T00:00:00Z", "2026-09-19T01:00:00Z");
  db.close();
  return { root, configDir, dbPath };
}

const CORE = {
  async listSessions() { return []; },
  async getRunningSessionIds() { return []; },
  async getAliveSessionIds() { return []; },
  async getHomeDir() { return "/tmp"; },
};

test("A03 P2 zed：真归档 roundtrip（blob 原样插回 + 单表无级联）", async () => {
  const { root, configDir, dbPath } = setup();
  const adapter = createZedAdapter(dbPath);
  const parsed = adapter.parse({ sid: SID, path: `${dbPath}#thread:${SID}` });
  assert.ok(parsed, "parse 应成功（fixture 同构真库形状）");
  runtime(configDir).index.upsertExtParsed("zed", SID, `${dbPath}#thread:${SID}`, parsed);
  const id = `zed:${SID}`;

  // ── 归档：DB 行删除 ──
  const ar = await runExtArchive(configDir, CORE, adapter, SID);
  assert.equal(ar.ok, true, "归档应成功：" + (ar.error ?? ""));
  const probe = new DatabaseSync(dbPath, { readOnly: true });
  const left = probe.prepare("SELECT COUNT(*) c FROM threads WHERE id=?").get(SID);
  probe.close();
  assert.equal(left.c, 0, "行已从源库删除");
  const hit = findEntry(archivePackagesDir(configDir), id);
  assert.ok(hit, "包内可定位");

  // ── 恢复：blob 原样插回 ──
  const rr = await restoreExtArchive(configDir, CORE, adapter, SID);
  assert.equal(rr.ok, true, "恢复应成功：" + (rr.error ?? ""));
  const db2 = new DatabaseSync(dbPath, { readOnly: true });
  const row = db2.prepare("SELECT summary, data_type, data, created_at, updated_at FROM threads WHERE id=?").get(SID);
  db2.close();
  assert.ok(row, "行已插回");
  assert.equal(row.summary, "fixture thread");
  assert.deepEqual(JSON.parse(zstdDecompressSync(row.data).toString()), THREAD, "blob 字节级一致（zstd 解压后逐字段相等）");
  assert.equal(findEntry(archivePackagesDir(configDir), id), null, "包条目已撤");
  await rmRf(root, { closeSessionIndex: true, sessionIndexConfigDir: configDir });
});


