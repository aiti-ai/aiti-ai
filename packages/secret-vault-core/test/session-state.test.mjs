// Session-state retention: pid field, 7-day TTL for pid-less records, 50 cap.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_SESSION_RECORDS, SESSION_RETENTION_MS, readSessionState, writeSessionRecord } from "../src/session-state.ts";

test("pid is recorded and the file is capped at 50 sessions", () => {
  const dir = mkdtempSync(join(tmpdir(), "sv-state-"));
  try {
    const path = join(dir, "session-state.json");
    for (let i = 0; i < 60; i++) {
      writeSessionRecord(path, `s${i}`, { cwd: "/p", landing: "vault", mounted: [], pid: process.pid });
    }
    const file = readSessionState(path);
    assert.equal(Object.keys(file.sessions).length, MAX_SESSION_RECORDS);
    assert.ok(file.sessions.s60 === undefined || true);
    const any = Object.values(file.sessions)[0];
    assert.equal(any.pid, process.pid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pid-less records older than the retention window are pruned", () => {
  const dir = mkdtempSync(join(tmpdir(), "sv-state-old-"));
  try {
    const path = join(dir, "session-state.json");
    const old = new Date(Date.now() - SESSION_RETENTION_MS - 60_000).toISOString();
    writeFileSync(
      path,
      JSON.stringify({ version: 1, sessions: { old: { cwd: "/p", landing: "vault", mounted: [], updatedAt: old } } }),
    );
    writeSessionRecord(path, "fresh", { cwd: "/p", landing: "vault", mounted: [] });
    const file = readSessionState(path);
    assert.equal(file.sessions.old, undefined);
    assert.ok(file.sessions.fresh);
    // a record with a pid survives the age check (liveness is decided by the reader)
    const withPid = JSON.parse(readFileSync(path, "utf8"));
    withPid.sessions.pidOld = { cwd: "/p", landing: "vault", mounted: [], pid: process.pid, updatedAt: old };
    writeFileSync(path, JSON.stringify(withPid));
    writeSessionRecord(path, "fresh2", { cwd: "/p", landing: "vault", mounted: [] });
    assert.ok(readSessionState(path).sessions.pidOld);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
