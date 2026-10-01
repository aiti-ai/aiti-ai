import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { McpErrorResponse, McpRefusalReason, McpScope, McpTestResponse } from "@/lib/api-types";
import { isMcpDisabledByOperator, MCP_DISABLE_VARIABLE } from "@/lib/builtin-extensions";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { readMcpServerEntry } from "@/lib/mcp-config-read";
import { testMcpServer } from "@/lib/mcp-test";
import { findWebPasswordField } from "@/lib/mcp-transport";
import { loadPiSdkInternals } from "@/lib/pi-sdk-internals";
import { getProjectTrustStatus } from "@/lib/project-trust";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

// Settings › MCP's Test (ADR 0006): connects one server of the global
// `mcp.json` or the panel's project `.pi/mcp.json` once, outside any session,
// and answers with what it found (`lib/mcp-test.ts`). It starts a process or
// contacts a URL, and may run a `!command` value, so it re-checks here
// everything a session's start would: MCP is not off, the entry is read from
// its file (never a config from the browser) and valid, it does not
// reference PI_WEB_PASSWORD, and a project entry's folder is allowed and
// trusted. A global stdio server runs in the panel's project when it has one
// (checked like any cwd), else in the home folder, which the answer names.

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refusal(status: number, reason: McpRefusalReason, error: string, params: Pick<McpErrorResponse, "path" | "name"> = {}) {
  return NextResponse.json({ error, reason, ...params } satisfies McpErrorResponse, { status });
}

type Project = { cwd: string; allowedRoots: Set<string> };

/** The panel's project, checked as GET /api/mcp checks it: absolute, inside the allowed roots as given (a `..` is refused, not collapsed), a directory. */
async function validateProject(value: unknown): Promise<Project | Response> {
  if (typeof value !== "string" || !value.trim() || !isAbsolute(value)) {
    return refusal(400, "cwd-invalid", "cwd must be an absolute path");
  }
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
  return { cwd, allowedRoots };
}

function readScope(value: unknown): McpScope | undefined {
  return value === "global" || value === "project" ? value : undefined;
}

// POST /api/mcp/test body: { scope, name, cwd? }
// `cwd` is the panel's project: required for a project server, and the
// folder a global stdio server runs in.
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return refusal(403, "request-denied", "Untrusted API request");
  if (!hasJsonContentType(req)) return refusal(415, "content-type", "Content-Type must be application/json");
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return refusal(400, "invalid-request", "Invalid JSON body");
  }
  if (!isRecord(body)) return refusal(400, "invalid-request", "Expected a JSON object");
  const scope = readScope(body.scope);
  const name = typeof body.name === "string" && body.name.length > 0 && body.name.length <= 1024 ? body.name : undefined;
  if (!scope || name === undefined) {
    return refusal(400, "invalid-request", "scope must be \"global\" or \"project\", and name a server name");
  }

  let project: Project | undefined;
  if (body.cwd !== undefined && body.cwd !== null) {
    const result = await validateProject(body.cwd);
    if (result instanceof Response) return result;
    project = result;
  }
  if (scope === "project" && !project) return refusal(400, "invalid-request", "A project server needs the project's cwd");

  // MCP off: the operator's switch, which nothing in the browser may override, or SDK modules
  // that cannot load, without which Pi Web has no transport it would connect through.
  if (isMcpDisabledByOperator()) return refusal(409, "mcp-off", `${MCP_DISABLE_VARIABLE} is set, so Pi Web connects no MCP server`);
  const internals = await loadPiSdkInternals();
  if (!internals.ok) return refusal(409, "mcp-off", `Pi Web cannot load the SDK's MCP modules: ${internals.reason}`);

  const agentDir = getAgentDir();
  if (scope === "project" && project) {
    // The MCP host's rule (`mayReadProjectConfigNow()`): a decision, exact or inherited, that
    // trusts the folder. Never `trusted`, which a folder with no trust-requiring resources has
    // without any decision; without this, Test would run an untrusted repository's command.
    try {
      const status = getProjectTrustStatus(project.cwd, agentDir);
      if (status.decisionError !== undefined) return refusal(409, "trust-unreadable", status.decisionError);
      if (status.decision !== true) {
        return refusal(403, "project-untrusted", "The project is not trusted, so Pi Web does not start its MCP servers");
      }
    } catch (error) {
      return refusal(409, "trust-unreadable", errorMessage(error));
    }
  }

  try {
    const read = readMcpServerEntry({ agentDir, scope, name, project });
    if (!read.ok) {
      const params = { path: read.path, ...(read.reason === "server-missing" ? { name } : {}) };
      if (read.reason === "unreadable") return refusal(500, "internal", read.error, params);
      return refusal(409, read.reason, read.error, params);
    }
    if (!isRecord(read.value)) {
      return refusal(409, "entry-not-object", `${read.sourcePath} defines MCP server "${name}" as something other than an object`, { name });
    }
    const config = internals.validateMcpServerConfig(name, read.value);
    if (typeof config === "string") return refusal(409, "server-invalid", config, { name });
    if (findWebPasswordField(config, internals)) {
      return refusal(409, "web-password", `"${name}" references PI_WEB_PASSWORD, so Pi Web does not connect it`, { name });
    }

    const result = await testMcpServer(
      { scope, name, sourcePath: read.sourcePath, configKey: read.configKey, config, cwd: project?.cwd ?? homedir() },
      internals,
      { signal: req.signal },
    );
    return NextResponse.json({ scope, name, configKey: read.configKey, result } satisfies McpTestResponse);
  } catch (error) {
    return refusal(500, "internal", errorMessage(error));
  }
}
