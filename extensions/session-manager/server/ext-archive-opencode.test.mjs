/**
 * A03 P2：opencode legacy 文件代真归档 fixture 测试。
 * 合成 storage 树（session.json + message/<sid>/msg_*.json + part/<msgId>/prt_*.json）
 * → runExtArchive/restoreExtArchive roundtrip（多文件打包/级联删/原样还原）。
 * Run: node --test server/ext-archive-opencode.test.mjs
 */
import test from "node:test";
import { rmRf } from "../../_shared/test-rm-rf.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { runtime, runExtArchive, restoreExtArchive } = await import("./runtime.ts");
const { findEntry, archivePackagesDir } = await import("../lib/session-archive.ts");
const { createOpencodeAdapter } = await import("../lib/agents/opencode.ts");

const SID = "ses_fixture0001";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "sm-oc-archive-"));
  const home = join(root, "opencode-home");
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  const sessDir = join(home, "storage", "session", "global");
  const msgDir = join(home, "storage", "message", SID);
  const partDir = join(home, "storage", "part", "msg_01");
  mkdirSync(sessDir, { recursive: true });
  mkdirSync(msgDir, { recursive: true });
  mkdirSync(partDir, { recursive: true });
  const sessJson = join(sessDir, SID + ".json");
  writeFileSync(sessJson, JSON.stringify({ id: SID, title: "fixture oc", directory: "/tmp/p", time: { created: 1000, updated: 2000 } }));
  writeFileSync(join(msgDir, "msg_01.json"), JSON.stringify({ id: "msg_01", sessionID: SID, role: "user", time: { created: 1001 } }));
  writeFileSync(join(partDir, "prt_01.json"), JSON.stringify({ type: "text", text: "hello opencode" }));
  return { root, configDir, home, sessJson, msgDir, partDir };
}

const CORE = {
  async listSessions() { return []; },
  async getRunningSessionIds() { return []; },
  async getAliveSessionIds() { return []; },
  async getHomeDir() { return "/tmp"; },
};

test("A03 P2 opencode legacy：跨目录多文件 roundtrip（级联删+原样还原）", async () => {
  const { root, configDir, home, sessJson, msgDir, partDir } = setup();
  const adapter = createOpencodeAdapter(home);
  const parsed = adapter.parse({ sid: SID, path: sessJson });
  assert.ok(parsed, "parse 应成功");
  runtime(configDir).index.upsertExtParsed("opencode", SID, sessJson, parsed);
  const id = `opencode:${SID}`;

  const ar = await runExtArchive(configDir, CORE, adapter, SID);
  assert.equal(ar.ok, true, "归档应成功：" + (ar.error ?? ""));
  assert.equal(existsSync(sessJson), false, "session.json 已删");
  assert.equal(existsSync(msgDir), false, "message 目录已清/删");
  assert.equal(existsSync(partDir), false, "part 目录已删");

  const rr = await restoreExtArchive(configDir, CORE, adapter, SID);
  assert.equal(rr.ok, true, "恢复应成功：" + (rr.error ?? ""));
  assert.equal(JSON.parse(readFileSync(sessJson, "utf8")).id, SID, "session.json 原样还原");
  assert.equal(JSON.parse(readFileSync(join(msgDir, "msg_01.json"), "utf8")).id, "msg_01", "message 原样还原");
  assert.equal(JSON.parse(readFileSync(join(partDir, "prt_01.json"), "utf8")).text, "hello opencode", "part 原样还原");
  assert.equal(findEntry(archivePackagesDir(configDir), id), null, "包条目已撤");
  await rmRf(root, { closeSessionIndex: true, sessionIndexConfigDir: configDir });
});
