import { NextRequest, NextResponse } from "next/server";
import { stat } from "fs/promises";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  createDirectory,
  getBrowseStartDirectory,
  getParentDirectory,
  listDirectories,
  listWindowsDrives,
  resolveDirectory,
  shouldShowWindowsDrivePicker,
} from "@/lib/directory-browser";

// POST /api/cwd/browse — one endpoint, two operations dispatched on the body:
// - { path? }: browse — lists readable subdirectories (the folder pickers).
//   path goes in the body, not the URL — keeps local paths out of tunnel/proxy
//   access logs.
// - { path, name }: create — makes one direct child directory of the browsed
//   folder (the "New folder" action in the pickers).
export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await request.json().catch(() => null) as { path?: unknown; name?: unknown } | null;

    // --- create (upstream): { path, name } ---
    if (typeof body?.name === "string") {
      const parentPath = typeof body.path === "string" ? body.path.trim() : "";
      const name = body.name.trim();

      if (!parentPath) {
        return NextResponse.json({ error: "Parent path is required" }, { status: 400 });
      }
      if (!name) {
        return NextResponse.json({ error: "Directory name is required" }, { status: 400 });
      }

      const createdPath = await createDirectory(parentPath, name);
      return NextResponse.json({ success: true, path: createdPath });
    }

    // --- browse (local): { path? } ---
    const requested = typeof body?.path === "string" ? body.path.trim() : "";

    if (shouldShowWindowsDrivePicker(requested)) {
      return NextResponse.json({
        path: "",
        parentPath: null,
        drives: await listWindowsDrives(),
        directories: [],
      });
    }

    const candidate = getBrowseStartDirectory(requested);

    let resolved: string;
    try {
      resolved = await resolveDirectory(candidate);
    } catch {
      return NextResponse.json({ error: "Directory does not exist" }, { status: 404 });
    }

    const directoryStat = await stat(resolved);
    if (!directoryStat.isDirectory()) {
      return NextResponse.json({ error: "Path is not a directory" }, { status: 400 });
    }

    const directories = await listDirectories(resolved);

    return NextResponse.json({
      path: resolved,
      parentPath: getParentDirectory(resolved),
      directories,
    });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
    if (code === "EEXIST") {
      return NextResponse.json({ error: "A file or directory with this name already exists" }, { status: 409 });
    }
    if (code === "ENOENT") {
      return NextResponse.json({ error: "Parent directory does not exist" }, { status: 404 });
    }
    if (code === "EACCES" || code === "EPERM") {
      return NextResponse.json({ error: "Permission denied" }, { status: 403 });
    }
    if (code === "EINVAL" || code === "ENAMETOOLONG") {
      return NextResponse.json({ error: "Directory name is invalid" }, { status: 400 });
    }
    if (error instanceof Error && (
      error.message === "Directory name must be a single folder name"
      || error.message === "Parent path is not a directory"
    )) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
