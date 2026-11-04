/**
 * cli-resolve.test — 共享层 which()/isExecutableFile 行为测试（加固 P2-10 回归）。
 * which 现要求：候选是文件（目录不算）+ POSIX 可执行位 + Windows PATHEXT（本机 Linux 只测 POSIX 面）。
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

test("which：PATH 上的可执行文件命中", () => {
  const dir = mkdtempSync(join(tmpdir(), "forkrpc-which-"));
  const bin = join(dir, "fakeforkbin");
  writeFileSync(bin, "#!/bin/sh\n");
  chmodSync(bin, 0o755);
  withPath([dir], () => assert.equal(which("fakeforkbin"), bin));
});

test("which：无可执行位/目录同名/PATH 外 均不命中", () => {
  const dir = mkdtempSync(join(tmpdir(), "forkrpc-which-"));
  const noexec = join(dir, "fakeforkbin2");
  writeFileSync(noexec, "#!/bin/sh\n");
  chmodSync(noexec, 0o644);
  mkdirSync(join(dir, "fakeforkdir"));
  withPath([dir], () => {
    if (process.platform !== "win32") assert.equal(which("fakeforkbin2"), undefined, "644 文件不算可执行（POSIX 可执行位语义；win32 可执行性按扩展名，644 无意义）");
    assert.equal(which("fakeforkdir"), undefined, "目录不算可执行候选");
    assert.equal(which("totally-absent-bin"), undefined);
  });
});
