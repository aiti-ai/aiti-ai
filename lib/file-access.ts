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
 * 文件访问沙箱开关。默认关闭:前端已提供任意路径入口(自定义路径/文件浏览器可手动输入
 * 任意系统路径打开),后端 /api/files 的会话 cwd 沙箱与前端矛盾且形同虚设——前端能选任意
 * 路径、后端却挡 AI 识别出的同一路径,不合理。默认放行所有路径,与前端一致。
 * 需要限制时设 env PI_WEB_FILE_SANDBOX=1 启用系统级总体限制(仅允许会话 cwd/projectRoot
 * + ~/pi-cwd-* + PI_WEB_ALLOWED_ROOTS 指定根);instrumentation 启动时注册额外根。
 */
export function isFileSandboxEnabled(): boolean {
  const v = process.env.PI_WEB_FILE_SANDBOX;
  return v === "1" || v === "true";
}

/** Authorize a path lexically, without touching the filesystem. */
export function isFilePathAllowed(target: string, allowedRoots: Set<string>): boolean {
  if (!isFileSandboxEnabled()) return true; // 默认关闭沙箱:放行所有路径
  return isPathWithinRoots(target, allowedRoots);
}

/** Authorize an existing path after resolving symbolic links. */
export function isExistingFilePathAllowed(target: string, allowedRoots: Set<string>): boolean {
  if (!isFileSandboxEnabled()) return true;
  return isExistingPathWithinRoots(target, allowedRoots);
}
