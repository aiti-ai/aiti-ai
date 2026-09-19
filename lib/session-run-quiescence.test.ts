/**
 * session-run-quiescence — cross-instance single-writer checks.
 *
 * Semantics: if size/mtime changed between two samples of the file (700ms window) = actively
 * being written → throw; a quiet file / missing file → pass. Real scenario: another pi-web
 * instance spawns a child process streaming writes to the same session jsonl (an orphan run,
 * invisible to this instance's in-memory state).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, appendFileSync, statSync, existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSessionFileQuiescent } from "./session-run-quiescence.ts";

function tmpFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "quiescence-"));
  const p = join(dir, name);
  writeFileSync(p, "{}\n");
  return p;
}

test("quiet file → passes", async () => {
  const p = tmpFile("quiet.jsonl");
  await assertSessionFileQuiescent(p); // passing = no throw
  assert.ok(existsSync(p));
});

test("concurrent writes within the sampling window → throws (orphan-run scenario)", async () => {
  const p = tmpFile("live.jsonl");
  // Appends start after 300ms (a change is guaranteed to be sampled within the 700ms window)
  const timer = setInterval(() => {
    try { appendFileSync(p, JSON.stringify({ type: "message", n: Date.now() }) + "\n"); } catch { /* */ }
  }, 150);
  await assert.rejects(() => assertSessionFileQuiescent(p), /actively written/);
  clearInterval(timer);
});

test("missing file → treated as quiet and passes", async () => {
  await assertSessionFileQuiescent(join(tmpdir(), "no-such-file.jsonl"));
});

test("delete race: file vanishes within the window → treated as quiet and passes (does not block fork)", async () => {
  const p = tmpFile("vanish.jsonl");
  const timer = setTimeout(() => { try { import("node:fs").then(fs => fs.rmSync(p)); } catch { /* */ } }, 300);
  await assert.doesNotReject(() => assertSessionFileQuiescent(p));
  clearTimeout(timer);
});

test("statSync sampling consistency: passes right after writes stop", async () => {
  const p = tmpFile("settle.jsonl");
  appendFileSync(p, "x\n");
  const before = statSync(p).mtimeMs;
  await assertSessionFileQuiescent(p);
  assert.equal(statSync(p).mtimeMs, before);
});
