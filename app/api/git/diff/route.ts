import { NextRequest, NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed, isWindowsAbsolutePath } from "@/lib/file-access";
import { getGitFileDiff } from "@/lib/git-changes";

async function handleDiff(cwd: string, filePath: string): Promise<NextResponse> {
  if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
    return NextResponse.json({ error: "cwd must be an absolute path" }, { status: 400 });
  }
  if (!filePath || (!filePath.startsWith("/") && !isWindowsAbsolutePath(filePath))) {
    return NextResponse.json({ error: "path must be an absolute path" }, { status: 400 });
  }

  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(cwd, allowedRoots) || !isFilePathAllowed(filePath, allowedRoots)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  // The cwd must resolve inside an allowed root. The file itself may no
  // longer exist when Git reports it as deleted; getGitFileDiff verifies
  // that the requested path belongs to this repository and its status.
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  return NextResponse.json(await getGitFileDiff(cwd, filePath));
}

// GET /api/git/diff?cwd=&path= — the query-string form is kept for existing callers;
// new code must use POST (cwd/path go in the JSON body, so they never land in URLs/access logs).
export async function GET(request: NextRequest) {
  try {
    const cwd = request.nextUrl.searchParams.get("cwd")?.trim() ?? "";
    const filePath = request.nextUrl.searchParams.get("path")?.trim() ?? "";
    return await handleDiff(cwd, filePath);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

// POST /api/git/diff  body: { cwd, path } — same semantics.
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as { cwd?: unknown; path?: unknown };
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    const filePath = typeof body.path === "string" ? body.path.trim() : "";
    return await handleDiff(cwd, filePath);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
