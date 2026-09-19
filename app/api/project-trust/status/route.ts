import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { checkTrustCwd, getProjectTrustStatus } from "@/lib/project-trust";

// POST /api/project-trust/status  body: { cwd }  →  ProjectTrustStatus
// cwd goes in the JSON body, not the URL (access logs / proxy logs). GET /api/project-trust?cwd= is
// the legacy compatibility form.
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { cwd?: unknown };
    const result = await checkTrustCwd(body.cwd);
    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json(getProjectTrustStatus(result.cwd, getAgentDir()));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
