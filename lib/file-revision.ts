import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { TEXT_PREVIEW_MAX_BYTES, IMAGE_PREVIEW_MAX_BYTES } from "./file-types.ts";
import { looksBinary, type TextPreviewChunk } from "./text-preview.ts";

/**
 * Revision file access: serve a historical blob (git cat-file) instead of the
 * working-tree file. Used by OpenFileOptions.atRevision ({ ref, gitDir }) —
 * e.g. aiti-git-trace opens the pre-deletion version of a deleted file from
 * its shadow store (<repoRoot>/.aiti-trace), or any client opens a file as of
 * a specific commit in any allowlisted repo.
 *
 * Path convention: the work tree is dirname(gitDir). Holds for both regular
 * repos (<root>/.git) and the trace shadow layout (<root>/.aiti-trace with
 * workTree=repoRoot, see trace-core.ts). relpath = relative(filePath, workTree).
 *
 * Security: ref is a bare hex sha (no revision expressions), git runs via
 * execFile with an argv array (no shell), gitDir must realpath into an allowed
 * file root and contain objects/, relpath must stay inside the work tree, and
 * reads are size-capped (text preview reads at most 256KB + 1 byte semantics
 * with a 5MB blob ceiling, images 10MB, download 25MB) so a huge blob cannot
 * blow the heap.
 */

const execFileAsync = promisify(execFile);

/** A historical blob identity (OpenFileOptions.atRevision → /api/files ref branch). */
export interface RevisionRef {
  /** Bare hex commit sha. */
  ref: string;
  /** Absolute git directory (.git / shadow store); work tree = dirname(gitDir). */
  gitDir: string;
}

export const REVISION_IMAGE_MAX_BYTES = IMAGE_PREVIEW_MAX_BYTES;
export const REVISION_DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024;
/** Hard ceiling for a text read; the client only previews the first chunk anyway. */
export const REVISION_TEXT_READ_MAX_BYTES = 5 * 1024 * 1024;

// Bare hex sha only — blocks revision expressions ("--", "refs/...", "HEAD~1")
// and argv-shaping garbage in one stroke.
const REVISION_REF_RE = /^[0-9a-f]{7,64}$/i;

export function isRevisionRef(ref: string): boolean {
  return REVISION_REF_RE.test(ref);
}

/** relpath of filePath inside the work tree (dirname(gitDir)); null when outside/invalid. */
export function revisionRelPath(filePath: string, gitDir: string): string | null {
  const workTree = path.dirname(gitDir);
  const rel = path.relative(workTree, filePath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

/**
 * Validate + normalize gitDir: must exist, look like a git directory (objects/),
 * and realpath-contain inside one of the allowed roots (mirrors the route's
 * symlink-escape containment). Returns the realpath, or null when rejected.
 */
export function resolveRevisionGitDir(
  gitDir: string,
  allowedRoots: Set<string> | string[],
): string | null {
  let real: string;
  try {
    real = fs.realpathSync(gitDir);
  } catch {
    return null;
  }
  if (!fs.existsSync(path.join(real, "objects"))) return null;
  const realRoots = new Set<string>();
  for (const root of allowedRoots) {
    try { realRoots.add(fs.realpathSync(root)); } catch { realRoots.add(root); }
  }
  const contained = [...realRoots].some((root) => {
    const rel = path.relative(root, real);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
  return contained ? real : null;
}

/** git cat-file -s <ref>:<relpath> → blob byte size (throws when the blob is missing). */
export async function revisionBlobSize(gitDir: string, ref: string, relPath: string): Promise<number> {
  const { stdout } = await execFileAsync(
    "git",
    ["--git-dir", gitDir, "cat-file", "-s", `${ref}:${relPath}`],
    { timeout: 10_000, maxBuffer: 1024 * 1024 },
  );
  return Number.parseInt(stdout.trim(), 10);
}

/** git cat-file -p <ref>:<relpath> → full blob bytes (caller must cap size via revisionBlobSize first).
 *  maxBuffer covers the largest permitted blob (download cap) — the text read cap is
 *  smaller, but a single shared ceiling keeps image/download reads from overflowing it. */
export async function revisionBlobContent(gitDir: string, ref: string, relPath: string): Promise<Buffer> {
  const { stdout } = await execFileAsync(
    "git",
    ["--git-dir", gitDir, "cat-file", "-p", `${ref}:${relPath}`],
    { timeout: 15_000, maxBuffer: REVISION_DOWNLOAD_MAX_BYTES + 1024 * 1024, encoding: "buffer" as BufferEncoding },
  );
  return stdout as unknown as Buffer;
}

// Trim a UTF-8 cut point back to a complete sequence boundary (same rule as
// text-preview's chunker, so a multibyte char never renders as U+FFFD mid-file).
function trimUtf8Boundary(buffer: Buffer, end: number): number {
  if (end >= buffer.length) return end;
  let start = end;
  while (start > end - 4 && start > 0 && (buffer[start] & 0xc0) === 0x80) {
    start--;
  }
  const lead = buffer[start];
  const seqLen = (lead & 0x80) === 0 ? 1
    : (lead & 0xe0) === 0xc0 ? 2
    : (lead & 0xf0) === 0xe0 ? 3
    : (lead & 0xf8) === 0xf0 ? 4
    : 1; // invalid lead byte — leave the cut untouched
  return seqLen > end - start ? start : end;
}

/**
 * Text-preview chunk of a revision blob — same shape/semantics as
 * readTextPreviewChunk (boundary-safe UTF-8 cut, truncated/nextOffset against the
 * full blob size; binary sniff only at offset 0, mirroring the disk chunker).
 * Caller has already capped size via revisionBlobSize (≤ REVISION_TEXT_READ_MAX_BYTES).
 */
export function revisionTextChunk(blob: Buffer, size: number, offset = 0): TextPreviewChunk {
  if (offset === 0 && looksBinary(blob, Math.min(blob.length, 8000))) {
    return { content: "", nextOffset: 0, truncated: false, binary: true };
  }
  let end = Math.min(blob.length, offset + TEXT_PREVIEW_MAX_BYTES);
  if (end < blob.length) end = trimUtf8Boundary(blob, end);
  return {
    content: blob.toString("utf8", offset, end),
    nextOffset: end,
    truncated: end < size,
    binary: false,
  };
}
