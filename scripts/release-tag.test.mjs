// release-tag.test.mjs — 发版守卫脚本：纯函数单测 + 临时 fixture 仓子进程端到端
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./release-tag.mjs", import.meta.url));
const { FORK_VERSION_PATTERN, parseReleaseVersion, nextForkNumber, planRelease, checkNotesFile } = await import(SCRIPT);

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

test("checkNotesFile: missing / too short / TODO warn / clean pass", () => {
  assert.match(checkNotesFile(null).reason, /is missing/);
  assert.match(checkNotesFile("## Highlights\n\n- one line\n").reason, /essentially empty/);
  assert.equal(checkNotesFile("## Highlights\n\n- a\n- b\n- c\n").ok, true);
  const todo = checkNotesFile("## Highlights\n\n<!-- c -->\n- TODO: ...\n- another entry here\n- and one more\n");
  assert.equal(todo.ok, true, "TODO is a soft warning, not a rejection");
  assert.match(todo.warn, /TODO/);
});

// ---- 子进程端到端：真实 git fixture 仓 ----

function makeFixtureRepo(t, version, notes = "## Highlights\n\n- Shipped the thing.\n- Fixed the other thing.\n", extra = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-tag-fix-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@local");
  git("config", "user.name", "test");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fix", version }));
  if (notes != null) {
    fs.mkdirSync(path.join(dir, "releases"), { recursive: true });
    fs.writeFileSync(path.join(dir, "releases", `v${version}.md`), notes);
  }
  if (extra) {
    for (const [rel, content] of Object.entries(extra)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    }
  }
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

test("end-to-end: missing external floors block the tag unless --skip-external", (t) => {
  const dir = makeFixtureRepo(t, "0.16.0-aiti.1", undefined, {
    "scripts/check-external-deps.mjs":
      'console.error("✗ @aiti-ai/content-share — floor ^0.1.16 NOT satisfiable on npmjs");\nprocess.exit(1);\n',
  });
  const blocked = spawnSync(process.execPath, [SCRIPT, "--dry-run"], { cwd: dir, encoding: "utf8" });
  assert.equal(blocked.status, 1, "a missing floor must block the tag");
  assert.match(blocked.stderr, /external dependency floors/);
  assert.match(blocked.stderr, /content-share/);
  const waived = spawnSync(process.execPath, [SCRIPT, "--dry-run", "--skip-external"], { cwd: dir, encoding: "utf8" });
  assert.equal(waived.status, 0, "--skip-external must waive the guard");
  assert.match(waived.stderr, /waived via --skip-external/);
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

test("end-to-end: missing notes file refused unless --skip-notes", (t) => {
  const dir = makeFixtureRepo(t, "0.16.0-aiti.1", null);
  let failed = false;
  try {
    execFileSync(process.execPath, [SCRIPT, "--dry-run"], { cwd: dir, encoding: "utf8" });
  } catch (e) {
    failed = true;
    assert.match(String(e.stderr), /is missing/);
    assert.match(String(e.stderr), /draft-release-notes\.mjs/);
  }
  assert.equal(failed, true, "missing notes must exit non-zero");
  const r = spawnSync(process.execPath, [SCRIPT, "--dry-run", "--skip-notes"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, "--skip-notes must pass");
  const out = r.stdout + r.stderr; // guard warnings go to stderr
  assert.match(out, /tag=v0\.16\.0-aiti\.1/);
  assert.match(out, /waived via --skip-notes/);
});

test("end-to-end: TODO placeholder in notes passes with a soft warning", (t) => {
  const dir = makeFixtureRepo(t, "0.16.0-aiti.1", "## Highlights\n\n- TODO: ...\n- another entry here\n- and one more\n");
  const r = spawnSync(process.execPath, [SCRIPT, "--dry-run"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, "TODO is a soft warning, must pass");
  const out = r.stdout + r.stderr; // soft warning goes to stderr
  assert.match(out, /tag=v0\.16\.0-aiti\.1/);
  assert.match(out, /TODO/);
});
