/**
 * new-session-picker 意图状态机矩阵测试（方案
 * docs/pi-web-new-session-branch-worktree-plan.md M2 验收：mode × selection × 409 动作矩阵）。
 *
 * 纯函数直跑（node --experimental-strip-types 经 scripts/test-web-ext.mjs）；
 * 执行层（网络/写操作/三选一卡）在 new-session-picker.tsx，不在此覆盖。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { resolvePickerAction, effectiveMode, shortBranchName } from "../src/new-session-picker.pure.ts";

const WT = [
  { path: "/repo", branch: "main", isMain: true },
  { path: "/repo-worktrees/fix-b", branch: "fix/b" },
];

test("无选择 / 跟随工作区 → none（preparer 不介入）", () => {
  assert.equal(resolvePickerAction(null, { currentBranch: "main", worktrees: WT }).type, "none");
  assert.equal(resolvePickerAction({ mode: true, selection: null }, { currentBranch: "main", worktrees: WT }).type, "none");
  assert.equal(resolvePickerAction({ mode: true, selection: { kind: "follow" } }, { currentBranch: "main", worktrees: WT }).type, "none");
});

test("选已有 worktree → useWorktree（发送时目标 cwd 指向该路径）", () => {
  const a = resolvePickerAction({ mode: false, selection: { kind: "worktree", path: "/repo-worktrees/fix-b" } }, { currentBranch: "main", worktrees: WT });
  assert.deepEqual(a, { type: "useWorktree", path: "/repo-worktrees/fix-b" });
});

test("选当前分支 → none（P1-2：等效跟随工作区，防 already checked out）", () => {
  // 双模式一致：wtMode 开时对当前分支建 worktree 必失败，关时 checkout 无意义
  assert.equal(resolvePickerAction({ mode: true, selection: { kind: "branch", name: "main" } }, { currentBranch: "main", worktrees: WT }).type, "none");
  assert.equal(resolvePickerAction({ mode: false, selection: { kind: "branch", name: "main" } }, { currentBranch: "main", worktrees: WT }).type, "none");
  // 远程形态同样命中当前分支短路（origin/main → main）
  assert.equal(resolvePickerAction({ mode: true, selection: { kind: "branch", name: "main", remote: "origin/main" } }, { currentBranch: "main", worktrees: WT }).type, "none");
});

test("分支 × wtMode 开：有同名 worktree 复用，无则 ensureWorktree", () => {
  assert.deepEqual(
    resolvePickerAction({ mode: true, selection: { kind: "branch", name: "fix/b" } }, { currentBranch: "main", worktrees: WT }),
    { type: "useWorktree", path: "/repo-worktrees/fix-b" },
  );
  assert.deepEqual(
    resolvePickerAction({ mode: true, selection: { kind: "branch", name: "feat/a" } }, { currentBranch: "main", worktrees: WT }),
    { type: "ensureWorktree", branch: "feat/a" },
  );
});

test("分支 × wtMode 关 → checkout（409 三选一由执行层承接）", () => {
  assert.deepEqual(
    resolvePickerAction({ mode: false, selection: { kind: "branch", name: "feat/a" } }, { currentBranch: "main", worktrees: WT }),
    { type: "checkout", branch: "feat/a" },
  );
});

test("远程分支：远程 ref → 同名本地短名分流（不 checkout 语义）", () => {
  assert.equal(shortBranchName("origin/feat/a"), "feat/a");
  assert.equal(shortBranchName("upstream/x/y"), "x/y");
  // 引擎缺席（currentBranch 不可得）时不误判当前分支
  assert.deepEqual(
    resolvePickerAction({ mode: true, selection: { kind: "branch", name: "feat/a", remote: "origin/feat/a" } }, { currentBranch: null, worktrees: [] }),
    { type: "ensureWorktree", branch: "feat/a" },
  );
});

test("引擎缺席降级：wtMode 强制按开（effectiveMode）", () => {
  assert.equal(effectiveMode(false, true), true);
  assert.equal(effectiveMode(true, false), true);
  assert.equal(effectiveMode(false, false), false);
});
