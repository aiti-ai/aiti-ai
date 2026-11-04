/**
 * session-manager — session archiving (.pwarc: brotli random-access container).
 *
 * Format:
 *   "PWARC1\n"
 *   [per-file brotli streams, concatenated]
 *   [manifest.json — one line: { files: [{sessionId,path,offset,size,brotliSize,mtimeMs,sha256}], createdAt }]
 *   [u32 manifest byte length][u32 magic 0x43524157 ("WARC" reversed) ]
 *
 * Per-file independent brotli blocks give random access: extracting one
 * session only decompresses that block (no sequential tar-style scan).
 * sha256 per file lets us verify integrity before deleting originals.
 */
import { createHash, randomUUID } from "node:crypto";
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from "node:zlib";
import {
  existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
  unlinkSync, rmSync, openSync, readSync, closeSync, renameSync,
} from "node:fs";
import { join, dirname } from "node:path";

const MAGIC = "PWARC1\n";
const FOOTER_MAGIC = 0x43524157; // "WARC" as u32
const CACHE_LIMIT_BYTES = 200 * 1024 * 1024;

export interface ArchiveCandidate {
  path: string;
  sessionId: string;
  cwd: string;
  modified: string;
  sizeBytes: number;
  ageDays: number;
}

export interface ArchiveFileEntry {
  sessionId: string;
  path: string;
  offset: number;
  size: number;
  brotliSize: number;
  mtimeMs: number;
  sha256: string;
}

export interface ArchiveManifest {
  version: 1;
  createdAt: string;
  files: ArchiveFileEntry[];
}

/** Collect archive candidates (not running, past age threshold or oversized). */
export function collectCandidates(
  sessions: Array<{ id: string; cwd: string; modified: string }>,
  runningIds: Set<string>,
  opts: { ageDays: number; maxLiveSizeMb: number },
): ArchiveCandidate[] {
  const now = Date.now();
  return sessions
    .filter((s) => !runningIds.has(s.id))
    .map((s) => {
      let sizeBytes = 0;
      let path = "";
      try {
        // path not in the list — caller provides it; fallback: skip
        path = (s as unknown as { path?: string }).path ?? "";
        sizeBytes = path ? statSync(path).size : 0;
      } catch {
        return null;
      }
      const ageDays = (now - Date.parse(s.modified)) / 86400000;
      if (ageDays < opts.ageDays && sizeBytes < opts.maxLiveSizeMb * 1024 * 1024) return null;
      return { path, sessionId: s.id, cwd: s.cwd, modified: s.modified, sizeBytes, ageDays };
    })
    .filter((c): c is ArchiveCandidate => c !== null);
}

/** Package a set of files into one .pwarc; returns { packagePath, entries }. */
export function writeArchive(packagePath: string, files: ArchiveCandidate[]): { entries: ArchiveFileEntry[] } {
  return writeArchiveFromBytes(
    packagePath,
    files.map((f) => ({ sessionId: f.sessionId, path: f.path, bytes: readFileSync(f.path), mtimeMs: statSync(f.path).mtimeMs })),
  );
}

/** A03 ext 真归档：字节直写变体（快照来自 adapter.snapshot 的原始字节，不经临时文件）。
 *  容器格式与 writeArchive 完全一致（MAGIC + brotli 块 + manifest + footer）。 */
export interface ArchiveByteEntry {
  sessionId: string;
  /** layout：写回目标定位串（原始存储路径）——manifest 的 path 字段承载。 */
  path: string;
  bytes: Buffer;
  mtimeMs?: number;
}
export function writeArchiveFromBytes(packagePath: string, files: ArchiveByteEntry[]): { entries: ArchiveFileEntry[] } {
  const streams: Buffer[] = [];
  const entries: ArchiveFileEntry[] = [];
  let offset = MAGIC.length;

  for (const f of files) {
    const raw = f.bytes;
    const hash = createHash("sha256").update(raw).digest("hex");
    const br = brotliCompressSync(raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 } });
    entries.push({
      sessionId: f.sessionId,
      path: f.path,
      offset,
      size: raw.length,
      brotliSize: br.length,
      mtimeMs: f.mtimeMs ?? 0,
      sha256: hash,
    });
    streams.push(br);
    offset += br.length;
  }

  const manifest: ArchiveManifest = { version: 1, createdAt: new Date().toISOString(), files: entries };
  const manifestBuf = Buffer.from(JSON.stringify(manifest));
  const footer = Buffer.alloc(8);
  footer.writeUInt32LE(manifestBuf.length, 0);
  footer.writeUInt32LE(FOOTER_MAGIC, 4);

  const out = Buffer.concat([Buffer.from(MAGIC), ...streams, manifestBuf, footer]);
  mkdirSync(join(packagePath, ".."), { recursive: true });
  writeFileSync(packagePath, out);
  return { entries };
}

