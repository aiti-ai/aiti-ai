import { NextResponse } from "next/server";
import { checkCwdAllowed, queryWorktrees } from "@/lib/worktree-query";

// POST /api/worktrees/query  body: { cwd }  →  { projectRoot, projectKey, isGit, isTopLevel, currentWorktreePath, worktrees }
// cwd goes in the JSON body, not the URL (access logs / proxy logs). GET /api/worktrees?cwd= is the
// legacy compatibility form.
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
