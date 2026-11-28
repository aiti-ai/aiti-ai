/**
 * rsync-style directory sync (pure node, zero deps, cross-platform win/linux/mac).
 *
 * syncDir(src, dst, { del, exclude, keepHashedMs }) — incrementally syncs src into dst:
 *   - copies only when the target is missing or (mtimeMs, size) differs (incrementally skips identical files)
 *   - with del: true, removes files/directories in dst that src lacks (rsync --delete semantics);
 *     deletion/overwrite failures on process-locked files only warn and skip, **never abort** (Windows file-lock friendly)
 *   - exclude(rel): exclusion rule; rel is a path relative to srcDir (always / separated);
 *     excluded entries are neither copied nor deleted (protects node_modules etc. installed by npm
 *     install inside the deployment directory)
 *   - delGraceMs (default 6h, only with del: true): dst-only files whose mtime is inside the window are
 *     not deleted. Motivation: vite lazy chunks are **imported only on click**, while a deployment
 *     --deletes the previous round's chunks outright -> a page opened before the deploy clicks an entry
 *     (e.g. All Sessions), fetches the old chunk name, 404s -> the panel "won't open" and the top bar
 *     goes unresponsive (evidence 2026-09-22: after concurrent dev deploys, sessions-panel-BjL2YIya.js
 *     404ed and a user reported "All Sessions won't open anymore"). A file's mtime = the deploy copy
 *     moment (copyFileSync does not preserve the source mtime), so inside the window = artifacts left by
 *     the most recent deploy; only past the window are they cleaned (the disk must not grow forever).
 *     Pass 0 to restore immediate deletion.
 *
 * Deployment usage (replaces "rmSync the whole directory + full re-copy"):
 *   import { syncDir } from "@aiti-ai/ext-shared/sync-dir";
 *   const st = syncDir(resolve(root, "dist"), resolve(dest, "dist"), { del: true });
 *   // st = { copied, skipped, deleted, kept }
 */
import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";

/** Leftover retention window (ms, only with del: true): leftovers inside the window (= copied in by the most recent deploy) are not deleted; rationale in the file header. */
const DEL_GRACE_MS = 6 * 3600 * 1000;

function copyChunk(src, dst) {
  try {
    copyFileSync(src, dst);
    return true;
  } catch {
    // On Windows, when the target is locked and the overwrite fails: rename the old file out of the way first, then copy (rename usually works on open handles)
    try {
      renameSync(dst, dst + ".old-" + Date.now());
      copyFileSync(src, dst);
      return true;
    } catch {
      console.warn("[sync-dir] skipping a locked file: " + dst);
      return false;
    }
  }
}

export function syncDir(srcDir, dstDir, { del = false, exclude = null, delGraceMs = DEL_GRACE_MS } = {}) {
  let copied = 0, skipped = 0, deleted = 0, kept = 0;
  const relOf = (parentRel, name) => (parentRel ? parentRel + "/" + name : name);
  const walk = (src, dst, rel) => {
    mkdirSync(dst, { recursive: true });
    const names = new Set();
    for (const name of readdirSync(src)) {
      if (exclude && exclude(relOf(rel, name))) continue;
      names.add(name);
    }
    // src -> dst: copy only new/changed files
    for (const name of names) {
      const s = join(src, name), d = join(dst, name);
      const st = statSync(s);
      if (st.isDirectory()) { walk(s, d, relOf(rel, name)); continue; }
      let same = false;
      try {
        const dt = statSync(d);
        same = dt.size === st.size && dt.mtimeMs === st.mtimeMs;
      } catch { /* dst lacks this file */ }
      if (same) { skipped++; continue; }
      if (copyChunk(s, d)) copied++;
    }
    // dst cleanup of what src lacks (--delete; excluded entries are protected from deletion)
    if (del) {
      for (const name of readdirSync(dst)) {
        if (names.has(name)) continue;
        if (exclude && exclude(relOf(rel, name))) continue;
        const d = join(dst, name);
        if (delGraceMs > 0) {
          let age = Infinity;
          try { age = Date.now() - statSync(d).mtimeMs; } catch { /* unreadable treated as oldest, delete anyway */ }
          if (age < delGraceMs) { kept++; continue; } // last deploy's artifact: an open page may still point at it
        }
        try {
          rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
          deleted++;
        } catch {
          console.warn("[sync-dir] failed to delete a surplus file (locked?): " + d);
        }
      }
    }
  };
  if (!existsSync(srcDir)) throw new Error("syncDir: source directory does not exist " + srcDir);
  walk(srcDir, dstDir, "");
  return { copied, skipped, deleted, kept };
}
