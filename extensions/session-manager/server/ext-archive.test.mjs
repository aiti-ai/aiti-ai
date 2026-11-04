/**
 * A03 真归档管线 fixture 测试（docs/todo-session-manager-ext-archive-delete.md §6 P0 / §7 验收）。
 *
 * 覆盖：
 *   1. 真实 roundtrip：归档 → 源文件消失 → 包存在（sha256 验证）→ 放回 → 字节级一致 + 源列表恢复；
 *   2. removeSession 抛错 → 源数据完好 + 无半包残留（§10 纪律 ext 版）；
 *   3. 无 capabilities 的 adapter → 拒绝真归档（零回归基线）；
 *   4. 放回前查重：源已存在同 sid → 中止（防覆盖）。
 * Run: node --test server/ext-archive.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const { runExtArchive, restoreExtArchive } = await import("./runtime.ts");
const { findEntry, archivePackagesDir } = await import("../lib/session-archive.ts");
const { extId } = await import("../lib/agents/types.ts");

/** fixture adapter：claude-like 同构（root 指向临时目录，绕开 homedir 闭包） */
function fixtureAdapter(sourceRoot, opts = {}) {
  const SID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
  const list = () => {
    const out = [];
    if (!existsSync(sourceRoot)) return out;
    for (const f of readdirSync(sourceRoot)) {
      const m = SID_RE.exec(f);
      if (m) out.push({ sid: m[1], path: join(sourceRoot, f) });
    }
    return out;
  };
  return {
    id: "claude",
    label: "Claude (fixture)",
    roots: () => [sourceRoot],
    probe: () => ({ ok: true, count: list().length, watermarkMs: 0 }),
    list,
    parse: (ref) => ({
      meta: { cwd: sourceRoot, name: "fixture", created: "2026-09-19T00:00:00Z", modified: "2026-09-19T00:00:00Z", messageCount: 1, firstMessage: "hi", lastMessage: "hi" },
      messages: [{ role: "user", text: "hi", entryId: "e1", ts: "2026-09-19T00:00:00Z" }],
      firstMessage: "hi", lastMessage: "hi", messageCount: 1,
      created: "2026-09-19T00:00:00Z", modified: "2026-09-19T00:00:00Z",
    }),
    ...(opts.removeThrows
      ? { removeSession: () => { throw new Error("simulated remove failure"); } }
      : { removeSession: (ref) => rmSync(ref.path, { force: true }) }),
    snapshot: (ref) => {
      try { return { bytes: readFileSync(ref.path), layout: ref.path }; } catch { return null; }
    },
    putBack: (_sid, snap) => {
      mkdirSync(dirname(snap.layout), { recursive: true });
      writeFileSync(snap.layout, snap.bytes);
    },
    ...(opts.capabilities === false ? {} : { capabilities: { remove: true, putBack: true, granularity: "artifact" } }),
  };
}

const CORE = {
  async listSessions() { return []; },
  async getRunningSessionIds() { return []; },
  async getAliveSessionIds() { return []; },
  async getHomeDir() { return "/tmp"; },
};

const SID = "aaaa1111-2222-3333-4444-444444444444";
const CONTENT = '{"type":"user","message":{"role":"user","content":"hello archive"}}\n';

function setup() {
  const root = mkdtempSync(join(tmpdir(), "sm-ext-archive-"));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  const sourceRoot = join(root, "source", "proj-x");
  mkdirSync(sourceRoot, { recursive: true });
  const sessionPath = join(sourceRoot, SID + ".jsonl");
  writeFileSync(sessionPath, CONTENT);
  return { root, configDir, sourceRoot, sessionPath };
}