export function readArchiveManifest(packagePath: string): ArchiveManifest | null {
  try {
    const st = statSync(packagePath);
    const fd = openSync(packagePath, "r");
    const footer = Buffer.alloc(8);
    readSync(fd, footer, 0, 8, st.size - 8);
    closeSync(fd);
    if (footer.readUInt32LE(4) !== FOOTER_MAGIC) return null;
    const len = footer.readUInt32LE(0);
    const buf = Buffer.alloc(len);
    const fd2 = openSync(packagePath, "r");
    readSync(fd2, buf, 0, len, st.size - 8 - len);
    closeSync(fd2);
    const m = JSON.parse(buf.toString("utf8")) as ArchiveManifest;
    return m.version === 1 ? m : null;
  } catch {
    return null;
  }
}

/** Random access: extract ONE file's brotli block from a .pwarc. */
export function extractFromArchive(packagePath: string, entry: ArchiveFileEntry): Buffer {
  const fd = openSync(packagePath, "r");
  try {
    const buf = Buffer.alloc(entry.brotliSize);
    readSync(fd, buf, 0, entry.brotliSize, entry.offset);
    return brotliDecompressSync(buf);
  } finally {
    closeSync(fd);
  }
}

/** Locate an entry across archive packages by session id. */
export function findEntry(packagesDir: string, sessionId: string): { packagePath: string; entry: ArchiveFileEntry } | null {
  let files: string[];
  try {
    files = readdirSync(packagesDir).filter((f) => f.endsWith(".pwarc"));
  } catch {
    return null;
  }
  for (const f of files) {
    const p = join(packagesDir, f);
    const m = readArchiveManifest(p);
    if (!m) continue;
    const entry = m.files.find((e) => e.sessionId === sessionId);
    if (entry) return { packagePath: p, entry };
  }
  return null;
}

/**
 * 归档包目录（state 层：不可再生数据）。写入侧与读取侧必须都经此函数——
 * 「写 == 读同源」是路径类改动的红线（曾因读写分裂导致恢复/查看/删除全线静默失败 30h+）。
 * 契约：configDir = <extRoot>/config（三目录对称）→ stateDir = <extRoot>/state = dirname(configDir)/state。
 */
export function archivePackagesDir(configDir: string): string {
  return join(dirname(configDir), "state", "archive");
}

/** 解压缓存目录（cache 层：可再生；与归档包物理分离——包在 state/，本目录可随时整体删除）。 */
export function archiveExtractDir(configDir: string): string {
  return join(dirname(configDir), "cache", "archive-extract");
}

/** Extract a session to the on-demand cache; returns the cache file path. */
export function extractToCache(configDir: string, sessionId: string): string | null {
  const hit = findEntry(archivePackagesDir(configDir), sessionId);
  if (!hit) return null;
  const dir = archiveExtractDir(configDir);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `${sessionId}.jsonl`);
  const raw = extractFromArchive(hit.packagePath, hit.entry);
  // integrity check
  const hash = createHash("sha256").update(raw).digest("hex");
  if (hash !== hit.entry.sha256) return null;
  writeFileSync(target, raw);
  enforceCacheLimit(dir);
  return target;
}

function enforceCacheLimit(dir: string) {
  try {
    const files = readdirSync(dir).map((f) => {
      const p = join(dir, f);
      return { p, size: statSync(p).size, mtime: statSync(p).mtimeMs };
    }).sort((a, b) => a.mtime - b.mtime);
    let total = files.reduce((acc, f) => acc + f.size, 0);
    for (const f of files) {
      if (total <= CACHE_LIMIT_BYTES) break;
      unlinkSync(f.p);
      total -= f.size;
    }
  } catch { /* best-effort */ }
}

export function clearCache(configDir: string): number {
  const dir = archiveExtractDir(configDir);
  try {
    const files = readdirSync(dir);
    for (const f of files) unlinkSync(join(dir, f));
    return files.length;
  } catch {
    return 0;
  }
}

