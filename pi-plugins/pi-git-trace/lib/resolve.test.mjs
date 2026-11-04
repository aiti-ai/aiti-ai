/**
 * WP-A 单测 —— resolve.ts（node:test）。
 * 运行：npx tsx --test pi-git-trace/lib/resolve.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { isValidGitDir, resolveRepoRoot, findNestedRepos, clearResolveCache } from "./resolve.ts";

function makeTree() {
  const root = mkdtempSync(path.join(tmpdir(), "aiti-wpa-"));
  // repoA：合法仓 + 子目录 + 深层嵌套仓（两层，不应被一层扫描返回）
  mkdirSync(path.join(root, "repoA", ".git", "refs"), { recursive: true });
  writeFileSync(path.join(root, "repoA", ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(path.join(root, "repoA", "sub"), { recursive: true });
  writeFileSync(path.join(root, "repoA", "sub", "file.ts"), "x");
  mkdirSync(path.join(root, "repoA", "sub", "deep", ".git"), { recursive: true });
  // repoB：合法仓
  mkdirSync(path.join(root, "repoB", ".git"), { recursive: true });
  writeFileSync(path.join(root, "repoB", ".git", "HEAD"), "ref: refs/heads/main\n");
  // plain：无仓
  mkdirSync(path.join(root, "plain"), { recursive: true });
  // repoC：.git 是文件（worktree 指针）→ 非法
  mkdirSync(path.join(root, "repoC"), { recursive: true });
  writeFileSync(path.join(root, "repoC", ".git"), "gitdir: /elsewhere\n");
  return root;
}

const ROOT = makeTree();
const repoA = path.join(ROOT, "repoA");

test("isValidGitDir：目录+HEAD 合法；.git 文件非法", () => {
  assert.equal(isValidGitDir(repoA), true);
  assert.equal(isValidGitDir(path.join(ROOT, "repoC")), false);
  assert.equal(isValidGitDir(path.join(ROOT, "plain")), false);
});

test("resolveRepoRoot：子目录向上找到仓根；无仓返回 null", () => {
  clearResolveCache();
  assert.equal(resolveRepoRoot(path.join(repoA, "sub", "file.ts")), repoA);
  assert.equal(resolveRepoRoot(path.join(ROOT, "plain")), null);
});

test(".git 是文件（worktree 指针）→ 视为非仓继续向上", () => {
  clearResolveCache();
  assert.equal(resolveRepoRoot(path.join(ROOT, "repoC")), null);
});

test("缓存：命中短路（clear 后重新计算仍一致）", () => {
  clearResolveCache();
  const r1 = resolveRepoRoot(path.join(repoA, "sub", "file.ts"));
  const r2 = resolveRepoRoot(path.join(repoA, "sub", "file.ts"));
  assert.equal(r1, repoA);
  assert.equal(r2, repoA);
  clearResolveCache();
  assert.equal(resolveRepoRoot(repoA), repoA);
});

test("findNestedRepos：仅一层子目录、排序、不含深层", () => {
  clearResolveCache();
  const found = findNestedRepos(ROOT);
  assert.deepEqual(found, [path.join(ROOT, "repoA"), path.join(ROOT, "repoB")]);
  // repoA 内向下扫一层：无嵌套仓（deep 在两层外）
  assert.deepEqual(findNestedRepos(path.join(repoA, "sub")), []);
});

test("不存在的目录：findNestedRepos 空数组、resolveRepoRoot null（不抛错）", () => {
  clearResolveCache();
  assert.deepEqual(findNestedRepos(path.join(ROOT, "nope")), []);
  assert.equal(resolveRepoRoot(path.join(ROOT, "nope-deep", "x")), null);
});

test("清理临时目录", () => {
  rmSync(ROOT, { recursive: true, force: true });
  assert.ok(true);
});
