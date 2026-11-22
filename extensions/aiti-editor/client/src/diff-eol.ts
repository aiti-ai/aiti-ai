/**
 * Diff text helpers for the git change view (pure functions, no DOM).
 *
 * Why this exists: the HEAD baseline comes from `git show` (raw blob) while the
 * working copy is read from disk. The same file can therefore differ only in
 * line endings (LF blob vs CRLF worktree, a common Windows checkout state),
 * and diff-match-patch reports that as a whole-file replacement. We compare
 * with normalized EOLs and keep the on-disk bytes untouched (saving must never
 * rewrite line endings).
 *
 * Plan: docs/aiti-editor-git-diff-eol-normalize-plan.md
 */

export type EolKind = "lf" | "crlf" | "mixed" | "none";

/** Normalize CRLF/CR to LF. Comparison only — never feed this to a save path. */
export function normalizeDiffEol(text: string): string {
  return String(text ?? "").replace(/\r\n?/g, "\n");
}

/** Classify a text's line endings (used for the badge diagnostic tooltip). */
export function detectEolKind(text: string): EolKind {
  const s = String(text ?? "");
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) !== 10) continue;
    if (i > 0 && s.charCodeAt(i - 1) === 13) crlf++;
    else lf++;
  }
  if (crlf === 0 && lf === 0) return "none";
  if (crlf > 0 && lf > 0) return "mixed";
  return crlf > 0 ? "crlf" : "lf";
}

/** True when two texts are identical after EOL normalization but not before. */
export function isEolOnlyChange(original: string, current: string): boolean {
  const a = String(original ?? "");
  const b = String(current ?? "");
  if (a === b) return false;
  return normalizeDiffEol(a) === normalizeDiffEol(b);
}

/** Line count of a diff segment (same semantics the hunk builder needs). */
export function countLines(text: string): number {
  const s = String(text ?? "");
  if (!s) return 0;
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return s.endsWith("\n") ? n : n + 1;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  adds: number;
  dels: number;
  preview: string;
}

/**
 * Turn dmp line diffs into git-style hunks. Single data source for the latest
 * view decorations, the outline list and the badge counts.
 */
export function hunksFromDiffs(diffs: Array<[number, string]>): DiffHunk[] {
  let oldLine = 1;
  let newLine = 1;
  const hunks: DiffHunk[] = [];
  let cur: DiffHunk | null = null;
  for (const [op, text] of diffs) {
    const n = countLines(text);
    if (op === 0) {
      if (cur) { hunks.push(cur); cur = null; }
      oldLine += n;
      newLine += n;
      continue;
    }
    if (!cur) cur = { oldStart: oldLine, oldLines: 0, newStart: newLine, newLines: 0, adds: 0, dels: 0, preview: "" };
    if (op === -1) {
      cur.oldLines += n;
      cur.dels += n;
      oldLine += n;
    } else {
      cur.newLines += n;
      cur.adds += n;
      newLine += n;
      if (!cur.preview) cur.preview = String(text.split("\n")[0] || "").slice(0, 80);
    }
  }
  if (cur) hunks.push(cur);
  return hunks;
}

export interface Numstat {
  adds: number | null;
  dels: number | null;
}

export interface DiffCounts {
  adds: number | null;
  dels: number | null;
  source: "dmp" | "numstat" | "none";
}

/**
 * Counts source of truth. Once dmp has run it wins (including a zero-hunk
 * result), so the badge always matches the decorations/outline. numstat is a
 * fallback for large files (dmp skipped) and for the pre-baseline window.
 */
export function pickDiffCounts(args: {
  hunks: DiffHunk[];
  dmpComputed: boolean;
  numstat?: Numstat | null;
}): DiffCounts {
  if (args.dmpComputed) {
    let adds = 0;
    let dels = 0;
    for (const h of args.hunks) {
      adds += h.adds || 0;
      dels += h.dels || 0;
    }
    return { adds, dels, source: "dmp" };
  }
  const ns = args.numstat;
  if (ns && (ns.adds !== null || ns.dels !== null)) {
    return { adds: ns.adds, dels: ns.dels, source: "numstat" };
  }
  return { adds: null, dels: null, source: "none" };
}
