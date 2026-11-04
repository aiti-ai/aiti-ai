import { test } from "node:test";
import assert from "node:assert/strict";
import { findSubcommand, withRepoOpts, normalizeSource } from "./git-args.mjs";

test("findSubcommand：跳过 - 开头参数取第一个子命令", () => {
  assert.equal(findSubcommand(["diff", "--no-color", "--", "a.ts"]), "diff");
  assert.equal(findSubcommand(["-C", "/tmp/x", "log", "-n", "3"]), "log");
  assert.equal(findSubcommand([]), "");
});

test("withRepoOpts：无 opts 原样返回；有 gitDir 前插 --git-dir/--work-tree", () => {
  const args = ["diff", "--numstat", "abc", "def"];
  assert.equal(withRepoOpts(args), args);
  assert.deepEqual(withRepoOpts(args, {}), args);
  assert.deepEqual(
    withRepoOpts(args, { gitDir: "/r/.aiti-trace", workTree: "/r" }),
    ["--git-dir=/r/.aiti-trace", "--work-tree=/r", "diff", "--numstat", "abc", "def"],
  );
  // 只有 gitDir 时不注入 --work-tree
  assert.deepEqual(withRepoOpts(args, { gitDir: "/r/.aiti-trace" }), ["--git-dir=/r/.aiti-trace", "diff", "--numstat", "abc", "def"]);
});

test("withRepoOpts 注入后子命令探测不受影响（白名单兼容关键）", () => {
  const injected = withRepoOpts(["log", "--format=%h"], { gitDir: "/r/.aiti-trace", workTree: "/r" });
  assert.equal(findSubcommand(injected), "log");
});

test("normalizeSource：缺省/非法归一 repo，仅 trace 保留", () => {
  assert.equal(normalizeSource(undefined), "repo");
  assert.equal(normalizeSource("repo"), "repo");
  assert.equal(normalizeSource("trace"), "trace");
  assert.equal(normalizeSource("hacker"), "repo");
});
