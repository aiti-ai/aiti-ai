/**
 * hasLiveDetachedRuns -- unit tests for liveness of upstream pi-subagents detached runs.
 * Temp-dir injection: PI_SUBAGENTS_TEST_TMPDIR? No -- hasLiveDetachedRuns reads the real
 * os.tmpdir(), so the tests land in the real tmpdir under a random scope dir name
 * (pi-subagents-test-<rand>) and clean up afterwards.
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

test("live run: state=running + sessionId matching a file path + pid alive -> true", () => {
  const dir = makeScope();
  const sessionFile = join(dir, "parent.jsonl");
  writeRun(dir, randomUUID(), { state: "running", sessionId: sessionFile, pid: process.pid });
  assert.equal(hasLiveDetachedRuns(sessionFile, "sess-uuid"), true);
});

test("live run: sessionId matches a bare uuid (session not yet persisted) -> true", () => {
  const dir = makeScope();
  writeRun(dir, randomUUID(), { state: "queued", sessionId: "bare-uuid", pid: process.pid });
  assert.equal(hasLiveDetachedRuns("", "bare-uuid"), true);
});

test("terminal-state runs are not live (complete/failed/paused)", () => {
  const dir = makeScope();
  const sessionFile = join(dir, "p.jsonl");
  writeRun(dir, randomUUID(), { state: "complete", sessionId: sessionFile, pid: process.pid });
  writeRun(dir, randomUUID(), { state: "failed", sessionId: sessionFile, pid: process.pid });
  writeRun(dir, randomUUID(), { state: "paused", sessionId: sessionFile, pid: process.pid });
  assert.equal(hasLiveDetachedRuns(sessionFile, "x"), false);
});

test("dead pid -> not live (runner is gone; the stale reconciler cleans up)", () => {
  const dir = makeScope();
  const sessionFile = join(dir, "p.jsonl");
  // pid 1 always exists? A huge nonexistent pid is safer: above 2^28 there is usually no process
  writeRun(dir, randomUUID(), { state: "running", sessionId: sessionFile, pid: 2147483000 });
  assert.equal(hasLiveDetachedRuns(sessionFile, "x"), false);
});

test("state=running without a pid -> conservatively treated as live", () => {
  const dir = makeScope();
  const sessionFile = join(dir, "p.jsonl");
  writeRun(dir, randomUUID(), { state: "running", sessionId: sessionFile });
  assert.equal(hasLiveDetachedRuns(sessionFile, "x"), true);
});

test("live run for an unrelated session -> false (someone else's run must not extend my lifetime)", () => {
  const dir = makeScope();
  writeRun(dir, randomUUID(), { state: "running", sessionId: "/other/session/file.jsonl", pid: process.pid });
  assert.equal(hasLiveDetachedRuns("/mine/session.jsonl", "mine-uuid"), false);
});

test("empty identity arguments -> false (no global scan)", () => {
  const dir = makeScope();
  writeRun(dir, randomUUID(), { state: "running", sessionId: "/any.jsonl", pid: process.pid });
  assert.equal(hasLiveDetachedRuns("", ""), false);
});

test("directories with missing/corrupt status.json do not block the verdict", () => {
  const dir = makeScope();
  const sessionFile = join(dir, "p.jsonl");
  const broken = join(dir, "async-subagent-runs", "broken-run");
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, "status.json"), "{ not json");
  writeRun(dir, randomUUID(), { state: "running", sessionId: sessionFile, pid: process.pid });
  assert.equal(hasLiveDetachedRuns(sessionFile, "x"), true);
});

test("no pi-subagents directory at all -> false", () => {
  assert.equal(hasLiveDetachedRuns("/none/file.jsonl", "none-uuid"), false);
});

test("clean up temp scopes", () => {
  for (const dir of CLEANUPS) rmSync(dir, { recursive: true, force: true });
  assert.ok(true);
});
