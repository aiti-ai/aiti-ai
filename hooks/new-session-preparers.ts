/**
 * 新会话创建前 preparer 管道（docs/pi-web-new-session-branch-worktree-plan.md §3）：
 * ensureNewSession 在 POST /api/agent/new 之前依序 await 扩展注册的 prepare——
 *  - 返回 { cwd } 改写目标目录（链式：后一个 preparer 的 ctx.cwd 是前一个的输出）；
 *  - 返回 { abort } 中止创建（文案原样 throw → handleSend 既有 catch → notice 显示；
 *    restoreSubmission 把输入放回，草稿由 draft-keeper 保留——零新增显示机制）；
 *  - 返回 void/undefined = 不介入。
 * 扩展经 registerItems("newSessionPreparers", [{ id, meta: { prepare } }]) 注册；
 * 本模块只负责顺序执行语义（纯管道，无 React/网络依赖，可直接单测）。
 */
import type { NewSessionPrepareResult } from "@/lib/ext/types";

export interface NewSessionPreparer {
  id: string;
  prepare?: (ctx: { cwd: string }) => Promise<NewSessionPrepareResult>;
}

export async function runNewSessionPreparers(
  preparers: NewSessionPreparer[] | undefined,
  cwd: string,
): Promise<{ cwd: string }> {
  let target = cwd;
  for (const p of preparers ?? []) {
    const r = await p.prepare?.({ cwd: target });
    if (!r) continue;
    if (r.abort) throw new Error(r.abort);
    if (r.cwd) target = r.cwd;
  }
  return { cwd: target };
}
