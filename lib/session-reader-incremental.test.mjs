/**
 * Incremental session-list scanning tests (§5.4).
 * Run: node --experimental-strip-types --test lib/session-reader-incremental.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";

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
    for (const [dir, infos] of [[join(root, "--a--"), sdkInfos], [join(root, "--b--"), sdkInfosB]]) {
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