export function cacheBytes(configDir: string): number {
  const dir = archiveExtractDir(configDir);
  try {
    return readdirSync(dir).reduce((acc, f) => acc + statSync(join(dir, f)).size, 0);
  } catch {
    return 0;
  }
}

/** Package name: <cwdKey>-<bucket>.pwarc (bucket = last-activity year-month). */
export function packageNameFor(candidates: ArchiveCandidate[]): string {
  const bucket = candidates.length
    ? (candidates[0].modified.slice(0, 7) ?? "archive")
    : "archive";
  const cwdKey = candidates[0]?.cwd
    ? candidates[0].cwd.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)
    : "misc";
  return `${cwdKey}-${bucket}-${randomUUID().slice(0, 8)}.pwarc`;
}

/** Delete a set of original session files after a successful archive. */
export function deleteOriginals(paths: string[]): number {
  let n = 0;
  for (const p of paths) {
    try {
      unlinkSync(p);
      n++;
    } catch { /* already gone */ }
  }
  return n;
}

/**
 * Restore an archived session back to its original live path:
 * extract (sha256-verified) → rewrite the file → remove the entry from the
 * package (rewrite, same as delete) → index rows are cleared by the caller.
 * Fail-safe order: the file is written first; the package is only rewritten
 * after the extraction verified, so an interrupted restore leaves the archive
 * intact (and a re-run converges).
 */
export function restoreFromArchive(configDir: string, sessionId: string): string | null {
  const hit = findEntry(archivePackagesDir(configDir), sessionId);
  if (!hit) return null;
  const raw = extractFromArchive(hit.packagePath, hit.entry);
  if (createHash("sha256").update(raw).digest("hex") !== hit.entry.sha256) return null;
  mkdirSync(dirname(hit.entry.path), { recursive: true });
  writeFileSync(hit.entry.path, raw);
  // Best-effort package rewrite: even if it fails the file is live on disk,
  // so we still report success. The stale package entry is dead weight only
  // (index rows are cleared by the caller, so the merged list shows exactly
  // one live row); a later re-archive simply writes a fresh entry.
  removeFromArchive(configDir, sessionId);
  return hit.entry.path;
}

/**
 * Permanently remove one session from its .pwarc package (rewrite the
 * container without that entry — remaining brotli blocks are copied as-is,
 * no recompression; only manifest offsets shift). An emptied package is
 * deleted. Fail-safe: the rewrite goes to a temp file that must re-parse
 * as a valid manifest before it replaces the original.
 */
export function removeFromArchive(configDir: string, sessionId: string): boolean {
  const hit = findEntry(archivePackagesDir(configDir), sessionId);
  if (!hit) return false;
  const orig = readArchiveManifest(hit.packagePath);
  if (!orig) return false;
  const keep = orig.files.filter((e) => e.sessionId !== sessionId);
  if (keep.length === orig.files.length) return false; // not present (shouldn't happen — findEntry hit)

  if (keep.length === 0) {
    try { unlinkSync(hit.packagePath); } catch { /* best-effort */ }
  } else {
    // copy surviving brotli blocks, recomputing offsets
    let offset = MAGIC.length;
    const streams: Buffer[] = [];
    for (const e of keep) {
      const fd = openSync(hit.packagePath, "r");
      const buf = Buffer.alloc(e.brotliSize);
      try {
        readSync(fd, buf, 0, e.brotliSize, e.offset);
      } finally {
        closeSync(fd);
      }
      streams.push(buf);
      e.offset = offset;
      offset += e.brotliSize;
    }
    const manifestBuf = Buffer.from(JSON.stringify({ version: 1 as const, createdAt: orig.createdAt, files: keep }));
    const footer = Buffer.alloc(8);
    footer.writeUInt32LE(manifestBuf.length, 0);
    footer.writeUInt32LE(FOOTER_MAGIC, 4);
    const tmp = `${hit.packagePath}.tmp`;
    writeFileSync(tmp, Buffer.concat([Buffer.from(MAGIC), ...streams, manifestBuf, footer]));
    // fail-safe: verify the rewrite parses before replacing the original
    if (!readArchiveManifest(tmp)) {
      try { unlinkSync(tmp); } catch { /* best-effort */ }
      return false;
    }
    renameSync(tmp, hit.packagePath);
  }
  // drop any on-demand cache copy of the removed session
  try { unlinkSync(join(archiveExtractDir(configDir), `${sessionId}.jsonl`)); } catch { /* not cached */ }
  return true;
}
