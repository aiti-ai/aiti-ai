import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import {
  getAllowedFileRoots,
  isExistingFilePathAllowed,
  isFilePathAllowed,
  isWindowsAbsolutePath,
} from "@/lib/file-access";
import { buildEntriesFromFiles, filterFileEntries, type FileIndexEntry } from "@/lib/file-fuzzy";
import { isIgnored, isAitIgnored } from "@/lib/file-ignore";

const execFileAsync = promisify(execFile);

// 忽略规则已改为纯文件驱动（.gitignore + .aitignore，见 lib/file-ignore.ts）——
// 不再有硬编码忽略集合；git 仓库内 .gitignore 由 git ls-files --exclude-standard 承担，
// .aitignore 由 lib/file-ignore 叠加（git 不认识 .aitignore）；非 git 目录 walk 走同一引擎。


/** Cap on the plain (no-query) response used as the client-side index */
const MAX_FILES = 5000;
/** Hard caps on the full in-memory listing that ?q= searches against */
const GIT_HARD_CAP = 200_000;
const WALK_HARD_CAP = 50_000;
const MAX_WALK_DEPTH = 8;
const MAX_QUERY_LENGTH = 500;
const CACHE_TTL_MS = 10_000;
const CACHE_MAX_ENTRIES = 20;

interface FileListing {
  /** Full listing up to the hard cap (not the client cap) */
  files: string[];
  /** True when even the hard cap was exceeded */
  hardTruncated: boolean;
}

interface CacheEntry {
  listing: FileListing;
  /** Derived lazily on the first ?q= search against this listing */
  entries?: FileIndexEntry[];
  expiresAt: number;
}

// Per-cwd cache on globalThis so it survives Next.js hot-reload; the @ menu
// re-requests on every open and searches on every keystroke, so listings must
// not be recomputed within a short window.
declare global {
  var __piFileIndexCache: Map<string, CacheEntry> | undefined;
}

function getIndexCache(): Map<string, CacheEntry> {
  if (!globalThis.__piFileIndexCache) globalThis.__piFileIndexCache = new Map();
  return globalThis.__piFileIndexCache;
}

async function listWithGit(cwd: string): Promise<FileListing | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { timeout: 10_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } },
    );
    const all = stdout.split("\0").filter(Boolean);
    // .gitignore 层由 --exclude-standard 承担；此处叠加 .aitignore（git 不认识它）
    const filtered = all.filter((f) => !isAitIgnored(cwd, f));
    if (filtered.length > GIT_HARD_CAP) {
      return { files: filtered.slice(0, GIT_HARD_CAP), hardTruncated: true };
    }
    return { files: filtered, hardTruncated: false };
  } catch {
    // Not a git repo (or git unavailable) — caller falls back to readdir walk.
    return null;
  }
}

function listWithWalk(cwd: string): FileListing {
  const files: string[] = [];
  // BFS so shallow files win when the cap truncates the listing.
  const queue: Array<{ abs: string; rel: string; depth: number }> = [{ abs: cwd, rel: "", depth: 0 }];
  while (queue.length > 0) {
    const { abs, rel, depth } = queue.shift()!;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      if (isIgnored(abs, d.name, d.isDirectory())) continue;
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (depth + 1 <= MAX_WALK_DEPTH) {
          queue.push({ abs: path.join(abs, d.name), rel: childRel, depth: depth + 1 });
        }
      } else if (d.isFile()) {
        if (files.length >= WALK_HARD_CAP) {
          return { files, hardTruncated: true };
        }
        files.push(childRel);
      }
    }
  }
  return { files, hardTruncated: false };
}

async function handleFileIndex(cwd: string, query: string): Promise<NextResponse> {
  try {
    if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
      return NextResponse.json({ error: "cwd must be an absolute path" }, { status: 400 });
    }

    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(cwd);
    } catch {
      return NextResponse.json({ error: "Directory not found" }, { status: 404 });
    }
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: "Not a directory" }, { status: 400 });
    }
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const cache = getIndexCache();
    const now = Date.now();
    let cached = cache.get(cwd);
    if (!cached || cached.expiresAt <= now) {
      const listing = (await listWithGit(cwd)) ?? listWithWalk(cwd);
      for (const [key, entry] of cache) {
        if (entry.expiresAt <= now) cache.delete(key);
      }
      if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
      cached = { listing, expiresAt: now + CACHE_TTL_MS };
      cache.set(cwd, cached);
    }

    if (query) {
      cached.entries ??= buildEntriesFromFiles(cached.listing.files);
      return NextResponse.json({ matches: filterFileEntries(cached.entries, query) });
    }

    const { files, hardTruncated } = cached.listing;
    return NextResponse.json({
      files: files.slice(0, MAX_FILES),
      truncated: hardTruncated || files.length > MAX_FILES,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// GET /api/file-index?cwd=/abs/path[&q=query] — the query-string form is kept for existing
// callers; cwd/q are also accepted via a POST JSON body (same path, same semantics). Absolute
// paths never land in URLs (access logs/proxy logs), so new code must use POST.
export async function GET(req: NextRequest) {
  const cwd = req.nextUrl.searchParams.get("cwd")?.trim() ?? "";
  const query = req.nextUrl.searchParams.get("q")?.slice(0, MAX_QUERY_LENGTH) ?? "";
  return handleFileIndex(cwd, query);
}

export async function POST(req: NextRequest) {
  let cwd = "";
  let query = "";
  try {
    const body = (await req.json()) as { cwd?: unknown; q?: unknown };
    cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    query = typeof body.q === "string" ? body.q.slice(0, MAX_QUERY_LENGTH) : "";
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  return handleFileIndex(cwd, query);
}
