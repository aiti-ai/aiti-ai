/**
 * cli-resolve.test — shared-layer behavior tests for which()/isExecutableFile (hardening P2-10 regression).
 * which now requires: the candidate is a file (directories don't count) + the POSIX executable bit +
 * Windows PATHEXT (this machine is Linux, so only the POSIX side is tested).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { which } from "./cli-resolve.ts";

function withPath(dirs, fn) {
  const saved = process.env.PATH;
  try {
    process.env.PATH = dirs.join(":");
    return fn();
  } finally {
    process.env.PATH = saved;
  }
}

test("which: executable file on PATH hits", () => {
  const dir = mkdtempSync(join(tmpdir(), "forkrpc-which-"));
  const bin = join(dir, "fakeforkbin");
  writeFileSync(bin, "#!/bin/sh\n");
  chmodSync(bin, 0o755);
  withPath([dir], () => assert.equal(which("fakeforkbin"), bin));
});

test("which: no executable bit / same-named directory / outside PATH all miss", () => {
  const dir = mkdtempSync(join(tmpdir(), "forkrpc-which-"));
  const noexec = join(dir, "fakeforkbin2");
  writeFileSync(noexec, "#!/bin/sh\n");
  chmodSync(noexec, 0o644);
  mkdirSync(join(dir, "fakeforkdir"));
  withPath([dir], () => {
    if (process.platform !== "win32") assert.equal(which("fakeforkbin2"), undefined, "a 644 file is not executable (POSIX executable-bit semantics; on win32 executability is by extension, so 644 is meaningless)");
    assert.equal(which("fakeforkdir"), undefined, "a directory is not an executable candidate");
    assert.equal(which("totally-absent-bin"), undefined);
  });
});