test("A03 真实 roundtrip：归档→源消失→包验证→放回→字节级一致", async () => {
  const { configDir, sourceRoot, sessionPath } = setup();
  const adapter = fixtureAdapter(sourceRoot);
  // 预置索引行（管线预检 + setExtArchived 需行存在）
  const { runtime } = await import("./runtime.ts");
  runtime(configDir).index.upsertExtParsed("claude", SID, sessionPath, adapter.parse({ path: sessionPath }));
  const id = extId("claude", SID);

  // ── 归档 ──
  const ar = await runExtArchive(configDir, CORE, adapter, SID);
  assert.equal(ar.ok, true, "归档应成功：" + (ar.error ?? ""));
  assert.equal(existsSync(sessionPath), false, "源文件已删除");
  const hit = findEntry(archivePackagesDir(configDir), id);
  assert.ok(hit, "包内可定位条目");
  assert.equal(hit.entry.path, sessionPath, "layout 记录原路径");
  assert.equal(readFileSync(hit.packagePath).length > 0, true);
  assert.ok(runtime(configDir).index.getSession(id)?.archived, "索引行已置归档");

  // ── 恢复 ──
  const rr = await restoreExtArchive(configDir, CORE, adapter, SID);
  assert.equal(rr.ok, true, "恢复应成功：" + (rr.error ?? ""));
  assert.equal(readFileSync(sessionPath, "utf8"), CONTENT, "字节级一致");
  assert.ok(adapter.list().some((r) => r.sid === SID), "源列表恢复");
  assert.equal(findEntry(archivePackagesDir(configDir), id), null, "包条目已撤");
  assert.ok(!runtime(configDir).index.getSession(id)?.archived, "行翻回 live");
  rmSync(configDir, { recursive: true, force: true });
  rmSync(join(dirname(configDir), "state"), { recursive: true, force: true });
  rmSync(sourceRoot, { recursive: true, force: true });
});

test("A03 removeSession 抛错：源数据完好 + 无半包残留", async () => {
  const { configDir, sourceRoot, sessionPath } = setup();
  const adapter = fixtureAdapter(sourceRoot, { removeThrows: true });
  const { runtime } = await import("./runtime.ts");
  runtime(configDir).index.upsertExtParsed("claude", SID, sessionPath, adapter.parse({ path: sessionPath }));
  const id = extId("claude", SID);

  const ar = await runExtArchive(configDir, CORE, adapter, SID);
  assert.equal(ar.ok, false);
  assert.match(ar.error, /removeSession 失败（源数据保留）/);
  assert.equal(existsSync(sessionPath), true, "源数据完好");
  assert.equal(findEntry(archivePackagesDir(configDir), id), null, "无半包残留");
  assert.ok(!runtime(configDir).index.getSession(id)?.archived, "索引未置归档");
  rmSync(configDir, { recursive: true, force: true });
  rmSync(join(dirname(configDir), "state"), { recursive: true, force: true });
  rmSync(sourceRoot, { recursive: true, force: true });
});

test("A03 无 capabilities 的 adapter 拒绝真归档（零回归基线）", async () => {
  const { configDir, sourceRoot, sessionPath } = setup();
  const adapter = fixtureAdapter(sourceRoot, { capabilities: false });
  const { runtime } = await import("./runtime.ts");
  runtime(configDir).index.upsertExtParsed("claude", SID, sessionPath, adapter.parse({ path: sessionPath }));
  const ar = await runExtArchive(configDir, CORE, adapter, SID);
  assert.equal(ar.ok, false);
  assert.match(ar.error, /不支持真归档/);
  assert.equal(existsSync(sessionPath), true, "源未被动过");
  rmSync(configDir, { recursive: true, force: true });
  rmSync(sourceRoot, { recursive: true, force: true });
});

test("A03 放回查重：源已存在同 sid → 中止（防覆盖），包保留", async () => {
  const { configDir, sourceRoot, sessionPath } = setup();
  const adapter = fixtureAdapter(sourceRoot);
  const { runtime } = await import("./runtime.ts");
  runtime(configDir).index.upsertExtParsed("claude", SID, sessionPath, adapter.parse({ path: sessionPath }));
  const id = extId("claude", SID);
  const ar = await runExtArchive(configDir, CORE, adapter, SID);
  assert.equal(ar.ok, true);
  // 源里重建同 id 文件（模拟用户已重建）
  writeFileSync(sessionPath, "rebuilt");
  const rr = await restoreExtArchive(configDir, CORE, adapter, SID);
  assert.equal(rr.ok, false);
  assert.match(rr.error, /源已存在同 id/);
  assert.ok(findEntry(archivePackagesDir(configDir), id), "包保留（数据不丢）");
  rmSync(configDir, { recursive: true, force: true });
  rmSync(join(dirname(configDir), "state"), { recursive: true, force: true });
  rmSync(sourceRoot, { recursive: true, force: true });
});
