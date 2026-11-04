/**
 * new-session-picker · 意图状态机纯函数（docs/pi-web-new-session-branch-worktree-plan.md §4）。
 *
 * 统一意图模型（P1-1 采纳为默认）：任何选择只暂存意图——目标 cwd 改写与全部写操作
 * 统一发生在发送首条消息时（preparer 单一执行路径）。本模块把「意图 × 现场」→「动作」
 * 的裁决抽成纯函数，便于矩阵单测；执行（网络/写操作）在 new-session-picker.tsx。
 *
 * ⚠ strip-types 直跑约束：本文件被 node --experimental-strip-types 单测直引，
 * 只允许类型注解，不得引入 enum/namespace/参数属性等需要转译的语法。
 */

/** 选择器选择：null = 未选；follow = 跟随工作区（清除意图）；worktree = 已有 worktree 路径；
 *  branch = 分支（remote 携带完整远程 ref 时发送时先建同名本地分支）。 */
export type PickerSelection =
  | null
  | { kind: "follow" }
  | { kind: "worktree"; path: string }
  | { kind: "branch"; name: string; remote?: string };

/** 意图 = 分支/worktree 双模式（与 BranchPanel 共享 localStorage key gitops.panel.wtMode 同语义）+ 选择。 */
export interface PickerIntent {
  mode: boolean;
  selection: PickerSelection;
}

/** preparer 执行动作矩阵。 */
export type PickerAction =
  | { type: "none" }
  | { type: "useWorktree"; path: string }
  | { type: "ensureWorktree"; branch: string }
  | { type: "checkout"; branch: string };

/** 远程 ref（origin/feat/a）→ 本地短名（feat/a）。 */
export function shortBranchName(remoteRef: string): string {
  return remoteRef.replace(/^[^/]+\//, "");
}

/**
 * 意图裁决矩阵：
 *  - 无选择 / follow → none（preparer 不介入、清意图）；
 *  - 选已有 worktree → useWorktree（立即改暂存目标语义，但仍延迟到发送时统一执行）；
 *  - 选当前分支 → none（P1-2：等效跟随工作区——对当前分支建 worktree 会因
 *    already checked out 失败，checkout 亦无意义）；
 *  - 分支 × wtMode 开 → 有同名 worktree 复用，无则 ensureWorktree；
 *  - 分支 × wtMode 关 → checkout（409 冲突由执行层弹三选一卡，绝不丢文件）。
 */
export function resolvePickerAction(
  intent: PickerIntent | null,
  ctx: { currentBranch: string | null; worktrees: Array<{ path: string; branch?: string }> },
): PickerAction {
  const sel = intent?.selection ?? null;
  if (!sel || sel.kind === "follow") return { type: "none" };
  if (sel.kind === "worktree") return { type: "useWorktree", path: sel.path };
  const name = sel.remote ? shortBranchName(sel.remote) : sel.name;
  if (ctx.currentBranch && name === ctx.currentBranch) return { type: "none" };
  const existing = ctx.worktrees.find((w) => w.branch === name);
  if (intent.mode) {
    return existing ? { type: "useWorktree", path: existing.path } : { type: "ensureWorktree", branch: name };
  }
  return { type: "checkout", branch: name };
}

/** 引擎缺席降级（方案 §2.3）：wtMode 强制按开处理。 */
export function effectiveMode(intentMode: boolean, engineAbsent: boolean): boolean {
  return engineAbsent ? true : intentMode;
}
