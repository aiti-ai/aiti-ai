/**
 * git-plan · 启发式分组/偏好学习/plan CRUD 测试（git-ops M4）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { groupHeuristic, learn, loadPlan, savePlan, newPlan } from "./git-plan.ts";

const stateDir = mkdtempSync(join(tmpdir(), "gitplan-"));

test("启发式：锁文件进 excluded；目录+类型聚类；conventional 前缀建议", () => {
  const { groups, excluded } = groupHeuristic(stateDir, [
    { path: "package-lock.json", status: "modified" },
    { path: "README.md", status: "modified" },
    { path: "docs/guide.md", status: "untracked" },
    { path: "src/foo/a.ts", status: "untracked" },
    { path: "src/foo/b.ts", status: "untracked" },
    { path: "src/foo/a.test.ts", status: "untracked" },
    { path: "lib/util.ts", status: "modified" },
  ]);
  assert.deepEqual(excluded, ["package-lock.json"]);
  const byKey = Object.fromEntries(groups.map((g) => [g.key, g]));
  // docs 聚合（README + docs/）
  assert.ok(byKey["docs::docs"] || groups.some((g) => g.key.startsWith("docs")));
  // src/foo 源码组（测试文件单独）
  assert.ok(groups.some((g) => g.key === "src/foo::source" && g.files.includes("src/foo/a.ts")));
  assert.ok(groups.some((g) => g.files.includes("src/foo/a.test.ts") && g.message.startsWith("test(")));
  // 仅修改的源码组建议 fix:
  const lib = groups.find((g) => g.key === "lib::source");
  assert.ok(lib && lib.message.startsWith("fix("));
  // 全新增组建议 feat:
  const foo = groups.find((g) => g.key === "src/foo::source");
  assert.ok(foo && foo.message.startsWith("feat("));
});

test("偏好学习：move 共现 ≥2 → dirKey 对合并为一组", () => {
  learn(stateDir, "move", { file: "lib/util.ts", toKey: "src/foo" });
  learn(stateDir, "move", { file: "lib/other.ts", toKey: "src/foo" });
  const { groups } = groupHeuristic(stateDir, [
    { path: "lib/util.ts", status: "modified" },
    { path: "src/foo/a.ts", status: "untracked" },
  ]);
  assert.equal(groups.length, 1, "共现合并生效");
});

test("偏好学习：exclude 精确路径 → 建议剔除", () => {
  learn(stateDir, "exclude", { path: "generated/bundle.js" });
  const { excluded } = groupHeuristic(stateDir, [{ path: "generated/bundle.js", status: "untracked" }]);
  assert.deepEqual(excluded, ["generated/bundle.js"]);
});

test("plan CRUD：roundtrip + cwd 哈希隔离", () => {
  const cwdA = "/tmp/gitplan-a";
  const plan = savePlan(stateDir, { ...newPlan(cwdA, "abc123"), groups: [{ id: "g1", files: ["a.ts"], message: "feat: a", state: "pending" }], excluded: [] });
  assert.match(plan.id, /^plan-/);
  const back = loadPlan(stateDir, cwdA);
  assert.equal(back?.baseHEAD, "abc123");
  assert.equal(back?.groups[0].message, "feat: a");
  assert.equal(loadPlan(stateDir, "/tmp/gitplan-b"), null);
});
