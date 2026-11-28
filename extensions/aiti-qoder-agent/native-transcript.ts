/**
 * native-transcript — locating and tail-scanning the qoder CLI's own JSONL
 * transcripts (`~/.qoder{,-cn}/projects/<cwd-shard>/<sessionId>.jsonl`).
 *
 * The ACP surface is thin, the transcript is rich: it carries
 * `message.usage.context_usage_ratio` per assistant record (the extension's
 * context-share fallback when no `usage_update` frame arrives) and a
 * `system` / `subtype:"compact_boundary"` record every time the CLI compacts —
 * auto-compaction included, with `compactMetadata.trigger` saying which.
 *
 * Consumers:
 *   - index.ts — context share from `context_usage_ratio` (see readNativeSessionUsage);
 *   - tools/compact-probe-acp.mjs — proof that a `/compact` prompt really compacted
 *     (a "no refusal text" observation alone cannot rule out the prompt having been
 *     forwarded to the model as plain text).
 *
 * Sync-read discipline (engineering red line): never read more than 8MB
 * synchronously; over the cap only the tail is scanned.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Sync-read cap; transcripts of long sessions exceed it routinely. */
export const NATIVE_USAGE_SYNC_READ_MAX = 8 * 1024 * 1024;
/** Tail window when the file is over the cap. */
export const NATIVE_USAGE_TAIL_BYTES = 2 * 1024 * 1024;

const nativeSessionPathCache = new Map<string, string>();

/**
 * Transcript path: the projects dir shards by cwd, and shard-name casing/escaping
 * varies across versions (both `d--` and `D--` seen) -> scan the directories.
 */
export function resolveNativeSessionFile(nativeSid: string): string | undefined {
  if (!nativeSid) return undefined;
  const cached = nativeSessionPathCache.get(nativeSid);
  if (cached && existsSync(cached)) return cached;
  for (const home of [".qoder-cn", ".qoder"]) {
    const projects = join(homedir(), home, "projects");
    let dirs: string[];
    try { dirs = readdirSync(projects); } catch { continue; }
    for (const dir of dirs) {
      const fp = join(projects, dir, `${nativeSid}.jsonl`);
      if (existsSync(fp)) {
        nativeSessionPathCache.set(nativeSid, fp);
        return fp;
      }
    }
  }
  return undefined;
}

/** Read the last `bytes` bytes of a file as UTF-8 (a partial first line is tolerated by the line scanners). */
export function readTailText(fp: string, size: number, bytes: number): string {
  const fd = openSync(fp, "r");
  try {
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** One compaction event as recorded by the CLI. */
export interface CompactBoundary {
  /** "auto" | "manual" (whatever the CLI wrote; absent when it wrote none). */
  trigger?: string;
  preTokens?: number;
  postTokens?: number;
  timestamp?: string;
}

/**
 * Compaction boundaries found in a transcript, oldest first. Empty when the file
 * is unreadable or has never been compacted (never fabricated).
 */
export function transcriptCompactBoundaries(fp: string, opts: { tailBytes?: number; maxBytes?: number } = {}): CompactBoundary[] {
  try {
    const st = statSync(fp);
    const cap = opts.maxBytes ?? NATIVE_USAGE_SYNC_READ_MAX;
    const text = st.size <= cap
      ? readFileSync(fp, "utf8")
      : readTailText(fp, st.size, opts.tailBytes ?? NATIVE_USAGE_TAIL_BYTES);
    return scanCompactBoundaries(text);
  } catch {
    return [];
  }
}

/** Boundary scan over already-read text (split out for tests). */
export function scanCompactBoundaries(text: string): CompactBoundary[] {
  const out: CompactBoundary[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes('"compact_boundary"')) continue;
    let rec: Record<string, unknown>;
    try { rec = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (rec.subtype !== "compact_boundary") continue;
    const meta = (rec.compactMetadata ?? {}) as Record<string, unknown>;
    out.push({
      ...(typeof meta.trigger === "string" ? { trigger: meta.trigger } : {}),
      ...(typeof meta.preTokens === "number" ? { preTokens: meta.preTokens } : {}),
      ...(typeof meta.postTokens === "number" ? { postTokens: meta.postTokens } : {}),
      ...(typeof rec.timestamp === "string" ? { timestamp: rec.timestamp } : {}),
    });
  }
  return out;
}

/** Convenience: boundaries for a live session id (path resolution included). */
export function sessionCompactBoundaries(nativeSid: string): CompactBoundary[] {
  const fp = resolveNativeSessionFile(nativeSid);
  return fp ? transcriptCompactBoundaries(fp) : [];
}
