/**
 * Incremental session-list scanning tests (§5.4).
 * Run: node --experimental-strip-types --test lib/session-reader-incremental.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, existsSync, readFileSync, statSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

async function loadSubject() {
  const { scanSessionsFromRoot, deriveSessionFileInfo } = await import("./session-reader.ts");
  return { scanSessionsFromRoot, deriveSessionFileInfo };
}

function writeSession(root, cwdName, file, header, messages) {
  const dir = join(root, cwdName);
  mkdirSync(dir, { recursive: true });
  const lines = [JSON.stringify(header), ...messages.map((m) => JSON.stringify(m))];
  writeFileSync(join(dir, file), lines.join("\n") + "\n");
  return join(dir, file);
}

function sessionHeader(id, cwd, ts) {
  return { type: "session", version: 3, id, timestamp: ts, cwd };
}

test("scanSessionsFromRoot: full parse + fields match SDK semantics", async () => {
  const { scanSessionsFromRoot } = await loadSubject();
  const root = mkdtempSync(join(tmpdir(), "pi-scan-"));
  try {
    writeSession(root, "--a--", "1_1.jsonl", sessionHeader("s1", "/work/a", "2026-01-01T00:00:00.000Z"), [
      { type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hello world" } },
      { type: "message", id: "m2", parentId: "m1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi back" }] } },
    ]);
    writeSession(root, "--b--", "2_2.jsonl", sessionHeader("s2", "/work/b", "2026-01-02T00:00:00.000Z"), [
      { type: "message", id: "m1", parentId: null, timestamp: "2026-01-02T00:00:03.000Z", message: { role: "user", content: [{ type: "text", text: "first user" }] } },
      { type: "message", id: "m2", parentId: "m1", timestamp: "2026-01-02T00:00:04.000Z", message: { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "tool output" }] } },
    ]);

    const infos = await scanSessionsFromRoot(root);
    assert.equal(infos.length, 2);

    const a = infos.find((i) => i.id === "s1");
    assert.equal(a.cwd, "/work/a");
    assert.equal(a.messageCount, 2);
    assert.equal(a.firstMessage, "hello world");
    assert.equal(a.modified.toISOString(), "2026-01-01T00:00:02.000Z"); // last activity = assistant ts

    const b = infos.find((i) => i.id === "s2");
    assert.equal(b.messageCount, 2); // toolResult counts as a message entry
    assert.equal(b.firstMessage, "first user");
    assert.equal(b.modified.toISOString(), "2026-01-02T00:00:03.000Z"); // toolResult does NOT bump activity

    // sorted modified desc
    assert.equal(infos[0].id, "s2");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("incremental: unchanged files hit cache, changed file re-parsed, deleted pruned", async () => {
  const { scanSessionsFromRoot } = await loadSubject();
  const root = mkdtempSync(join(tmpdir(), "pi-scan-"));
  try {
    const p1 = writeSession(root, "--a--", "1_1.jsonl", sessionHeader("s1", "/work/a", "2026-01-01T00:00:00.000Z"), [
      { type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hello" } },
    ]);
    writeSession(root, "--b--", "2_2.jsonl", sessionHeader("s2", "/work/b", "2026-01-02T00:00:00.000Z"), [
      { type: "message", id: "m1", parentId: null, timestamp: "2026-01-02T00:00:01.000Z", message: { role: "user", content: "world" } },
    ]);

    const first = await scanSessionsFromRoot(root);
    assert.equal(first.length, 2);
    assert.ok(existsSync(join(root, "session_list_cache.json")));

    // Modify s1 by appending a message (mtime + size change)
    appendFileSync(p1, JSON.stringify({
      type: "message", id: "m2", parentId: "m1", timestamp: "2026-01-01T00:00:05.000Z",
      message: { role: "user", content: "second message" },
    }) + "\n");

    const second = await scanSessionsFromRoot(root);
    const a = second.find((i) => i.id === "s1");
    assert.equal(a.messageCount, 2);
    assert.equal(a.firstMessage, "hello"); // still first user text
    assert.equal(a.modified.toISOString(), "2026-01-01T00:00:05.000Z");

    // Delete s2
    rmSync(join(root, "--b--"), { recursive: true, force: true });
    const third = await scanSessionsFromRoot(root);
    assert.deepEqual(third.map((i) => i.id), ["s1"]);
    const cache = JSON.parse(readFileSync(join(root, "session_list_cache.json"), "utf8"));
    assert.equal(Object.keys(cache.files).length, 1); // pruned
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("incremental: corrupt/missing cache falls back to full scan", async () => {
  const { scanSessionsFromRoot } = await loadSubject();
  const root = mkdtempSync(join(tmpdir(), "pi-scan-"));
  try {
    writeSession(root, "--a--", "1_1.jsonl", sessionHeader("s1", "/work/a", "2026-01-01T00:00:00.000Z"), [
      { type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hello" } },
    ]);
    writeFileSync(join(root, "session_list_cache.json"), "{{{corrupt");
    const infos = await scanSessionsFromRoot(root);
    assert.equal(infos.length, 1);
    assert.equal(infos[0].firstMessage, "hello");
    // cache rebuilt
    assert.ok(JSON.parse(readFileSync(join(root, "session_list_cache.json"), "utf8")).files);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deriveSessionFileInfo vs SessionManager.listAll agree on the same files", async () => {
  const { deriveSessionFileInfo } = await loadSubject();
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const root = mkdtempSync(join(tmpdir(), "pi-scan-"));
  try {
    const files = [];
    files.push(writeSession(root, "--a--", "1_1.jsonl", sessionHeader("s1", "/work/a", "2026-01-01T00:00:00.000Z"), [
      { type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hello" } },
      { type: "message", id: "m2", parentId: "m1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "back" }] } },
    ]));
    files.push(writeSession(root, "--b--", "2_2.jsonl", sessionHeader("s2", "/work/b", "2026-01-02T00:00:00.000Z"), [
      { type: "message", id: "m1", parentId: null, timestamp: "2026-01-02T00:00:03.000Z", message: { role: "user", content: "hi" } },
    ]));

    const sdkInfos = await SessionManager.listAll(join(root, "--a--"));
    const sdkInfosB = await SessionManager.listAll(join(root, "--b--"));
    assert.equal(sdkInfos.length, 1);
    assert.equal(sdkInfosB.length, 1);
    for (const infos of [sdkInfos, sdkInfosB]) {
      const f = infos[0].path;
      const mine = deriveSessionFileInfo(f);
      const sdk = infos[0];
      assert.ok(mine && sdk, `both parsed for ${f}`);
      assert.equal(mine.id, sdk.id);
      assert.equal(mine.cwd, sdk.cwd);
      assert.equal(mine.name, sdk.name);
      assert.equal(mine.messageCount, sdk.messageCount);
      assert.equal(mine.firstMessage, sdk.firstMessage);
      assert.equal(mine.modified.getTime(), sdk.modified.getTime());
      assert.equal(mine.created.getTime(), sdk.created.getTime());
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("offset incremental: equal-length header cwd rewrite is absorbed (move in place, size unchanged)", async () => {
  // Incident regression: when a move rewrites header.cwd in place with an equal-length
  // replacement (same-length workspace dir names), size is unchanged and only mtime
  // changes -- incremental parsing that only checks size>=offset would misread this as
  // "zero appends" and keep the old cwd; from then on the cache entry's mtime/size match
  // the file exactly and the session stays permanently stuck with its old workspace.
  const { scanSessionsFromRoot } = await loadSubject();
  const root = mkdtempSync(join(tmpdir(), "pi-scan-"));
  try {
    const p1 = writeSession(root, "--a--", "1_1.jsonl", sessionHeader("s1", "/work/aaa", "2026-01-01T00:00:00.000Z"), [
      { type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hello" } },
    ]);
    const first = await scanSessionsFromRoot(root);
    assert.equal(first.find((i) => i.id === "s1").cwd, "/work/aaa");

    // move-style rewrite: whole file rewritten, header.cwd replaced with equal length,
    // message body byte-identical (size exactly the same)
    const lines = [
      JSON.stringify(sessionHeader("s1", "/work/bbb", "2026-01-01T00:00:00.000Z")),
      JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hello" } }),
    ];
    const before = statSync(p1);
    writeFileSync(p1, lines.join("\n") + "\n");
    assert.equal(statSync(p1).size, before.size); // precondition: equal length
    const bumped = new Date(before.mtimeMs + 60_000);
    utimesSync(p1, bumped, bumped); // ensure mtime changes (a write within the same millisecond would hit the cache)

    const second = await scanSessionsFromRoot(root);
    const a = second.find((i) => i.id === "s1");
    assert.equal(a.cwd, "/work/bbb"); // header rewrite absorbed, old cwd no longer reused
    assert.equal(a.messageCount, 1); // message body unchanged

    // Disk cache corrected in sync (no stale cwd left behind)
    const cache = JSON.parse(readFileSync(join(root, "session_list_cache.json"), "utf8"));
    assert.equal(Object.values(cache.files)[0].info.cwd, "/work/bbb");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("offset incremental: same-size rewrite with different session id falls back to full parse", async () => {
  const { scanSessionsFromRoot } = await loadSubject();
  const root = mkdtempSync(join(tmpdir(), "pi-scan-"));
  try {
    const p1 = writeSession(root, "--a--", "1_1.jsonl", sessionHeader("s1", "/work/a", "2026-01-01T00:00:00.000Z"), [
      { type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hello" } },
    ]);
    await scanSessionsFromRoot(root);

    // Same-size rewrite as another session (id changed) -> base identity mismatch, fall back to full parse
    const lines = [
      JSON.stringify(sessionHeader("s2", "/work/a", "2026-01-02T00:00:00.000Z")),
      JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-01-02T00:00:01.000Z", message: { role: "user", content: "other session same size" } }),
    ];
    writeFileSync(p1, lines.join("\n") + "\n");
    const st = statSync(p1);
    const bumped = new Date(st.mtimeMs + 60_000);
    utimesSync(p1, bumped, bumped);

    const infos = await scanSessionsFromRoot(root);
    const s2 = infos.find((i) => i.id === "s2");
    assert.ok(s2, "new session id surfaced");
    assert.equal(s2.firstMessage, "other session same size");
    assert.equal(infos.find((i) => i.id === "s1"), undefined); // old id no longer appears
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// Append-offset incremental parsing (active-session rescan freeze fix)
// ============================================================================

test("offset incremental: session_info rename appended later wins (mirrors full parse)", async () => {
  const { scanSessionsFromRoot } = await loadSubject();
  const root = mkdtempSync(join(tmpdir(), "pi-scan-"));
  try {
    const p1 = writeSession(root, "--a--", "1_1.jsonl", sessionHeader("s1", "/work/a", "2026-01-01T00:00:00.000Z"), [
      { type: "session_info", id: "n1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", name: "first title" },
      { type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: "hello" } },
    ]);
    const first = await scanSessionsFromRoot(root);
    assert.equal(first.find((i) => i.id === "s1").name, "first title");

    appendFileSync(p1, JSON.stringify({
      type: "session_info", id: "n2", parentId: "n1", timestamp: "2026-01-01T00:00:06.000Z", name: "renamed",
    }) + "\n");
    const second = await scanSessionsFromRoot(root);
    assert.equal(second.find((i) => i.id === "s1").name, "renamed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("offset incremental: truncated/rewritten file falls back to full parse", async () => {
  const { scanSessionsFromRoot } = await loadSubject();
  const root = mkdtempSync(join(tmpdir(), "pi-scan-"));
  try {
    const p1 = writeSession(root, "--a--", "1_1.jsonl", sessionHeader("s1", "/work/a", "2026-01-01T00:00:00.000Z"), [
      { type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hello" } },
      { type: "message", id: "m2", parentId: "m1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "back" }] } },
    ]);
    await scanSessionsFromRoot(root);

    // Rewrite smaller (truncation) — offset base invalid, must full re-parse to correct fields
    const lines = [
      JSON.stringify(sessionHeader("s1", "/work/a", "2026-01-01T00:00:00.000Z")),
      JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "rewritten" } }),
    ];
    writeFileSync(p1, lines.join("\n") + "\n");

    const infos = await scanSessionsFromRoot(root);
    const a = infos.find((i) => i.id === "s1");
    assert.equal(a.messageCount, 1);
    assert.equal(a.firstMessage, "rewritten");
    assert.equal(a.modified.toISOString(), "2026-01-01T00:00:01.000Z");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("offset incremental: partial trailing line stays unparsed until completed", async () => {
  const { scanSessionsFromRoot } = await loadSubject();
  const root = mkdtempSync(join(tmpdir(), "pi-scan-"));
  try {
    const p1 = writeSession(root, "--a--", "1_1.jsonl", sessionHeader("s1", "/work/a", "2026-01-01T00:00:00.000Z"), [
      { type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hello" } },
    ]);
    await scanSessionsFromRoot(root);

    // Writer crash window: half a JSONL line without trailing \n
    const halfLine = JSON.stringify({
      type: "message", id: "m2", parentId: "m1", timestamp: "2026-01-01T00:00:05.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "half" }] },
    }).slice(0, 40);
    appendFileSync(p1, halfLine); // no \n, malformed

    let infos = await scanSessionsFromRoot(root);
    assert.equal(infos.find((i) => i.id === "s1").messageCount, 1); // half line not counted

    // Writer completes the line (appends the remainder + \n)
    const fullLine = JSON.stringify({
      type: "message", id: "m2", parentId: "m1", timestamp: "2026-01-01T00:00:05.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "half" }] },
    });
    appendFileSync(p1, fullLine.slice(halfLine.length) + "\n");
    infos = await scanSessionsFromRoot(root);
    assert.equal(infos.find((i) => i.id === "s1").messageCount, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("offset incremental: offset persisted in disk cache for cold-start rescan", async () => {
  const { scanSessionsFromRoot } = await loadSubject();
  const root = mkdtempSync(join(tmpdir(), "pi-scan-"));
  try {
    const p1 = writeSession(root, "--a--", "1_1.jsonl", sessionHeader("s1", "/work/a", "2026-01-01T00:00:00.000Z"), [
      { type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hello" } },
    ]);
    await scanSessionsFromRoot(root);

    const cache = JSON.parse(readFileSync(join(root, "session_list_cache.json"), "utf8"));
    const entry = Object.values(cache.files)[0];
    assert.equal(typeof entry.offset, "number");
    assert.equal(entry.offset, statSync(p1).size); // parsed to EOF
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lastRun: derived from the last assistant message (full + incremental parse)", async () => {
  const { scanSessionsFromRoot } = await loadSubject();
  const root = mkdtempSync(join(tmpdir(), "pi-scan-"));
  try {
    // s1: failed run (error message + errorMessage)
    const p1 = writeSession(root, "--a--", "1_1.jsonl", sessionHeader("s1", "/work/a", "2026-01-01T00:00:00.000Z"), [
      { type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "do it" } },
      { type: "message", id: "m2", parentId: "m1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Cannot read properties of undefined (reading 'totalTokens')" } },
    ]);
    // s2: aborted
    writeSession(root, "--b--", "2_2.jsonl", sessionHeader("s2", "/work/b", "2026-01-02T00:00:00.000Z"), [
      { type: "message", id: "m1", parentId: null, timestamp: "2026-01-02T00:00:01.000Z", message: { role: "user", content: "hi" } },
      { type: "message", id: "m2", parentId: "m1", timestamp: "2026-01-02T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "half..." }], stopReason: "aborted" } },
    ]);
    // s3: completed
    writeSession(root, "--c--", "3_3.jsonl", sessionHeader("s3", "/work/c", "2026-01-03T00:00:00.000Z"), [
      { type: "message", id: "m1", parentId: null, timestamp: "2026-01-03T00:00:01.000Z", message: { role: "user", content: "hi" } },
      { type: "message", id: "m2", parentId: "m1", timestamp: "2026-01-03T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } },
    ]);
    // s4: no assistant message -> no lastRun
    writeSession(root, "--d--", "4_4.jsonl", sessionHeader("s4", "/work/d", "2026-01-04T00:00:00.000Z"), [
      { type: "message", id: "m1", parentId: null, timestamp: "2026-01-04T00:00:01.000Z", message: { role: "user", content: "hi" } },
    ]);

    const infos = await scanSessionsFromRoot(root);
    const byId = new Map(infos.map((i) => [i.id, i]));
    assert.deepEqual(byId.get("s1").lastRun, {
      status: "failed",
      at: new Date("2026-01-01T00:00:02.000Z").toISOString(),
      error: "Cannot read properties of undefined (reading 'totalTokens')",
    });
    assert.equal(byId.get("s2").lastRun.status, "aborted");
    assert.equal(byId.get("s3").lastRun.status, "completed");
    assert.equal(byId.get("s4").lastRun, undefined);

    // Appending a new message -> incremental parse refreshes lastRun (the error is overwritten by a later successful run)
    appendFileSync(p1, JSON.stringify({
      type: "message", id: "m3", parentId: "m2", timestamp: "2026-01-01T00:00:09.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "retried fine" }], stopReason: "stop" },
    }) + "\n");
    const again = await scanSessionsFromRoot(root);
    const s1 = again.find((i) => i.id === "s1");
    assert.equal(s1.lastRun.status, "completed");
    assert.equal(s1.lastRun.at, new Date("2026-01-01T00:00:09.000Z").toISOString());

    // No new assistant in the incremental segment (only a user append) -> keep the previous lastRun
    appendFileSync(p1, JSON.stringify({
      type: "message", id: "m4", parentId: "m3", timestamp: "2026-01-01T00:00:10.000Z",
      message: { role: "user", content: "another question" },
    }) + "\n");
    const third = await scanSessionsFromRoot(root);
    assert.equal(third.find((i) => i.id === "s1").lastRun.status, "completed");

    // Cold start (cache re-read) also carries lastRun
    const cache = JSON.parse(readFileSync(join(root, "session_list_cache.json"), "utf8"));
    const entry = Object.values(cache.files).find((e) => e.info.id === "s1");
    assert.equal(entry.info.lastRun.status, "completed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
