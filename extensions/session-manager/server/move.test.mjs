/**
 * session-manager · move 端点测试（发错文件夹的会话迁移）。
 * Run: node --experimental-strip-types --test server/move.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, basename } from "path";

const { api } = await import("./api.ts");

function makeCtx(configDir, core) {
  return { configDir, path: ["move"], searchParams: new URLSearchParams(), core };
}

function req(body) {
  return new Request("http://x/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeSessionFile(homeDir, cwd, sessionId) {
  // slug 对齐宿主 SDK（[/\\:] → -；win 盘符冒号一并清洗，lessons §0.3）——
  // 旧正则只洗 /，Windows 产出含 :\ 的非法目录名使夹具 mkdir 直接 ENOENT
  const slug = "--" + cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--";
  const dir = join(homeDir, ".pi", "agent", "sessions", slug);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
  writeFileSync(file, [
    JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd }),
    JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
    "",
  ].join("\n"));
  return file;
}

test("move: rewrites header cwd and relocates the file to the target project dir", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "sm-move-data-"));
  const homeDir = mkdtempSync(join(tmpdir(), "sm-move-home-"));
  const srcCwd = join(homeDir, "proj-a");
  const dstCwd = join(homeDir, "proj-b");
  mkdirSync(srcCwd); mkdirSync(dstCwd);
  const sid = "11111111-1111-4111-8111-111111111111";
  const oldPath = makeSessionFile(homeDir, srcCwd, sid);

  const ctx = makeCtx(configDir, {
    async listSessions() { return [{ id: sid, path: oldPath, cwd: srcCwd }]; },
    async getRunningSessionIds() { return []; },
    async getHomeDir() { return homeDir; },
  });

  // bad target → 400
  const bad = await api(req({ sessionId: sid, cwd: "/nonexistent-xyz-123" }), ctx);
  assert.equal(bad.status, 400);

  // running session → 409
  const runCtx = makeCtx(configDir, {
    async listSessions() { return [{ id: sid, path: oldPath, cwd: srcCwd }]; },
    async getRunningSessionIds() { return [sid]; },
    async getHomeDir() { return homeDir; },
  });
  const running = await api(req({ sessionId: sid, cwd: dstCwd }), runCtx);
  assert.equal(running.status, 409);

  // happy path
  const res = await api(req({ sessionId: sid, cwd: dstCwd }), ctx);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(!existsSync(oldPath), "old file should be gone");
  assert.ok(existsSync(body.path), "new file exists");
  const header = JSON.parse(readFileSync(body.path, "utf8").split("\n")[0]);
  assert.equal(header.cwd, dstCwd);
  assert.equal(header.id, sid, "session id preserved");
  // content lines preserved (header + 1 message + trailing newline)
  assert.equal(readFileSync(body.path, "utf8").trim().split("\n").length, 2);

  rmSync(configDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

test("move: refuses when target project has a same-name session file (no overwrite)", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "sm-move-data-"));
  const homeDir = mkdtempSync(join(tmpdir(), "sm-move-home-"));
  const srcCwd = join(homeDir, "proj-a");
  const dstCwd = join(homeDir, "proj-b");
  mkdirSync(srcCwd); mkdirSync(dstCwd);
  const sid = "22222222-2222-4222-8222-222222222222";
  const oldPath = makeSessionFile(homeDir, srcCwd, sid);

  // 目标项目预置同名文件（内容不同，模拟另一个会话）
  const victim = makeSessionFile(homeDir, dstCwd, sid);
  writeFileSync(victim, "{\"type\":\"session\",\"victim\":true}\n");

  const ctx = makeCtx(configDir, {
    async listSessions() { return [{ id: sid, path: oldPath, cwd: srcCwd }]; },
    async getRunningSessionIds() { return []; },
    async getHomeDir() { return homeDir; },
  });
  const res = await api(req({ sessionId: sid, cwd: dstCwd }), ctx);
  assert.equal(res.status, 409);
  assert.ok(existsSync(oldPath), "source untouched on conflict");
  assert.equal(readFileSync(victim, "utf8"), "{\"type\":\"session\",\"victim\":true}\n", "target file NOT overwritten");

  rmSync(configDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

test("move: in-place header rewrite keeps exactly one file (no self-unlink)", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "sm-move-data-"));
  const homeDir = mkdtempSync(join(tmpdir(), "sm-move-home-"));
  const cwdA = join(homeDir, "same");
  mkdirSync(cwdA);
  const sid = "33333333-3333-4333-8333-333333333333";
  const file = makeSessionFile(homeDir, cwdA, sid);

  const ctx = makeCtx(configDir, {
    async listSessions() { return [{ id: sid, path: file, cwd: cwdA }]; },
    async getRunningSessionIds() { return []; },
    async getHomeDir() { return homeDir; },
  });
  // cwd 相同但 header.cwd 过期（别名/历史遗留）→ 原地改写路径
  const res = await api(req({ sessionId: sid, cwd: cwdA }), ctx);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(existsSync(body.path), "file survives in-place rewrite");
  const files = readdirSync(dirname(body.path)).filter((f) => f.endsWith(".jsonl"));
  assert.deepEqual(files, [basename(body.path)], "exactly one session file, no duplicates");
  const header = JSON.parse(readFileSync(body.path, "utf8").split("\n")[0]);
  assert.equal(header.cwd, cwdA);

  rmSync(configDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});
