import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getAllowedFileRoots } from "@/lib/file-access";
import { listProjectMcpServers } from "@/lib/mcp-config-read";
import { checkTrustCwd, getProjectTrustStatus } from "@/lib/project-trust";

// POST /api/project-trust/status  body: { cwd, includeListing? }  →  ProjectTrustStatus
//                                                    (includeListing → + mcpFile/mcpServers/mcpError)
// cwd goes in the JSON body, not the URL (access logs / proxy logs). GET /api/project-trust?cwd= is
// the legacy compatibility form. `includeListing` gives the trust dialog what it needs (the servers
// trusting would connect, ADR 0006) without falling back to the query-string form; it lists files
// only and changes nothing else, so callers that omit it keep the plain status.
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { cwd?: unknown; includeListing?: unknown };
    const result = await checkTrustCwd(body.cwd);
    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    const agentDir = getAgentDir();
    const status = getProjectTrustStatus(result.cwd, agentDir);
    if (body.includeListing !== true) return NextResponse.json(status);
    // Same roots the MCP routes scope their listing to.
    const listing = await listProjectMcpServers(agentDir, result.cwd, await getAllowedFileRoots());
    return NextResponse.json({ ...status, ...listing });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
