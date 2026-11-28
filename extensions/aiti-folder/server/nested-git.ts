/**
 * nested-git · detect nested git repositories among a directory's direct children.
 *
 * A child directory counts as a repo when it contains its own `.git` — either a directory
 * (normal repo) or a file (submodule / worktree gitfile). Detection is metadata-only
 * (readdir + one stat per child): no git spawn, no recursion — deeper repos are found
 * lazily when their parent directory is listed in the tree.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface NestedRepoEntry { path: string; name: string }
export interface NestedGitScan {
  ok: boolean;
  repos: NestedRepoEntry[];
  /** true when the scan stopped early (more children than the cap) */
  truncated?: boolean;
  error?: string;
}

/** Safety cap: pathological directories (node_modules monorepos) must not stall the scan. */
const MAX_CHILDREN = 500;

export function scanNestedGitRepos(dir: string): NestedGitScan {
  let dirents: ReturnType<typeof readdirSync>;
  try {
    dirents = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return { ok: false, repos: [], error: String((e as Error)?.message || e) };
  }
  const repos: NestedRepoEntry[] = [];
  let truncated = false;
  let checked = 0;
  for (const d of dirents) {
    // isDirectory() is false for symlinks (dirents do not follow), so symlinked children
    // are skipped by construction — a symlink must not pull an outside repo into the scan.
    if (!d.isDirectory() || d.isSymbolicLink()) continue;
    if (d.name === ".git") continue;
    if (++checked > MAX_CHILDREN) { truncated = true; break; }
    try {
      // Covers both shapes: `.git` directory (normal repo) and `.git` file (submodule/worktree).
      if (existsSync(join(dir, d.name, ".git"))) repos.push({ path: join(dir, d.name), name: d.name });
    } catch { /* unreadable child — skip */ }
  }
  return truncated ? { ok: true, repos, truncated } : { ok: true, repos };
}
