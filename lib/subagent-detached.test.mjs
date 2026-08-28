/**
 * hasLiveDetachedRuns —— 上游 pi-subagents detached run 判活单元测试。
 * 临时目录注入：用 PI_SUBAGENTS_TEST_TMPDIR？不——hasLiveDetachedRuns 读真实
 * os.tmpdir()，测试通过随机 scope 目录名（pi-subagents-test-<rand>）落真实 tmpdir，
 * 测后清理。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { hasLiveDetachedRuns } from "./subagent-detached.ts";

const CLEANUPS = [];
function makeScope() {
  const dir = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
  mkdirSync(join(dir, "async-subagent-runs"), { recursive: true });
  CLEANUPS.push(dir);
  return dir;
}
function writeRun(dir, runId, status) {
  const runDir = join(dir, "async-subagent-runs", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "status.json"), JSON.stringify(status));
}

test("活 run：state=running + sessionId 匹配文件路径 + pid 存活 → true", () => {
  const dir = makeScope();
  const sessionFile = join(dir, "parent.jsonl");
  writeRun(dir, randomUUID(), { state: "running", sessionId: sessionFile, pid: process.pid });
  assert.equal(hasLiveDetachedRuns(sessionFile, "sess-uuid"), true);
});

test("活 run：sessionId 匹配裸 uuid（未持久化会话）→ true", () => {
  const dir = makeScope();
  writeRun(dir, randomUUID(), { state: "queued", sessionId: "bare-uuid", pid: process.pid });
  assert.equal(hasLiveDetachedRuns("", "bare-uuid"), true);
});

test("终态 run 不算活（complete/failed/paused）", () => {
  const dir = makeScope();
  const sessionFile = join(dir, "p.jsonl");
  writeRun(dir, randomUUID(), { state: "complete", sessionId: sessionFile, pid: process.pid });
  writeRun(dir, randomUUID(), { state: "failed", sessionId: sessionFile, pid: process.pid });
  writeRun(dir, randomUUID(), { state: "paused", sessionId: sessionFile, pid: process.pid });
  assert.equal(hasLiveDetachedRuns(sessionFile, "x"), false);
});

test("pid 已死 → 不算活（runner 已亡，stale reconciler 兜底）", () => {
  const dir = makeScope();
  const sessionFile = join(dir, "p.jsonl");
  // pid 1 恒存在？用不存在的极大 pid 更稳：2^28 以上通常无进程
  writeRun(dir, randomUUID(), { state: "running", sessionId: sessionFile, pid: 2147483000 });
  assert.equal(hasLiveDetachedRuns(sessionFile, "x"), false);
});

test("state=running 但无 pid → 保守视为活", () => {
  const dir = makeScope();
  const sessionFile = join(dir, "p.jsonl");
  writeRun(dir, randomUUID(), { state: "running", sessionId: sessionFile });
  assert.equal(hasLiveDetachedRuns(sessionFile, "x"), true);
});

test("无匹配会话的活 run → false（别人的 run 不续我的命）", () => {
  const dir = makeScope();
  writeRun(dir, randomUUID(), { state: "running", sessionId: "/other/session/file.jsonl", pid: process.pid });
  assert.equal(hasLiveDetachedRuns("/mine/session.jsonl", "mine-uuid"), false);
});

test("空身份入参 → false（不做全局扫描）", () => {
  const dir = makeScope();
  writeRun(dir, randomUUID(), { state: "running", sessionId: "/any.jsonl", pid: process.pid });
  assert.equal(hasLiveDetachedRuns("", ""), false);
});

test("status.json 缺失/损坏的目录不阻断判定", () => {
  const dir = makeScope();
  const sessionFile = join(dir, "p.jsonl");
  const broken = join(dir, "async-subagent-runs", "broken-run");
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, "status.json"), "{ not json");
  writeRun(dir, randomUUID(), { state: "running", sessionId: sessionFile, pid: process.pid });
  assert.equal(hasLiveDetachedRuns(sessionFile, "x"), true);
});

test("无任何 pi-subagents 目录 → false", () => {
  assert.equal(hasLiveDetachedRuns("/none/file.jsonl", "none-uuid"), false);
});

test("清理临时 scope", () => {
  for (const dir of CLEANUPS) rmSync(dir, { recursive: true, force: true });
  assert.ok(true);
});
