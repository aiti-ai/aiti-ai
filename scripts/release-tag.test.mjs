// release-tag.test.mjs — 发版守卫脚本：纯函数单测 + 临时 fixture 仓子进程端到端
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./release-tag.mjs", import.meta.url));
const { FORK_VERSION_PATTERN, parseReleaseVersion, nextForkNumber, planRelease } = await import(SCRIPT);

test("parseReleaseVersion: accepts X.Y.Z-aiti.N, rejects bare and malformed", () => {
  assert.deepEqual(parseReleaseVersion("0.16.0-aiti.1"), {
    version: "0.16.0-aiti.1",
    tag: "v0.16.0-aiti.1",
    parts: [0, 16, 0],
    fork: 1,
  });
  assert.equal(parseReleaseVersion("0.16.0"), null, "bare version refused (upstream semantics)");
  assert.equal(parseReleaseVersion("0.16.0-beta.1"), null, "other prerelease refused");
  assert.equal(parseReleaseVersion("0.16.0-aiti"), null);
  assert.equal(parseReleaseVersion("aiti-v0.16.0"), null, "prefix-style tag naming refused");
  assert.match(String(FORK_VERSION_PATTERN), /aiti/);
});

test("nextForkNumber: scans existing tags for the same upstream baseline", () => {
  const tags = ["v0.15.7", "v0.16.0-aiti.1", "v0.16.0-aiti.3", "v0.17.0-aiti.1"];
  assert.equal(nextForkNumber(tags, "0.16.0"), 4);
  assert.equal(nextForkNumber(tags, "0.18.0"), 1, "fresh baseline starts at 1");
  assert.equal(nextForkNumber([], "0.16.0"), 1);
});

test("planRelease: guards — bare version / existing tag / dirty tree", () => {
  assert.match(planRelease({ version: "0.16.0", tags: [], clean: true }).reason, /-aiti\.N/);
  assert.match(
    planRelease({ version: "0.16.0-aiti.1", tags: ["v0.16.0-aiti.1"], clean: true }).reason,
    /已存在/,
  );
  assert.match(planRelease({ version: "0.16.0-aiti.2", tags: [], clean: false }).reason, /工作树不干净/);
  const ok = planRelease({ version: "0.16.0-aiti.2", tags: ["v0.16.0-aiti.1"], clean: true });
  assert.deepEqual(ok, { ok: true, tag: "v0.16.0-aiti.2", version: "0.16.0-aiti.2" });
});

// ---- 子进程端到端：真实 git fixture 仓 ----

function makeFixtureRepo(t, version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-tag-fix-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@local");
  git("config", "user.name", "test");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fix", version }));
  git("add", ".");
  git("commit", "-qm", "init");
  return dir;
}

test("end-to-end dry-run: clean fixture passes and prints the tag", (t) => {
  const dir = makeFixtureRepo(t, "0.16.0-aiti.1");
  const out = execFileSync(process.execPath, [SCRIPT, "--dry-run"], { cwd: dir, encoding: "utf8" });
  assert.match(out, /tag=v0\.16\.0-aiti\.1/);
  assert.match(out, /--dry-run/);
});

test("end-to-end: bare package.json version is refused", (t) => {
  const dir = makeFixtureRepo(t, "0.16.0");
  let failed = false;
  try {
    execFileSync(process.execPath, [SCRIPT, "--dry-run"], { cwd: dir, encoding: "utf8" });
  } catch (e) {
    failed = true;
    assert.match(String(e.stderr), /-aiti\.N/);
  }
  assert.equal(failed, true, "bare version must exit non-zero");
});

test("end-to-end: dirty worktree refused unless --force", (t) => {
  const dir = makeFixtureRepo(t, "0.16.0-aiti.1");
  fs.writeFileSync(path.join(dir, "scratch.txt"), "uncommitted");
  assert.throws(
    () => execFileSync(process.execPath, [SCRIPT, "--dry-run"], { cwd: dir, encoding: "utf8" }),
    /工作树不干净/,
  );
  const out = execFileSync(process.execPath, [SCRIPT, "--dry-run", "--force"], { cwd: dir, encoding: "utf8" });
  assert.match(out, /tag=v0\.16\.0-aiti\.1/);
});

test("end-to-end: suggest suggests the next fork build number", (t) => {
  const dir = makeFixtureRepo(t, "0.16.0-aiti.1");
  const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  git("tag", "v0.16.0-aiti.1");
  git("tag", "v0.16.0-aiti.2");
  const out = execFileSync(process.execPath, [SCRIPT, "--suggest"], { cwd: dir, encoding: "utf8" });
  assert.match(out, /v0\.16\.0-aiti\.3/);
});
