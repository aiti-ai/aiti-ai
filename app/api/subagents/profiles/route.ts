import { NextResponse } from "next/server";
import { existsSync } from "fs";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import {
  deleteSubagentProfile,
  listSubagentProfileSources,
  saveSubagentProfile,
  type SubagentProfile,
  type SubagentWritableScope,
} from "@/lib/subagents";
import { writeDisabledBuiltInSubagent } from "@/lib/subagent-settings";

export const dynamic = "force-dynamic";

async function validateCwd(cwd: unknown): Promise<string> {
  if (typeof cwd !== "string" || !cwd || !existsSync(cwd)) throw new Error("Valid cwd required");
  if (!isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) throw new Error("Access denied");
  return cwd;
}

function validateScope(scope: unknown): SubagentWritableScope {
  if (scope !== "global" && scope !== "project") throw new Error("scope must be global or project");
  return scope;
}

/** A built-in has no file to save or delete, but its switch is persisted all the same. */
function validateToggleScope(scope: unknown): SubagentWritableScope | "builtin" {
  if (scope === "builtin") return scope;
  if (scope !== "global" && scope !== "project") throw new Error("scope must be global, project, or builtin");
  return scope;
}

async function handleProfiles(cwd: unknown): Promise<NextResponse> {
  try {
    const validCwd = await validateCwd(cwd);
    return NextResponse.json({ profiles: listSubagentProfileSources(validCwd) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message === "Access denied" ? 403 : 400 });
  }
}

// GET /api/subagents/profiles?cwd= — the query-string form is kept for existing callers; new code
// must use POST (cwd goes in the JSON body, never in the URL/access logs).
export async function GET(req: Request) {
  return handleProfiles(new URL(req.url).searchParams.get("cwd"));
}

// POST /api/subagents/profiles  body: { cwd } — same semantics.
export async function POST(req: Request) {
  let bodyCwd: unknown = null;
  try {
    const body = (await req.json()) as { cwd?: unknown };
    bodyCwd = body.cwd;
  } catch {
    /* fallthrough → validateCwd reports "Valid cwd required" */
  }
  return handleProfiles(bodyCwd);
}

export async function PUT(req: Request) {
  try {
    const body = await req.json() as {
      cwd?: unknown;
      scope?: unknown;
      profile?: Omit<SubagentProfile, "scope" | "filePath">;
    };
    const cwd = await validateCwd(body.cwd);
    const scope = validateScope(body.scope);
    if (!body.profile || typeof body.profile.name !== "string") {
      return NextResponse.json({ error: "profile required" }, { status: 400 });
    }
    return NextResponse.json({ profile: saveSubagentProfile(cwd, scope, body.profile) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message === "Access denied" ? 403 : 400 });
  }
}

export async function PATCH(req: Request) {
  try {
    const body = await req.json() as { cwd?: unknown; scope?: unknown; name?: unknown; enabled?: unknown };
    const cwd = await validateCwd(body.cwd);
    const scope = validateToggleScope(body.scope);
    if (typeof body.name !== "string") return NextResponse.json({ error: "name required" }, { status: 400 });
    if (typeof body.enabled !== "boolean") return NextResponse.json({ error: "enabled required" }, { status: 400 });
    const name = body.name;
    const source = listSubagentProfileSources(cwd).find((profile) =>
      profile.scope === scope && profile.name.toLowerCase() === name.toLowerCase()
    );
    if (!source) return NextResponse.json({ error: "Agent profile not found" }, { status: 404 });
    if (scope === "builtin") {
      writeDisabledBuiltInSubagent(source.name, !body.enabled);
      return NextResponse.json({ profile: { ...source, enabled: body.enabled } });
    }
    const profile: Omit<SubagentProfile, "scope" | "filePath"> = {
      name: source.name,
      displayName: source.displayName,
      description: source.description,
      systemPrompt: source.systemPrompt,
      tools: source.tools,
      ...(source.extensionTools !== undefined ? { extensionTools: [...source.extensionTools] } : {}),
      ...(source.disallowedExtensionTools !== undefined ? { disallowedExtensionTools: [...source.disallowedExtensionTools] } : {}),
      loadSkills: source.loadSkills,
      ...(source.skills !== undefined ? { skills: [...source.skills] } : {}),
      loadExtensions: source.loadExtensions,
      ...(source.extensions !== undefined ? { extensions: [...source.extensions] } : {}),
      codemode: source.codemode,
      mcp: source.mcp,
      promptMode: source.promptMode,
      model: source.model,
      thinking: source.thinking,
      maxTurns: source.maxTurns,
      inheritContext: source.inheritContext,
      runInBackground: source.runInBackground,
      color: source.color,
      isolation: source.isolation,
      persistSession: source.persistSession,
      enabled: source.enabled,
    };
    return NextResponse.json({ profile: saveSubagentProfile(cwd, scope, { ...profile, enabled: body.enabled }) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message === "Access denied" ? 403 : 400 });
  }
}

export async function DELETE(req: Request) {
  try {
    const body = await req.json() as { cwd?: unknown; scope?: unknown; name?: unknown };
    const cwd = await validateCwd(body.cwd);
    const scope = validateScope(body.scope);
    if (typeof body.name !== "string") return NextResponse.json({ error: "name required" }, { status: 400 });
    deleteSubagentProfile(cwd, scope, body.name);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message === "Access denied" ? 403 : 400 });
  }
}
