import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Regression guard: the running-session linkage (sidebar spinner) was lost while merging plan-a-upstream —
// the upstream code deleted the notifyRunningChange() broadcast on the "normal prompt send" path,
// keeping only the queue/followUp path. Result: after sending a normal message isRunning flips true, but the SSE
// main channel (/api/agent/running/events) never broadcasts → the left session list shows no running marker.
// This file pins the two mandatory broadcasts (prompt start + finishPrompt end); if a merge deletes them again, this goes red immediately.
const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");

// Locate the span from the normal prompt branch (where pendingPromptCount is set) to finishPrompt
const promptBranch = source.slice(source.indexOf("let acceptPreflight"));

test("broadcasts a running change at prompt start (after pendingPromptCount is set)", () => {
  assert.match(
    source,
    /this\.pendingPromptCount \+= 1;\n\s+\/\/ Execution starts.*\n\s+notifyRunningChange\(\);/,
  );
});

test("broadcasts a running change when finishPrompt ends (running → idle)", () => {
  assert.match(
    source,
    /this\.notifyAgentRunCompleteIfIdle\(\);\n\s+\/\/ Running state changed.*\n\s+notifyRunningChange\(\);/,
  );
});

test("queue/followUp paths keep their running broadcasts too (not lost to this fix's changes)", () => {
  assert.match(source, /this\.promptRunning = true;\n\s+notifyRunningChange\(\);/);
  assert.match(source, /this\.pendingPromptCount \+= 1;\n\s+notifyRunningChange\(\);\s*\n\s+void this\.inner\.followUp/);
});

test("bash execution start and end also broadcast running changes", () => {
  // start: notifyRunningChange right before executeBash; end: in the finally block after const result
  assert.match(source, /notifyRunningChange\(\);\s*\n\s+const execution = this\.inner\.executeBash/);
  assert.match(source, /this\.resetIdleTimer\(\);\s*\n\s+invalidateSessionListCache\(\);\s*\n\s+\/\/ bash finished[^\n]*\n\s+notifyRunningChange\(\);/);
});

test("the subscribeRunningSessions listener mechanism (SSE main-channel infrastructure) still exists", () => {
  assert.match(source, /export function subscribeRunningSessions\(listener: \(ids: string\[\]\) => void\): \(\) => void/);
  assert.match(source, /export function notifyRunningChange\(\): void/);
});

// Regression guard 2 (2026-09-12): immediacy of the "running" state when resuming an old session.
// startRpcSession startup is heavy async work (extension loading + agent process/history/MCP, seconds to tens of seconds).
// Previously the running broadcast only happened after startup completed and the prompt was submitted → the left tree's spinner took ages to light up.
// Fix: count the sessionId into the starting set and broadcast right at startup (getRunningRpcSessionIds
// merges the starting set), with the IIFE finally removing it and broadcasting at the end. The next three tests guard this chain.

test("startRpcSession broadcasts running at the very start of an old-session startup (pre-broadcast)", () => {
  assert.match(
    source,
    /if \(!isNewSession\) \{\n\s+getStartingSessionIds\(\)\.add\(sessionId\);/,
  );
});

test("getRunningRpcSessionIds merges the starting set (spinner lights up immediately)", () => {
  assert.match(
    source,
    /for \(const id of getStartingSessionIds\(\)\) ids\.add\(id\);/,
  );
});

test("startup teardown (success/failure) removes from the starting set and broadcasts the exit in finally", () => {
  assert.match(
    source,
    /if \(getStartingSessionIds\(\)\.delete\(sessionId\)\) notifyRunningChange\(\);/,
  );
});

// Regression guard 3 (2026-09-12): immediacy of the new-session draft row.
// sm:session-created used to publish only after startup completed (tail of the IIFE) → the left
// tree's draft row waited out the entire startup (seconds to tens of seconds). sessionManagerId is
// synchronously available once pre-generated in SessionManager.create, so broadcast right at startup (after trackStartingSession, before the IIFE).
// Late 2026-09-12 consolidation: direct publishPageEvent calls converged into the notifySessionCreated helper
// (wide publishing via publishPageEventToBus goes through the event bus); the guard assertions were synced to the helper form.

test("new-session startup broadcasts sm:session-created at the very start (draft row appears immediately)", () => {
  assert.match(
    source,
    /if \(isNewSession\) \{\n\s+notifySessionCreated\(sessionManagerId, sessionCwd, "start"\);/,
  );
});

test("the startup-completion tail keeps its fallback broadcast (window where SSE isn't connected yet; same helper)", () => {
  assert.match(
    source,
    /if \(isNewSession\) \{\n\s+\/\/ Startup-completion tail fallback broadcast[\s\S]*?notifySessionCreated\(realSessionId, sessionCwd, "start"\);/,
  );
});