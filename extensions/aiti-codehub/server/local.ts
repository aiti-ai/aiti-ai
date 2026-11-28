/**
 * Local clone discovery: scan configured roots for a .git/config whose remote URL
 * matches the repository clone URLs (SSH/HTTPS normalized).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface LocalCloneResult {
  found: boolean;
  path?: string;
  remote?: string;
}

const cache = new Map<string, { at: number; result: LocalCloneResult }>();
const TTL_MS = 60_000;

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (/^~[\\/]/.test(p)) return join(homedir(), p.slice(2));
  return p;
}

/** Normalize git remote URLs: strip .git, lowercase host, map ssh scp syntax to https-ish. */
export function normalizeRemote(url: string): string {
  let s = String(url || "").trim();
  if (!s) return "";
  s = s.replace(/\.git$/i, "");
  const scp = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/i.exec(s);
  if (scp) return `${scp[1].toLowerCase()}/${scp[2]}`.toLowerCase();
  try {
    const u = new URL(s);
    return `${u.hostname.toLowerCase()}${u.pathname.replace(/\.git$/i, "")}`.replace(/\/+$/, "").toLowerCase();
  } catch {
    return s.toLowerCase();
  }
}

function readRemote(configPath: string): string {
  try {
    const raw = readFileSync(configPath, "utf8");
    const m = /\[remote\s+"origin"\][^\[]*?url\s*=\s*(.+)/i.exec(raw);
    return m ? m[1].trim() : "";
  } catch {
    return "";
  }
}

function scanRoot(root: string, wanted: Set<string>, depth: number, budget: { n: number }): string | null {
  if (depth < 0 || budget.n <= 0) return null;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return null;
  }
  const dirs: string[] = [];
  // Pass 1: check every sibling's .git first (top-level clones are the common case),
  // so a huge unrelated tree cannot exhaust the budget before we reach the target.
  for (const name of entries) {
    if (budget.n-- <= 0) return null;
    if (name.startsWith(".") || name === "node_modules") continue;
    const dir = join(root, name);
    let st;
    try { st = statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    const gitConfig = join(dir, ".git", "config");
    if (existsSync(gitConfig)) {
      const remote = readRemote(gitConfig);
      if (remote && wanted.has(normalizeRemote(remote))) return dir;
    }
    dirs.push(dir);
  }
  // Pass 2: recurse.
  if (depth > 0) {
    for (const dir of dirs) {
      const hit = scanRoot(dir, wanted, depth - 1, budget);
      if (hit) return hit;
    }
  }
  return null;
}

export function findLocalClone(opts: { repo: { cloneSsh?: string; cloneHttp?: string; path?: string }; roots: string[]; cwd?: string }): LocalCloneResult {
  const wanted = new Set(
    [opts.repo.cloneSsh, opts.repo.cloneHttp]
      .filter(Boolean)
      .map((u) => normalizeRemote(String(u))),
  );
  // Also match by repository path suffix (owner/repo) when the clone URL is unknown.
  const suffix = String(opts.repo.path || "").toLowerCase();
  const roots = [...new Set([...(opts.cwd ? [opts.cwd] : []), ...opts.roots.map(expandHome)].filter(Boolean))];
  const key = `${[...wanted].sort().join("|")}|${suffix}|${roots.join(",")}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.result;

  for (const root of roots) {
    const abs = resolve(root);
    if (!existsSync(abs)) continue;
    const budget = { n: 2000 };
    const found = scanRoot(abs, wanted, 2, budget);
    if (found) {
      const result = { found: true, path: found, remote: readRemote(join(found, ".git", "config")) };
      cache.set(key, { at: Date.now(), result });
      return result;
    }
  }
  // Fallback: suffix match on the remote path (e.g. repo path owner/repo).
  if (suffix) {
    for (const root of roots) {
      const abs = resolve(root);
      if (!existsSync(abs)) continue;
      const budget = { n: 2000 };
      const found = scanBySuffix(abs, suffix, 2, budget);
      if (found) {
        const result = { found: true, path: found, remote: readRemote(join(found, ".git", "config")) };
        cache.set(key, { at: Date.now(), result });
        return result;
      }
    }
  }
  const result: LocalCloneResult = { found: false };
  cache.set(key, { at: Date.now(), result });
  return result;
}

function scanBySuffix(root: string, suffix: string, depth: number, budget: { n: number }): string | null {
  if (depth < 0 || budget.n <= 0) return null;
  let entries: string[];
  try { entries = readdirSync(root); } catch { return null; }
  for (const name of entries) {
    if (budget.n-- <= 0) return null;
    if (name.startsWith(".") || name === "node_modules") continue;
    const dir = join(root, name);
    let st;
    try { st = statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    const gitConfig = join(dir, ".git", "config");
    if (existsSync(gitConfig)) {
      const remote = readRemote(gitConfig);
      if (remote && normalizeRemote(remote).endsWith("/" + suffix)) return dir;
    }
    if (depth > 0) {
      const hit = scanBySuffix(dir, suffix, depth - 1, budget);
      if (hit) return hit;
    }
  }
  return null;
}
