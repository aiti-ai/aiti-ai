/**
 * session-manager Phase 2 tests: file parser, FTS5 index, .pwarc archive.
 * Run: node --experimental-strip-types --test ~/.pi/web/extensions/session-manager/lib/phase2.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, existsSync, readFileSync, statSync, unlinkSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/** 三目录对称（2026-09-13）：宿主注入的 configDir = <extRoot>/config；测试里的 temp 目录即 extRoot。 */
function cfgOf(root) {
  const c = join(root, "config");
  mkdirSync(c, { recursive: true });
  return c;
}

const { parseSessionFile } = await import("./session-file.ts");
const { openSessionIndex } = await import("./session-index.ts");
const {
  collectCandidates, writeArchive, readArchiveManifest, findEntry, extractToCache,
  clearCache, deleteOriginals, packageNameFor, removeFromArchive, restoreFromArchive,
} = await import("./session-archive.ts");

function makeSessionRaw(id, cwd, ts, messages) {
  const lines = [JSON.stringify({ type: "session", version: 3, id, timestamp: ts, cwd })];
  for (const m of messages) lines.push(JSON.stringify(m));
  return lines.join("\n") + "\n";
}

function userMsg(id, ts, text) { return { type: "message", id, parentId: null, timestamp: ts, message: { role: "user", content: text } }; }
function asstMsg(id, ts, text, model = "m1") { return { type: "message", id, parentId: null, timestamp: ts, message: { role: "assistant", content: [{ type: "text", text }], model, provider: "p1" } }; }
function toolMsg(id, ts, text) { return { type: "message", id, parentId: null, timestamp: ts, message: { role: "toolResult", toolCallId: "tc", content: [{ type: "text", text }] } }; }

test("parseSessionFile: meta + messages mirror SDK semantics", () => {
  const raw = makeSessionRaw("s1", "/work", "2026-01-01T00:00:00.000Z", [
    userMsg("m1", "2026-01-01T00:00:01.000Z", "hello 中文"),
    asstMsg("m2", "2026-01-01T00:00:02.000Z", "hi back"),
    toolMsg("m3", "2026-01-01T00:00:03.000Z", "tool output"),
    { type: "session_info", id: "e", parentId: null, timestamp: "2026-01-01T00:00:04.000Z", name: "  我的会话  " },
  ]);
  const parsed = parseSessionFile("/tmp/f.jsonl", raw);
  assert.ok(parsed);
  assert.equal(parsed.meta.id, "s1");
  assert.equal(parsed.meta.name, "我的会话"); // trimmed
  assert.equal(parsed.meta.messageCount, 3); // all message entries
  assert.equal(parsed.meta.firstMessage, "hello 中文");
  assert.equal(parsed.meta.modified, "2026-01-01T00:00:02.000Z"); // assistant activity, toolResult excluded
  assert.equal(parsed.messages.length, 3);
  assert.equal(parsed.messages[1].model, "m1");
  assert.equal(parsed.messages[2].role, "toolResult");

  assert.equal(parseSessionFile("/x", "not json\n"), null);
});

