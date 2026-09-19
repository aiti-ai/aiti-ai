import { readdirSync } from "fs";
import { homedir } from "os";
import path from "path";
import { getAdditionalAllowedRoots, normalizeSlashes } from "./allowed-roots.ts";
import { isExistingPathWithinRoots, isPathWithinRoots } from "./path-security.ts";
import { listAllSessions } from "./session-reader.ts";
export { allowFileRoot, normalizeSlashes } from "./allowed-roots.ts";
export { isWindowsAbsolutePath } from "./paths.ts";

// Short-TTL cache for the allowed-roots set. Without this, every file list/read
// request re-scans every pi session on disk just to check access. 5s is short
// enough that newly-created cwds appear promptly; stored on globalThis so it
// survives Next.js hot-reload.
declare global {
  var __piAllowedRootsCache: { roots: Set<string>; expiresAt: number } | undefined;
}

const ALLOWED_ROOTS_TTL_MS = 5_000;

export async function getAllowedFileRoots(): Promise<Set<string>> {
  const now = Date.now();
  const cached = globalThis.__piAllowedRootsCache;
  if (cached && cached.expiresAt > now) return cached.roots;

  const sessions = await listAllSessions();
  const roots = new Set<string>();
  for (const s of sessions) {
    if (s.cwd) roots.add(normalizeSlashes(s.cwd));
    // The project root (main repo shared by all worktrees) is browsable too —
    // the project dropdown lists it even when only worktrees have sessions.
    if (s.projectRoot) roots.add(normalizeSlashes(s.projectRoot));
  }

  // Also allow ~/pi-cwd-* directories created by the default-cwd endpoint.
  try {
    for (const name of readdirSync(homedir())) {
      if (/^pi-cwd-\d{8}$/.test(name)) {
        roots.add(normalizeSlashes(path.join(homedir(), name)));
      }
    }
  } catch {
    // ignore if home is unreadable
  }

  for (const root of getAdditionalAllowedRoots()) roots.add(root);

  globalThis.__piAllowedRootsCache = { roots, expiresAt: now + ALLOWED_ROOTS_TTL_MS };
  return roots;
}

/**
 * File-access sandbox switch. Off by default: the frontend already offers
 * arbitrary-path entry points (custom path input / the file browser accepts any
 * system path), so the backend /api/files session-cwd sandbox contradicts the
 * frontend and is effectively useless — the frontend can pick any path while the
 * backend blocks the very same path recognized by the AI, which makes no sense.
 * All paths are allowed by default, matching the frontend. To restrict access,
 * set env PI_WEB_FILE_SANDBOX=1 to enable the system-wide overall restriction
 * (only session cwd/projectRoot + ~/pi-cwd-* + roots listed in
 * PI_WEB_ALLOWED_ROOTS are allowed); instrumentation registers extra roots at
 * startup.
 */
export function isFileSandboxEnabled(): boolean {
  const v = process.env.PI_WEB_FILE_SANDBOX;
  return v === "1" || v === "true";
}

/** Authorize a path lexically, without touching the filesystem. */
export function isFilePathAllowed(target: string, allowedRoots: Set<string>): boolean {
  if (!isFileSandboxEnabled()) return true; // sandbox off by default: allow all paths
  return isPathWithinRoots(target, allowedRoots);
}

/** Authorize an existing path after resolving symbolic links. */
export function isExistingFilePathAllowed(target: string, allowedRoots: Set<string>): boolean {
  if (!isFileSandboxEnabled()) return true;
  return isExistingPathWithinRoots(target, allowedRoots);
}
