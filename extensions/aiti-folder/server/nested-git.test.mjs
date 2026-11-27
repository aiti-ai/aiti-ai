/**
 * nested-git.test.mjs — nested git repo detection tests (tests server/nested-git.ts directly).
 * Run: node --experimental-strip-types --test extensions/aiti-folder/server/nested-git.test.mjs
 *
 * Covers: `.git` directory detection, `.git` gitfile (submodule/worktree shape) detection,
 * non-dir / symlink / plain children skipped, `.git` itself skipped, truncated flag past the cap.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { scanNestedGitRepos } = await import("./nested-git.ts");

const tmp = mkdtempSync(join(tmpdir(), "folder-nestedgit-"));
// Fixture lives for the whole run: test() callbacks execute after the module top-level finishes,
// so cleanup must be an after() hook (a top-level try/finally would delete the tree too early).
after(() => rmSync(tmp, { recursive: true, force: true }));

// fixture tree
  mkdirSync(join(tmp, "plain-repo", ".git"), { recursive: true });      // .git directory shape
  mkdirSync(join(tmp, "sub-like"));                                     // .git file shape (gitfile)
  writeFileSync(join(tmp, "sub-like", ".git"), "gitdir: ../somewhere/for-sub\n");
  mkdirSync(join(tmp, "no-git"));
  writeFileSync(join(tmp, "file.txt"), "x");
  mkdirSync(join(tmp, ".git"));                                          // the scan target itself is never a hit
  symlinkSync(join(tmp, "plain-repo"), join(tmp, "linked-repo"), "dir"); // symlink must be skipped

test("detects .git directory and .git gitfile among direct children", () => {
  const r = scanNestedGitRepos(tmp);
  assert.equal(r.ok, true);
  const names = r.repos.map((x) => x.name).sort();
  assert.deepEqual(names, ["plain-repo", "sub-like"]);
  for (const e of r.repos) assert.equal(e.path, join(tmp, e.name));
  });

test("skips symlinks, plain files, .git itself; no truncation under the cap", () => {
  const r = scanNestedGitRepos(tmp);
  assert.ok(!r.repos.some((x) => x.name === "linked-repo"), "symlink must be skipped");
  assert.ok(!r.repos.some((x) => x.name === "no-git"));
  assert.ok(!r.truncated);
  });

test("unreadable directory reports ok:false with error", () => {
  const r = scanNestedGitRepos(join(tmp, "does-not-exist"));
  assert.equal(r.ok, false);
  assert.equal(r.repos.length, 0);
  assert.ok(r.error);
  });

test("truncates past the 500-children cap", () => {
  const big = join(tmp, "big");
  mkdirSync(big, { recursive: true });
  mkdirSync(join(big, "zz-repo", ".git"), { recursive: true }); // sorts after the first 500
  for (let i = 0; i < 502; i++) mkdirSync(join(big, "d" + String(i).padStart(3, "0")));
  const r = scanNestedGitRepos(big);
  assert.equal(r.ok, true);
  assert.equal(r.truncated, true);
  assert.equal(r.repos.length, 0); // zz-repo sits past the cap, first 500 children have no .git
  });

