/**
 * nested-git (client) · detection cache + status helpers for nested git repositories.
 *
 * Pure module (no React, no host imports) so both the vite bundle and node --test can load it.
 * Detection itself lives server-side (POST /nested-git); this file only caches scan results and
 * turns the git-ops engine's dirtyFiles into GitFileStatus rows for the tree badge merge
 * (semantics mirror core lib/git-status.ts classifyGitStatus).
 */

// ── path normalize (local copy of lib.normSlash: keeps this module dependency-free) ──
function normSlash(p?: string) { return p ? p.replace(/\\/g, "/") : p; }

// ── scan cache (TTL, same pattern as lib.entriesCache; keyed by normalized dir) ──
const NESTED_TTL = 5 * 60 * 1000;
const cache = new Map<string, { repos: string[]; ts: number }>();
function pruneNested() { const now = Date.now(); for (const [k, v] of cache) if (now - v.ts > NESTED_TTL) cache.delete(k); }
function nestedKey(dir: string) { return normSlash(dir) || ""; }
export function invalidateNestedRepos(dir?: string) { if (dir) cache.delete(nestedKey(dir)); else cache.clear(); }
/** Synchronous cache read; null when no fresh scan is cached. */
export function peekNestedRepos(dir: string): string[] | null {
  pruneNested();
  return cache.get(nestedKey(dir))?.repos ?? null;
}
/** Repo dirs (normalized absolute paths) among the direct children of dir; force bypasses the cache. */
export async function fetchNestedRepos(apiUrlFn: (p: string) => string, dir: string, opts?: { force?: boolean }): Promise<string[]> {
  const key = nestedKey(dir);
  pruneNested();
  if (!opts?.force) { const hit = cache.get(key); if (hit) return hit.repos; }
  const r = await fetch(apiUrlFn("/api/extensions/aiti-folder/nested-git"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dir }) });
  const d = await r.json().catch(() => null);
  if (!r.ok || !d?.ok) throw new Error((d && d.error) || "HTTP " + r.status);
  // Server paths carry the OS separator: normalize so comparisons against tree fullPath
  // (always "/") hold on Windows too. The engine accepts either form as cwd.
  const repos = (Array.isArray(d.repos) ? d.repos : []).map((e: any) => normSlash(String(e?.path || ""))).filter(Boolean);
  cache.set(key, { repos, ts: Date.now() });
  return repos;
}

// ── xy → status synthesis ──
const CONFLICT_PAIRS = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
/** Engine dirtyFiles xy pair → GitFileStatus kind. `!!` (ignored) → null (not surfaced). */
export function statusFromXy(xy: string): { status: string; code: string } | null {
  const pair = (xy || "  ").slice(0, 2).padEnd(2, " ");
  if (pair === "??") return { status: "untracked", code: "U" };
  if (pair === "!!") return null;
  if (CONFLICT_PAIRS.has(pair) || pair.includes("U")) return { status: "conflict", code: "C" };
  if (pair.includes("D")) return { status: "deleted", code: "D" };
  if (pair.includes("R") || pair.includes("C")) return { status: "renamed", code: "R" };
  if (pair.includes("A")) return { status: "added", code: "A" };
  return { status: "modified", code: "M" };
}
/** Engine refs.dirtyFiles (repo-relative) → absolute GitFileStatus rows for the badge merge. */
export function nestedStatusRows(repoDir: string, dirtyFiles: { xy: string; path: string }[] | undefined | null): any[] {
  const base = normSlash(repoDir) || "";
  if (!base) return [];
  const out: any[] = [];
  for (const f of Array.isArray(dirtyFiles) ? dirtyFiles : []) {
    if (!f || typeof f.path !== "string" || !f.path) continue;
    const st = statusFromXy(f.xy || "");
    if (!st) continue;
    const rel = f.path.replace(/\\/g, "/").replace(/^\/+/, "");
    out.push({
      filePath: base.replace(/\/+$/, "") + "/" + rel,
      ...st,
      indexStatus: (f.xy || " ")[0] || " ",
      worktreeStatus: (f.xy || "  ")[1] || " ",
    });
  }
  return out;
}