test("parseSessionFile: toolCall-only assistant turns get a searchable fallback text", () => {
  const raw = makeSessionRaw("s1", "/work", "2026-01-01T00:00:00.000Z", [
    userMsg("m1", "2026-01-01T00:00:01.000Z", "do it"),
    { type: "message", id: "m2", parentId: null, timestamp: "2026-01-01T00:00:02.000Z", message: {
      role: "assistant", model: "m1",
      content: [
        { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls -la" } },
      ],
    } },
  ]);
  const parsed = parseSessionFile("/tmp/f.jsonl", raw);
  assert.ok(parsed);
  // toolCall-only assistant message is no longer dropped
  assert.equal(parsed.messages.length, 2);
  assert.match(parsed.messages[1].text, /bash/);
  assert.match(parsed.messages[1].text, /ls -la/);
  // messageCount matches what's actually indexed
  assert.equal(parsed.meta.messageCount, parsed.messages.length);
});

test("parseSessionFile: headerless (truncated) session still parses via filename fallback", () => {
  // first line is a message, no session header — pi crashed mid-write
  const raw = [
    JSON.stringify(userMsg("m1", "2026-01-01T00:00:01.000Z", "orphan message")),
  ].join("\n") + "\n";
  const p = parseSessionFile(
    "/home/pi/.pi/agent/sessions/--home-wind-workspace-pi-work--/2026-01-01T00-00-00-000Z_019fc755-5be7-7dff-9652-3437fce129bb.jsonl",
    raw,
  );
  assert.ok(p, "headerless file should still parse");
  assert.equal(p.meta.id, "019fc755-5be7-7dff-9652-3437fce129bb");
  assert.equal(p.messages.length, 1);
  assert.equal(p.meta.messageCount, 1);
});

test("session-index: incremental sync + FTS5 search (live)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-idx-"));
  try {
    const dbPath = join(dir, "index.sqlite");
    const index = openSessionIndex(dbPath);
    const f1 = join(dir, "a.jsonl");
    writeFileSync(f1, makeSessionRaw("s1", "/work", "2026-01-01T00:00:00.000Z", [
      userMsg("m1", "2026-01-01T00:00:01.000Z", "修复了登录页面的崩溃问题"),
      asstMsg("m2", "2026-01-01T00:00:02.000Z", "done"),
    ]));
    const f2 = join(dir, "b.jsonl");
    writeFileSync(f2, makeSessionRaw("s2", "/work", "2026-01-02T00:00:00.000Z", [
      userMsg("m1", "2026-01-02T00:00:01.000Z", "database connection test"),
    ]));

    const r1 = await index.sync([{ path: f1, id: "s1", cwd: "/work" }, { path: f2, id: "s2", cwd: "/work" }]);
    assert.equal(r1.indexed, 2);

    // FTS5 Chinese (≥3 chars)
    const zh = index.search("登录页面", 10);
    assert.equal(zh.length, 1);
    assert.equal(zh[0].sessionId, "s1");
    assert.ok(zh[0].text.includes("登录页面"));

    // English
    const en = index.search("database", 10);
    assert.equal(en.length, 1);
    assert.equal(en[0].sessionId, "s2");

    // 2-char LIKE fallback
    const two = index.search("修复", 10);
    assert.equal(two.length, 1);

    // second sync is a no-op (unchanged)
    const r2 = await index.sync([{ path: f1, id: "s1", cwd: "/work" }, { path: f2, id: "s2", cwd: "/work" }]);
    assert.equal(r2.indexed, 0);

    // changed file re-indexed（mtime 拨老过静默窗：活跃写入期 sync 会跳过，
    // 静默后才收敛——生产防高频全量重索引阻塞事件循环）
    appendFileSync(f1, JSON.stringify(userMsg("m3", "2026-01-01T00:00:09.000Z", "新增的消息内容 abc")) + "\n");
    utimesSync(f1, new Date(Date.now() - 61_000), new Date(Date.now() - 61_000));
    const r3 = await index.sync([{ path: f1, id: "s1", cwd: "/work" }, { path: f2, id: "s2", cwd: "/work" }]);
    assert.equal(r3.indexed, 1);
    assert.equal(index.search("abc", 10).length, 1);

    index.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session-index: refreshExtTimestamps 只前进 modified/name，不动消息内容", () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-idx-"));
  try {
    const index = openSessionIndex(join(dir, "index.sqlite"));
    const agent = "zcode";
    const sid = "sess_x";
    const id = `${agent}:${sid}`;
    index.upsertExtParsed(agent, sid, "/tmp/x.db#session:sess_x", {
      meta: {
        path: "/tmp/x.db#session:sess_x", id: sid, cwd: "/work", name: "旧标题",
        created: "2026-01-01T00:00:00.000Z", modified: "2026-01-01T00:00:00.000Z",
        messageCount: 1, firstMessage: "hi", lastMessage: "hi",
      },
      messages: [{ entryId: "1", role: "user", ts: null, model: undefined, provider: undefined, toolName: undefined, text: "hi" }],
    });
    // 未前进（time < 现有 modified）→ 不写
    assert.equal(index.refreshExtTimestamps(agent, [{ sid, timeUpdatedMs: Date.parse("2026-01-01T00:00:00.000Z") - 1000 }]), 0);
    // 前进 → 只改 modified/name，消息内容保持
    const newer = Date.parse("2026-01-02T00:00:00.000Z");
    assert.equal(index.refreshExtTimestamps(agent, [{ sid, timeUpdatedMs: newer, title: "新标题" }]), 1);
    const row = index.getSession(id);
    assert.equal(row.modified, "2026-01-02T00:00:00.000Z");
    assert.equal(row.name, "新标题");
    assert.equal(row.messageCount, 1, "message_count 不被 touch");
    assert.equal(row.lastMessage, "hi", "last_message 不被 touch");
    // 未入索引的行 → 跳过
    assert.equal(index.refreshExtTimestamps(agent, [{ sid: "sess_noexist", timeUpdatedMs: newer }]), 0);
    index.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session-index: archived sessions survive live-file removal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-idx-"));
  try {
    const index = openSessionIndex(join(dir, "index.sqlite"));
    const f = join(dir, "a.jsonl");
    writeFileSync(f, makeSessionRaw("s1", "/work", "2026-01-01T00:00:00.000Z", [
      userMsg("m1", "2026-01-01T00:00:01.000Z", "archived content word"),
    ]));
    await index.sync([{ path: f, id: "s1", cwd: "/work" }]);
    index.markArchived("pkg.pwarc", ["s1"]);
    rmSync(f); // original deleted by the archive pipeline

    // sync with the file gone — archived row must survive
    await index.sync([]);
    const row = index.getSession("s1");
    assert.ok(row);
    assert.equal(row.archived, 1);
    assert.equal(row.archiveRef, "pkg.pwarc");
    assert.equal(index.search("archived", 10).length, 1); // still searchable

    // non-archived removal drops the row
    const f2 = join(dir, "b.jsonl");
    writeFileSync(f2, makeSessionRaw("s2", "/work", "2026-01-02T00:00:00.000Z", [userMsg("m1", "2026-01-02T00:00:01.000Z", "temp")]));
    await index.sync([{ path: f2, id: "s2", cwd: "/work" }]);
    rmSync(f2);
    await index.sync([]);
    assert.equal(index.getSession("s2"), undefined);

    index.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restoreToLive: archived row flips back live WITHOUT dropping messages/FTS (search works instantly)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-rst-"));
  try {
    const index = openSessionIndex(join(dir, "index.sqlite"));
    const f = join(dir, "a.jsonl");
    writeFileSync(f, makeSessionRaw("s1", "/work", "2026-01-01T00:00:00.000Z", [
      userMsg("m1", "2026-01-01T00:00:01.000Z", "restored content keyword"),
    ]));
    await index.sync([{ path: f, id: "s1", cwd: "/work" }]);
    index.markArchived("pkg.pwarc", ["s1"]);
    rmSync(f);

    // archive round-trip: file written back byte-identical → flip to live
    writeFileSync(f, makeSessionRaw("s1", "/work", "2026-01-01T00:00:00.000Z", [
      userMsg("m1", "2026-01-01T00:00:01.000Z", "restored content keyword"),
    ]));
    index.restoreToLive("s1", f);
    const row = index.getSession("s1");
    assert.equal(row.archived, 0);
    assert.equal(row.path, f);
    assert.equal(row.archiveRef, null);
    // messages + FTS survive — search must hit immediately (no sync needed)
    assert.equal(index.search("restored", 10).length, 1);
    const meta = index.lastMeta("s1");
    assert.equal(meta.role, "user");
    assert.equal(meta.model, null);

    index.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(".pwarc: write → random-access extract → sha256 verify → originals deleted", () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-arc-"));
  try {
    const src = join(dir, "src");
    mkdirSync(src);
    const f1 = join(src, "a.jsonl");
    const raw1 = makeSessionRaw("s1", "/work", "2026-01-01T00:00:00.000Z", [userMsg("m1", "2026-01-01T00:00:01.000Z", "alpha")]);
    writeFileSync(f1, raw1);
    const f2 = join(src, "b.jsonl");
    const raw2 = makeSessionRaw("s2", "/work", "2026-01-02T00:00:00.000Z", [userMsg("m1", "2026-01-02T00:00:01.000Z", "beta")]);
    writeFileSync(f2, raw2);

    const pkg = join(dir, "state", "archive", "out.pwarc");
    const { entries } = writeArchive(pkg, [
      { path: f1, sessionId: "s1", cwd: "/work", modified: "2026-01-01T00:00:00.000Z", sizeBytes: raw1.length, ageDays: 300 },
      { path: f2, sessionId: "s2", cwd: "/work", modified: "2026-01-02T00:00:00.000Z", sizeBytes: raw2.length, ageDays: 200 },
    ]);
    assert.equal(entries.length, 2);
    assert.ok(existsSync(pkg));

    // manifest round-trip
    const m = readArchiveManifest(pkg);
    assert.equal(m.files.length, 2);

    // findEntry scans the packages dir for a session
    const found = findEntry(join(dir, "state", "archive"), "s1");
    assert.equal(found.entry.sessionId, "s1");
    assert.equal(found.entry.sha256.length, 64);

    // extract to cache + integrity
    const cacheFile = extractToCache(cfgOf(dir), "s1");
    assert.ok(cacheFile);
    assert.equal(readFileSync(cacheFile, "utf8"), raw1);

    // compressed size < raw (brotli works)
    assert.ok(entries[0].brotliSize < entries[0].size);

    // clear cache
    assert.equal(clearCache(cfgOf(dir)) >= 1, true);

    // delete originals
    assert.equal(deleteOriginals([f1, f2]), 2);
    assert.equal(existsSync(f1), false);

    // package naming
    const name = packageNameFor([{ path: f1, sessionId: "s1", cwd: "/work/x", modified: "2026-03-15T00:00:00.000Z", sizeBytes: 1, ageDays: 1 }]);
    assert.match(name, /^work-x-2026-03-[0-9a-f]{8}\.pwarc$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeFromArchive: rewrite keeps survivors verbatim, emptied package removed", () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-rm-"));
  try {
    const src = join(dir, "src");
    mkdirSync(src);
    const mk = (n, sid, text) => {
      const p = join(src, n);
      const raw = makeSessionRaw(sid, "/work", "2026-01-01T00:00:00.000Z", [userMsg("m1", "2026-01-01T00:00:01.000Z", text)]);
      writeFileSync(p, raw);
      return { path: p, sessionId: sid, cwd: "/work", modified: "2026-01-01T00:00:00.000Z", sizeBytes: raw.length, ageDays: 300 };
    };
    const pkg = join(dir, "state", "archive", "out.pwarc");
    const c1 = mk("a.jsonl", "s1", "keep me");
    const c2 = mk("b.jsonl", "s2", "remove me");
    const c3 = mk("c.jsonl", "s3", "also keep");
    writeArchive(pkg, [c1, c2, c3]);

    // remove the middle entry
    assert.equal(removeFromArchive(cfgOf(dir), "s2"), true);
    // gone from the manifest, survivors intact and byte-identical after extraction
    assert.equal(findEntry(join(dir, "state", "archive"), "s2"), null);
    for (const [sid, raw] of [["s1", readFileSync(c1.path, "utf8")], ["s3", readFileSync(c3.path, "utf8")]]) {
      const hit = findEntry(join(dir, "state", "archive"), sid);
      assert.ok(hit, `${sid} survives`);
      const cache = extractToCache(cfgOf(dir), sid);
      assert.ok(cache);
      assert.equal(readFileSync(cache, "utf8"), raw);
    }
    // unknown id → false
    assert.equal(removeFromArchive(cfgOf(dir), "nope"), false);

    // removing the last two entries empties + deletes the package
    assert.equal(removeFromArchive(cfgOf(dir), "s1"), true);
    assert.equal(removeFromArchive(cfgOf(dir), "s3"), true);
    assert.equal(existsSync(pkg), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restoreFromArchive: archived file returns to live path, package entry gone", () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-restore-"));
  try {
    const src = join(dir, "src");
    mkdirSync(src);
    const f1 = join(src, "a.jsonl");
    const raw1 = makeSessionRaw("s1", "/work", "2026-01-01T00:00:00.000Z", [userMsg("m1", "2026-01-01T00:00:01.000Z", "restore me")]);
    writeFileSync(f1, raw1);
    const f2 = join(src, "b.jsonl");
    const raw2 = makeSessionRaw("s2", "/work", "2026-01-02T00:00:00.000Z", [userMsg("m1", "2026-01-02T00:00:01.000Z", "stays archived")]);
    writeFileSync(f2, raw2);
    const pkg = join(dir, "state", "archive", "out.pwarc");
    writeArchive(pkg, [
      { path: f1, sessionId: "s1", cwd: "/work", modified: "2026-01-01T00:00:00.000Z", sizeBytes: raw1.length, ageDays: 300 },
      { path: f2, sessionId: "s2", cwd: "/work", modified: "2026-01-02T00:00:00.000Z", sizeBytes: raw2.length, ageDays: 300 },
    ]);
    unlinkSync(f1); unlinkSync(f2); // archived = originals deleted

    // restore s1: file reappears byte-identical, s2 stays archived
    const restored = restoreFromArchive(cfgOf(dir), "s1");
    assert.equal(restored, f1);
    assert.ok(existsSync(f1));
    assert.equal(readFileSync(f1, "utf8"), raw1);
    assert.equal(existsSync(f2), false);
    assert.equal(findEntry(join(dir, "state", "archive"), "s1"), null);
    const kept = findEntry(join(dir, "state", "archive"), "s2");
    assert.ok(kept);
    // unknown id → null
    assert.equal(restoreFromArchive(cfgOf(dir), "nope"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectCandidates: excludes running, includes old/oversized", () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-can-"));
  try {
    const now = new Date();
    const oldTs = new Date(now.getTime() - 200 * 86400000).toISOString();
    const freshTs = now.toISOString();
    const fOld = join(dir, "old.jsonl");
    writeFileSync(fOld, makeSessionRaw("old", "/w", oldTs, [userMsg("m1", oldTs, "x")]));
    const fRun = join(dir, "run.jsonl");
    writeFileSync(fRun, makeSessionRaw("running", "/w", oldTs, [userMsg("m1", oldTs, "x")]));
    const fFresh = join(dir, "fresh.jsonl");
    writeFileSync(fFresh, makeSessionRaw("fresh", "/w", freshTs, [userMsg("m1", freshTs, "x")]));
    const sessions = [
      { id: "old", cwd: "/w", modified: oldTs, path: fOld },
      { id: "running", cwd: "/w", modified: oldTs, path: fRun },
      { id: "fresh", cwd: "/w", modified: freshTs, path: fFresh },
    ];
    const out = collectCandidates(sessions, new Set(["running"]), { ageDays: 90, maxLiveSizeMb: 20 });
    // only old qualifies; running excluded; fresh excluded
    assert.deepEqual(out.map((c) => c.sessionId), ["old"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
