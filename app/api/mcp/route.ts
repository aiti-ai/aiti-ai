import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { McpErrorResponse, McpRefusalReason, McpResponse } from "@/lib/api-types";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { readMcpOverview } from "@/lib/mcp-config-read";

export const dynamic = "force-dynamic";

// Settings › MCP (ADR 0006). GET reads files only: it never spawns a server,
// opens a connection, or runs a `!command` value, so it lists an untrusted
// project's servers as safely as the global ones. Without `cwd` it lists the
// global file alone; Settings › MCP does not need a project.

function refusal(status: number, reason: McpRefusalReason, error: string) {
  return NextResponse.json({ error, reason } satisfies McpErrorResponse, { status });
}

// GET /api/mcp?cwd=<absolute project folder>
export async function GET(req: Request) {
  const value = new URL(req.url).searchParams.get("cwd");
  let project: { cwd: string; allowedRoots: Set<string> } | undefined;
  if (value !== null) {
    if (!value.trim() || !isAbsolute(value)) return refusal(400, "cwd-invalid", "cwd must be an absolute path");
    // Checked as given: resolving first would collapse a `..` the check refuses.
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(value, allowedRoots)) return refusal(403, "cwd-denied", "Access denied");
    const cwd = resolve(value);
    let directory = false;
    try {
      directory = statSync(cwd).isDirectory();
    } catch {
      // Removed since the check.
    }
    if (!directory) return refusal(400, "cwd-not-directory", "cwd must be a directory");
    project = { cwd, allowedRoots };
  }

  try {
    return NextResponse.json((await readMcpOverview({ agentDir: getAgentDir(), project })) satisfies McpResponse);
  } catch (error) {
    return refusal(500, "internal", error instanceof Error ? error.message : String(error));
  }
}
