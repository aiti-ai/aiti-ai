import { NextResponse } from "next/server";
import { checkCwdAllowed, queryWorktrees } from "@/lib/worktree-query";

// POST /api/worktrees/query  body: { cwd }  →  { projectRoot, projectKey, isGit, isTopLevel, currentWorktreePath, worktrees }
// cwd 走 JSON body，不落 URL（访问日志/代理日志）。GET /api/worktrees?cwd= 为存量兼容形态。
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { cwd?: unknown };
    const cwd = typeof body.cwd === "string" ? body.cwd : "";
    if (!cwd) {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    const denied = await checkCwdAllowed(cwd);
    if (denied) return denied;

    return await queryWorktrees(cwd);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
