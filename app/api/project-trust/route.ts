import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { invalidateModelsCache } from "@/lib/models-cache";
import { checkTrustCwd, getProjectTrustStatus, trustProject } from "@/lib/project-trust";
import { destroyRpcSessionsForCwd, hasBusyRpcSessionForCwd } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

async function validateCwd(value: unknown): Promise<
  { cwd: string } | { response: NextResponse }
> {
  const result = await checkTrustCwd(value);
  if ("cwd" in result) return result;
  return { response: NextResponse.json({ error: result.error }, { status: result.status }) };
}

// GET /api/project-trust?cwd= — kept in query-string form for existing callers; new code must use POST /api/project-trust/status (cwd goes in the JSON body, never in the URL/access logs).
export async function GET(req: Request) {
  const result = await validateCwd(new URL(req.url).searchParams.get("cwd"));
  if ("response" in result) return result.response;
  return NextResponse.json(getProjectTrustStatus(result.cwd, getAgentDir()));
}

export async function POST(req: Request) {
  try {
    const body = await req.json() as { cwd?: unknown };
    const result = await validateCwd(body.cwd);
    if ("response" in result) return result.response;

    const agentDir = getAgentDir();
    const current = getProjectTrustStatus(result.cwd, agentDir);
    if (!current.requiresTrust) {
      return NextResponse.json({ error: "This project has no resources that require trust" }, { status: 409 });
    }
    if (hasBusyRpcSessionForCwd(result.cwd)) {
      return NextResponse.json({ error: "Wait for the active session to finish before trusting this project" }, { status: 409 });
    }

    const status = trustProject(result.cwd, agentDir);
    invalidateModelsCache();
    await destroyRpcSessionsForCwd(result.cwd);
    return NextResponse.json(status);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
