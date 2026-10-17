import {
  SessionManager,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { openSync, closeSync, existsSync, fstatSync, readFileSync, readSync, readdirSync, statSync, watch, type Dirent, type Stats } from "fs";
import { homedir } from "node:os";
import { open as openFileAsync, readdir } from "fs/promises";
import { basename, dirname, isAbsolute, join, normalize as normalizePath, relative, resolve as resolvePath, sep } from "path";
import { writePrivateFileAtomicSync } from "./atomic-file.ts";
import type { AgentMessage, ImageContent, SessionEntry, SessionHeader, SessionInfo, SessionContext } from "./types.ts";
import type { SessionEntry as PiSessionEntry, SessionInfo as PiSessionInfo } from "@earendil-works/pi-coding-agent";
import { normalizeToolCalls } from "./normalize.ts";
import { withoutMessageSignatures } from "./message-signatures.ts";
import { deriveRunOutcome, type SessionLastRun } from "./run-outcome.ts";
import { getThinkingPreview, isMessageGroupAnchor } from "./message-display.ts";
import { projectIdentityKey } from "./project-identity.ts";
import { sessionPathKey } from "./session-path.ts";
import { skillExpansionToCommand } from "./slash-display.ts";
import { MAX_TOOL_RESULT_IMAGE_BYTES, TOOL_RESULT_IMAGE_MIMES } from "./tool-result-images.ts";
import { resolveProject, type ProjectInfo } from "./worktree.ts";
import { readSubagentRun, SUBAGENT_META_TYPE } from "./subagents.ts";
import { checkSessionMembership, listSessionsIncremental, scanSessionFileInfo, type ScannedSessionInfo } from "./session-list-scanner.ts";

export { getAgentDir };

// Incremental session-list scanning (§5.4 of docs/all-sessions-panel.zh-CN.md)
//
// SessionManager.listAll() re-parses EVERY line of EVERY session file on each
// call (including allMessagesText, which pi-web does not use). For long-running
// installs (thousands of sessions) that is wasteful. Instead we keep a disk
// cache keyed by (mtimeMs, size); unchanged files reuse cached metadata and only
// changed files are re-parsed (stat-only scans are cheap).
// ============================================================================

export interface SessionFileInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
  parentSessionPath?: string;
  /**
   * Outcome of the most recent run (derived from the last assistant message's
   * stopReason/errorMessage, see lib/run-outcome.ts): failed/aborted/interrupted
   * drive list anomaly markers and completion-notice routing. No assistant
   * message = field absent. While the session is running, the UI prioritizes `running`.
   */
  lastRun?: SessionLastRun;
  /**
   * External subagent (pi-subagents ecosystem artifact): spawn-mode subagent
   * sessions land at
   *   <sessions>/<cwdDir>/<parentDirName>/<runUuid>/run-N/session.jsonl
   * The header carries no parentSession marker (the parent/child relation is
   * conveyed via env vars), so it is inferred from the on-disk path.
   * parentId = the last segment of parentDirName (parent session uuid);
   * profile is a best-effort read from the run artifact name.
   */
  externalSubagent?: { profile?: string; parentId: string };
}

interface ListCacheEntry {
  mtimeMs: number;
  size: number;
  /**
   * Byte offset parsed so far (baseline for append-only incremental parsing):
   * the next scan only parses lines appended after it. Missing = the entry has
   * no offset baseline yet (cache written by an older version); once its file
   * changes, a full parse runs and the offset is recorded.
   */
  offset?: number;
  info: SessionFileInfo;
}

interface ListCacheFile {
  version: number;
  updatedAt: string;
  files: Record<string, ListCacheEntry>;
}

const LIST_CACHE_VERSION = 3; // v2: derive adds pi-subagents nested artifact path inference (externalSubagent); entry offset added for backward compat (old caches lack offset → one full parse on change backfills it); v3: added lastRun (session run-outcome derivation; old caches lack the field → one full rescan)
const LIST_CACHE_FILENAME = "session_list_cache.json";

function isMessageWithContent(message: AgentMessage): boolean {
  return typeof message.role === "string" && "content" in message;
}

/** Mirrors the SDK's extractTextContent so firstMessage matches pi exactly. */
function extractTextContent(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type?: string; text?: string }>)
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join(" ");
}

/** Mirrors the SDK's getMessageActivityTime (entry-level timestamp semantics). */
function getMessageActivityTime(entry: SessionEntry & { message?: AgentMessage }): number | undefined {
  const message = entry.message;
  if (!message || !isMessageWithContent(message)) return undefined;
  if (message.role !== "user" && message.role !== "assistant") return undefined;
  const msgTimestamp = message.timestamp;
  if (typeof msgTimestamp === "number") return msgTimestamp;
  const t = Date.parse(entry.timestamp);
  return Number.isNaN(t) ? undefined : t;
}

/**
 * Parse one session file into the same fields SessionManager.listAll() derives
 * (id/cwd/name/created/modified/messageCount/firstMessage/parentSessionPath),
 * reusing the SDK's entry parser. null when the file is not a session.
 */
export function deriveSessionFileInfo(filePath: string): SessionFileInfo | null {
  return deriveSessionFileInfoFull(filePath)?.info ?? null;
}

/**
 * Full parse + record the parse end (byte offset, the baseline for subsequent
 * incremental parsing). ⚠ Reads the whole file synchronously and JSON.parses
 * line by line — large sessions (10-20MB) take seconds, so use only for a
 * first parse or an invalidated baseline (truncation, missing offset); routine
 * appends go through deriveSessionFileInfoAppended.
 */
function deriveSessionFileInfoFull(filePath: string): { info: SessionFileInfo; parsedEnd: number } | null {
  const header = readSessionHeader(filePath);
  if (!header) return null;
  let name: string | undefined;
  let messageCount = 0;
  let firstMessage = "";
  let lastActivity: number | undefined;
  let lastAssistant: { stopReason?: string; errorMessage?: string; timestamp?: number } | undefined;
  for (const e of getSessionEntries(filePath)) {
    if (e.type === "session_info") {
      name = e.name?.trim() || undefined;
      continue;
    }
    if (e.type !== "message") continue;
    messageCount++;
    const ts = getMessageActivityTime(e as SessionEntry & { message?: AgentMessage });
    if (typeof ts === "number") lastActivity = Math.max(lastActivity ?? 0, ts);
    const msg = (e as { message?: AgentMessage }).message;
    if (!msg || (msg.role !== "user" && msg.role !== "assistant")) continue;
    if (msg.role === "assistant") {
      // Overwritten each time → ends up as the last assistant message in the session file (including error messages with empty content)
      lastAssistant = {
        stopReason: (msg as { stopReason?: string }).stopReason,
        errorMessage: (msg as { errorMessage?: string }).errorMessage,
        timestamp: typeof ts === "number" ? ts : undefined,
      };
    }
    const text = extractTextContent(msg);
    if (!text) continue;
    if (!firstMessage && msg.role === "user") firstMessage = text;
  }
  const headerTime = Date.parse(header.timestamp);
  const modified = typeof lastActivity === "number" && lastActivity > 0
    ? new Date(lastActivity)
    : !Number.isNaN(headerTime)
      ? new Date(headerTime)
      : statSync(filePath).mtime;
  // pi-subagents artifact adaptation: spawn-mode subagent sessions land at
  //   <sessions>/<cwdDir>/<parentDirName>/<runUuid>/run-N/session.jsonl
  // The header has no parentSession (it conveys the parent/child relation via
  // env vars), so the parent session file is inferred from the on-disk path;
  // profile is extracted best-effort from sibling subagent-artifacts/<runUuid>_<profile>_transcript.jsonl.
  let parentSessionPath = header.parentSession;
  let externalSubagent: SessionFileInfo["externalSubagent"];
  if (!parentSessionPath) {
    const m = filePath.match(/\/([^/]+)\/([^/]+)\/run-\d+\/session\.jsonl$/);
    if (m) {
      const candidate = `${filePath.slice(0, m.index)}/${m[1]}.jsonl`;
      if (existsSync(candidate)) {
        parentSessionPath = candidate;
        // pi session filenames are <timestamp>_<uuid>; the last segment is the parent session id (still resolvable after the parent file is archived)
        const parentId = m[1].includes("_") ? m[1].split("_").pop()! : m[1];
        let profile: string | undefined;
        try {
          const artsDir = join(dirname(dirname(filePath)), "subagent-artifacts");
          const hit = readdirSync(artsDir).find(
            (f) => f.startsWith(`${m[2]}_`) && f.endsWith("_transcript.jsonl"),
          );
          if (hit) profile = hit.slice(m[2].length + 1, -"_transcript.jsonl".length) || undefined;
        } catch {
          // no artifacts dir (cleaned up / older version) — leave profile empty
        }
        externalSubagent = { profile, parentId };
      }
    }
  }
  let parsedEnd: number;
  try {
    parsedEnd = statSync(filePath).size;
  } catch {
    return null; // file vanished mid-parse
  }
  const lastRun = lastAssistant
    ? deriveRunOutcome([{ role: "assistant", ...lastAssistant }], modified.toISOString())
    : undefined;
  return {
    info: {
      path: filePath,
      id: header.id,
      cwd: header.cwd ?? "",
      name,
      created: new Date(header.timestamp),
      modified,
      messageCount,
      firstMessage: firstMessage || "(no messages)",
      parentSessionPath: parentSessionPath || undefined,
      ...(externalSubagent ? { externalSubagent } : {}),
      ...(lastRun ? { lastRun } : {}),
    },
    parsedEnd,
  };
}

/**
 * Append-only incremental parse: only the bytes appended after prev.offset are
 * parsed, with accumulation semantics mirroring the full parse entry by entry
 * (message count, user/assistant activity timestamps, first user message,
 * session_info renames with last-writer-wins). Returns null = baseline invalid
 * (no offset / truncated rewrite / read failure); the caller falls back to a
 * full parse. IO goes through fs.promises async reads so the event loop is
 * never blocked (server hard rule).
 *
 * The header line is re-read on every increment (bounded single line,
 * negligible cost): the header is mutable metadata and can be rewritten in
 * place — move rewrites cwd as a same-length replacement, leaving size
 * unchanged and bypassing the mtime/size invalidation check. Judging by
 * size>=offset alone would mistake such a rewrite for "zero appends" and keep
 * the stale info.cwd, permanently wedging the cache entry. Baseline identity
 * is verified via header.id; cwd always comes from the header.
 */
async function deriveSessionFileInfoAppended(
  filePath: string,
  prev: ListCacheEntry,
  st: Pick<Stats, "size">,
): Promise<{ info: SessionFileInfo; parsedEnd: number } | null> {
  const start = prev.offset;
  if (typeof start !== "number" || !Number.isFinite(start) || start < 0) return null;
  if (st.size < start) return null; // truncated / rewritten — full re-parse
  const header = readSessionHeader(filePath);
  if (!header?.id || header.id !== prev.info.id) return null; // rewritten with different session — full re-parse
  const liveCwd = header.cwd ?? prev.info.cwd;
  if (st.size === start) return { info: { ...prev.info, cwd: liveCwd }, parsedEnd: start }; // mtime-only change, no appended bytes

  let chunk: string;
  try {
    const fh = await openFileAsync(filePath, "r");
    try {
      const buf = Buffer.allocUnsafe(st.size - start);
      const { bytesRead } = await fh.read(buf, 0, buf.length, start);
      chunk = buf.toString("utf8", 0, bytesRead);
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }

  let name = prev.info.name;
  let messageCount = prev.info.messageCount;
  let firstMessage = prev.info.firstMessage;
  let lastActivityMs = prev.info.modified.getTime();
  // Last assistant message within this appended segment (if none, keep prev's lastRun — derived from the older segment)
  let appendedLastAssistant: { stopReason?: string; errorMessage?: string; timestamp?: number } | undefined;
  // \n is never part of a multi-byte UTF-8 sequence (self-synchronizing encoding), so splitting lines at the string level is safe.
  let end = start;
  let lineStart = 0;
  for (;;) {
    const nl = chunk.indexOf("\n", lineStart);
    const isTail = nl === -1;
    const line = isTail ? chunk.slice(lineStart) : chunk.slice(lineStart, nl);
    // Same semantics as the SDK's parseSessionEntryLine: blank/malformed lines
    // are skipped; a fully parseable trailing line without a newline also counts
    // (the writer's window before appending \n); a torn half line waits for the
    // next round (end does not advance past it).
    const entry = line.trim() ? tryParseEntryLine(line) : null;
    if (entry) {
      if (entry.type === "session_info") {
        name = (entry as { name?: string }).name?.trim() || undefined;
      } else if (entry.type === "message") {
        messageCount++;
        const ts = getMessageActivityTime(entry as SessionEntry & { message?: AgentMessage });
        if (typeof ts === "number" && ts > lastActivityMs) lastActivityMs = ts;
        const msg = (entry as { message?: AgentMessage }).message;
        if (msg?.role === "assistant") {
          appendedLastAssistant = {
            stopReason: (msg as { stopReason?: string }).stopReason,
            errorMessage: (msg as { errorMessage?: string }).errorMessage,
            timestamp: typeof ts === "number" ? ts : undefined,
          };
        }
        if (!firstMessage || firstMessage === "(no messages)") {
          if (msg?.role === "user") {
            const text = extractTextContent(msg);
            if (text) firstMessage = text;
          }
        }
      }
    }
    if (isTail) {
      if (entry) end = start + Buffer.byteLength(chunk, "utf8");
      break;
    }
    end = start + nl + 1;
    lineStart = nl + 1;
  }

  const lastRun = appendedLastAssistant
    ? deriveRunOutcome([{ role: "assistant", ...appendedLastAssistant }], new Date(lastActivityMs).toISOString())
    : prev.info.lastRun;
  return {
    info: {
      ...prev.info,
      cwd: liveCwd, // the header may be rewritten in place by move (same-length replacement bypasses the mtime/size check); header wins
      name,
      messageCount,
      firstMessage,
      modified: new Date(lastActivityMs),
      ...(lastRun ? { lastRun } : {}),
    },
    parsedEnd: end,
  };
}

function tryParseEntryLine(line: string): SessionEntry | null {
  try {
    return JSON.parse(line) as SessionEntry;
  } catch {
    return null;
  }
}

function readListCache(root: string): ListCacheFile | null {
  const p = join(root, LIST_CACHE_FILENAME);
  try {
    let diskMtimeMs: number;
    try {
      diskMtimeMs = statSync(p).mtimeMs;
    } catch {
      memListCache = null;
      return null;
    }
    // In-memory layer: synchronously parsing a 1.5MB+ JSON on every scan is
    // costly (when dev/prod instances share the sessions dir, the other side's
    // writes change the mtime → automatic invalidation and re-read, which is
    // semantically safe).
    if (memListCache?.root === root && memListCache.diskMtimeMs === diskMtimeMs) {
      return memListCache.cache;
    }
    const raw = JSON.parse(readFileSync(p, "utf8")) as ListCacheFile;
    if (raw?.version !== LIST_CACHE_VERSION) return null;
    // JSON round-trip turns Dates into strings — restore them.
    for (const entry of Object.values(raw.files)) {
      entry.info.created = new Date(entry.info.created);
      entry.info.modified = new Date(entry.info.modified);
    }
    memListCache = { root, cache: raw, diskMtimeMs };
    return raw;
  } catch {
    return null;
  }
}

let memListCache: { root: string; cache: ListCacheFile; diskMtimeMs: number } | null = null;

function writeListCache(root: string, cache: ListCacheFile): void {
  try {
    writePrivateFileAtomicSync(join(root, LIST_CACHE_FILENAME), JSON.stringify(cache));
    // Synchronously point the in-memory layer at the version just written (avoids a disk re-read next scan from the mtime change).
    try {
      memListCache = { root, cache, diskMtimeMs: statSync(join(root, LIST_CACHE_FILENAME)).mtimeMs };
    } catch {
      memListCache = null;
    }
  } catch {
    // Non-fatal: the in-memory result is still correct; next scan rebuilds.
  }
}

/**
 * Changed-file parsing: incremental first (append-only segments, KB-scale per
 * pass), falling back to a full parse when the baseline is missing or invalid.
 * Yields the event loop in batches by parsed bytes (setImmediate) — a cold
 * scan of a large store (1500+ files, active sessions 10-20MB) no longer
 * freezes other dev-server requests (server hard rule: no long blocking).
 */
async function parseChangedEntries(
  items: Array<{ path: string; st: Stats; prev: ListCacheEntry | null }>,
): Promise<Array<{ info: SessionFileInfo; mtimeMs: number; size: number; offset?: number }>> {
  const out: Array<{ info: SessionFileInfo; mtimeMs: number; size: number; offset?: number }> = [];
  let parsedBytesSinceYield = 0;
  let filesSinceYield = 0;
  for (const item of items) {
    const appended = item.prev ? await deriveSessionFileInfoAppended(item.path, item.prev, item.st) : null;
    const full = appended ?? deriveSessionFileInfoFull(item.path);
    if (full) {
      out.push({ info: full.info, mtimeMs: item.st.mtimeMs, size: item.st.size, offset: full.parsedEnd });
    }
    // Yield budget: incremental segments count only the bytes actually parsed; full parses count the whole file (one synchronous block).
    parsedBytesSinceYield += appended
      ? Math.max(0, item.st.size - (item.prev?.offset ?? 0))
      : item.st.size;
    if (++filesSinceYield >= 16 || parsedBytesSinceYield >= 1_000_000) {
      filesSinceYield = 0;
      parsedBytesSinceYield = 0;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  return out;
}

/**
 * List session files under a sessions root (same layout the SDK scans:
 * <root>/<encoded-cwd>/*.jsonl). Additionally discovers pi-subagents nested
 * run artifacts: <root>/<cwdDir>/<parentDir>/<runUuid>/run-N/session.jsonl
 * (bounded depth + fixed names — no arbitrary recursion).
 */
export function listSessionFiles(root: string): string[] {
  const files: string[] = [];
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => join(root, e.name));
  } catch {
    return files;
  }
  for (const dir of dirs) {
    try {
      for (const f of readdirSync(dir)) {
        if (f.endsWith(".jsonl")) files.push(join(dir, f));
      }
    } catch {
      // unreadable dir — skip
    }
    // pi-subagents nested artifacts: the parent dir name matches the parent
    // session file, and the next two levels are fixed as
    // <runUuid>/run-N/session.jsonl. Only fixed names are probed — no arbitrary recursion.
    try {
      for (const sub of readdirSync(dir, { withFileTypes: true })) {
        if (!sub.isDirectory() && !sub.isSymbolicLink()) continue;
        const subDir = join(dir, sub.name);
        // pi fork subagents (forked in-process, persisted to disk):
        // <parentDir>/forks/<date>_<id>.jsonl, one flat layer with names shaped
        // like top-level sessions (<date>_<uuid>.jsonl); the parent/child
        // relation is derived at parse time from header parentSession (the
        // parent session file path) — here we only scan the files into the list.
        // Orthogonal to the run-N artifact probe above (the forks dir only
        // exists under fork parent dirs).
        try {
          const forksDir = join(subDir, "forks");
          if (statSync(forksDir).isDirectory()) {
            for (const f of readdirSync(forksDir)) {
              if (f.endsWith(".jsonl")) files.push(join(forksDir, f));
            }
          }
        } catch {
          // no forks dir — skip
        }
        let runDirs: Dirent[];
        try {
          runDirs = readdirSync(subDir, { withFileTypes: true }).filter((e) => e.isDirectory());
        } catch {
          continue;
        }
        for (const run of runDirs) {
          const runDir = join(subDir, run.name);
          let ns: Dirent[];
          try {
            ns = readdirSync(runDir, { withFileTypes: true }).filter((e) => e.isDirectory() && /^run-\d+$/.test(e.name));
          } catch {
            continue;
          }
          for (const n of ns) {
            const f = join(runDir, n.name, "session.jsonl");
            try {
              if (statSync(f).isFile()) files.push(f);
            } catch {
              // no session.jsonl here — skip
            }
          }
        }
      }
    } catch {
      // dir unreadable — skip nested probe
    }
  }
  return files;
}

/**
 * Incremental scan: stat-compare against the disk cache, re-parse only changed
 * files, drop entries for deleted files, persist the cache when anything
 * changed. Sorted by modified desc (same as SessionManager.listAll).
 */
export async function scanSessionsFromRoot(root: string): Promise<SessionFileInfo[]> {
  const files = listSessionFiles(root);
  const cache = readListCache(root);
  const knownKeys = new Set<string>();
  const changed: Array<{ path: string; st: Stats; prev: ListCacheEntry | null }> = [];
  const merged: Array<{ info: SessionFileInfo; entry: { mtimeMs: number; size: number; offset?: number } }> = [];

  for (const f of files) {
    const key = sessionPathKey(f);
    knownKeys.add(key);
    let st;
    try {
      st = statSync(f);
    } catch {
      continue;
    }
    const hit = cache?.files[key];
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      merged.push({ info: hit.info, entry: hit });
    } else {
      changed.push({ path: f, st, prev: hit ?? null });
    }
  }

  const fresh = changed.length > 0 ? await parseChangedEntries(changed) : [];
  merged.push(...fresh.map((x) => ({ info: x.info, entry: x })));

  // Rebuild cache: reused entries + freshly parsed ones; drop deleted paths.
  // (Assembled directly from this round's stat/parse results; no second statSync across all files.)
  const stale = cache ? Object.keys(cache.files).filter((k) => !knownKeys.has(k)).length : 0;
  if (changed.length > 0 || stale > 0) {
    const files2: ListCacheFile = { version: LIST_CACHE_VERSION, updatedAt: new Date().toISOString(), files: {} };
    for (const m of merged) {
      files2.files[sessionPathKey(m.info.path)] = { mtimeMs: m.entry.mtimeMs, size: m.entry.size, offset: m.entry.offset, info: m.info };
    }
    writeListCache(root, files2);
  }

  return merged
    .map((m) => m.info)
    .sort((a, b) => b.modified.getTime() - a.modified.getTime()
      // 合并：modified 相同（同毫秒写入）时的 tie-break 与 scanner 一致——basename 反向。
      // 无此 tie-break 时顺序在缓存重建间漂移（list cache 的 Record 键序 ≠ 扫描序）。
      || basename(b.path).localeCompare(basename(a.path)));
}

/** Production entry: scan ~/.pi/agent/sessions incrementally. */
type SessionScanFn = () => Promise<SessionFileInfo[]>;
const productionSessionScan: SessionScanFn = () => scanSessionsFromRoot(join(getAgentDir(), "sessions"));
let activeSessionScan: SessionScanFn = productionSessionScan;

/** Test seam: replace the incremental disk scan; returns a restore function. */
export function __stubSessionScanForTests(stub: SessionScanFn | null): () => void {
  const previous = activeSessionScan;
  activeSessionScan = stub ?? productionSessionScan;
  return () => {
    activeSessionScan = previous;
  };
}

const SESSION_HEADER_MAX_BYTES = 64 * 1024;
const SESSION_RELATION_MAX_BYTES = 256 * 1024;
const SESSION_RELATION_MAX_LINES = 2;
const SESSION_RESULT_MAX_BYTES = 256 * 1024;
// Bounded probe for the newest entry id; never reads a whole session file.
const SESSION_TAIL_PROBE_MAX_BYTES = 64 * 1024;

function readBoundedLines(filePath: string, maxBytes: number, maxLines: number): string[] {
  const fd = openSync(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    let position = 0;
    let newlineCount = 0;
    let reachedEof = false;

    while (position < maxBytes && newlineCount < maxLines) {
      const buffer = Buffer.allocUnsafe(Math.min(4096, maxBytes - position));
      const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead === 0) {
        reachedEof = true;
        break;
      }
      position += bytesRead;
      const data = buffer.subarray(0, bytesRead);
      let end = data.length;
      for (let index = 0; index < data.length; index += 1) {
        if (data[index] !== 0x0a) continue;
        newlineCount += 1;
        if (newlineCount === maxLines) {
          end = index + 1;
          break;
        }
      }
      chunks.push(data.subarray(0, end));
    }

    const source = Buffer.concat(chunks).toString("utf8");
    const lines = source.split("\n");
    if (!reachedEof && !source.endsWith("\n")) lines.pop();
    if (lines.at(-1) === "") lines.pop();
    return lines.map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
  } finally {
    closeSync(fd);
  }
}

function readBoundedTailLines(filePath: string, maxBytes: number): string[] {
  const fd = openSync(filePath, "r");
  try {
    const fileSize = fstatSync(fd).size;
    const start = Math.max(0, fileSize - maxBytes);
    const buffer = Buffer.allocUnsafe(fileSize - start);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, start);
    if (bytesRead === 0) return [];

    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    if (start > 0) {
      const previousByte = Buffer.allocUnsafe(1);
      readSync(fd, previousByte, 0, 1, start - 1);
      if (previousByte[0] !== 0x0a) lines.shift();
    }
    if (lines.at(-1) === "") lines.pop();
    return lines.map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
  } finally {
    closeSync(fd);
  }
}

function parseSessionEntries(lines: readonly string[]): SessionEntry[] {
  return lines.flatMap((line) => {
    try {
      const entry = JSON.parse(line) as SessionEntry;
      return [entry];
    } catch {
      return [];
    }
  });
}

/**
 * Entry id carried by one serialized JSONL line, or undefined when the line is
 * the session header, malformed, or a torn trailing write mid-append.
 *
 * The header carries the session id rather than an entry id, and the SDK's entry
 * index excludes it — treating it as an entry would evict a fresh wrapper.
 */
function readEntryId(line: string): string | undefined {
  try {
    const entry = JSON.parse(line) as { type?: unknown; id?: unknown };
    if (entry.type === "session") return undefined;
    return typeof entry.id === "string" && entry.id ? entry.id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Newest entry id recorded on disk, read from a bounded tail so large sessions
 * stay cheap. Undefined when the file is absent (a wrapper that has not flushed
 * its first message yet) or unreadable.
 *
 * Used only on ?force=1 session reads (mount / page refresh). An id the
 * in-memory wrapper never saw means another pi process appended to the file.
 */
export function readLatestSessionEntryId(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  let lines: string[];
  try {
    lines = readBoundedTailLines(filePath, SESSION_TAIL_PROBE_MAX_BYTES);
  } catch {
    return undefined;
  }
  // Walk backwards so a torn trailing line falls back to the previous entry.
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const entryId = readEntryId(lines[index]);
    if (entryId) return entryId;
  }
  return undefined;
}

function readSessionRelationEntries(filePath: string): SessionEntry[] {
  const prefixEntries = parseSessionEntries(
    readBoundedLines(filePath, SESSION_RELATION_MAX_BYTES, SESSION_RELATION_MAX_LINES).slice(1),
  );
  const isSubagent = prefixEntries.some((entry) => (
    entry.type === "custom" && entry.customType === SUBAGENT_META_TYPE
  ));
  if (!isSubagent) return prefixEntries;

  return [
    ...prefixEntries,
    ...parseSessionEntries(readBoundedTailLines(filePath, SESSION_RESULT_MAX_BYTES)),
  ];
}
/** Single SessionInfo (used by the P0-A lightweight meta endpoint): goes
 *  through the same incremental scan cache (mtime/size — a cache hit costs zero
 *  disk IO), assembled from exactly the same source as the list (relation /
 *  project info / extension annotations are attached by the outer layer). */
export async function getSessionMeta(id: string): Promise<SessionInfo | null> {
  const scanned: SessionFileInfo[] = await activeSessionScan();
  const s = scanned.find((x) => x.id === id);
  if (!s) return null;
  const pathToId = new Map<string, string>();
  for (const x of scanned) pathToId.set(sessionPathKey(x.path), x.id);
  const [info] = await attachSessionProjectInfo([sessionInfoFromScan(s, pathToId)]);
  return info ?? null;
}

export async function attachSessionProjectInfo(sessions: SessionInfo[]): Promise<SessionInfo[]> {
  // Lazy import: keeps session-reader importable without the git/worktree
  // chain in node tests (same rationale as loadAllSessions above).
  const { resolveProject } = await import("./worktree.ts");
  const uniqueCwds = [...new Set(sessions.map((s) => s.cwd).filter(Boolean))];
  const projectByCwd = new Map<string, ProjectInfo>();
  // Batched concurrency: on a cold start a wave of dozens of git spawns would queue for seconds on a busy event loop; yield between batches.
  const RESOLVE_BATCH = 8;
  for (let i = 0; i < uniqueCwds.length; i += RESOLVE_BATCH) {
    const batch = uniqueCwds.slice(i, i + RESOLVE_BATCH);
    await Promise.all(batch.map(async (cwd) => {
      projectByCwd.set(cwd, await resolveProject(cwd));
    }));
    if (i + RESOLVE_BATCH < uniqueCwds.length) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  return sessions.map((session) => {
    const project = session.cwd ? projectByCwd.get(session.cwd) : undefined;
    const projectRoot = project?.projectRoot ?? session.cwd;
    return {
      ...session,
      projectRoot,
      projectKey: projectIdentityKey(projectRoot),
      ...(project?.branch ? { branch: project.branch } : {}),
      ...(project?.isWorktree ? { isWorktree: true } : {}),
    };
  });
}

export function mergeSessionLists(
  persistedSessions: SessionInfo[],
  supplementalSessions: SessionInfo[],
): SessionInfo[] {
  const byId = new Map(supplementalSessions.map((session) => [session.id, session]));
  // A disk scan is authoritative once the JSONL exists. In particular, this
  // replaces a transient registry snapshot without briefly rendering two rows.
  for (const session of persistedSessions) byId.set(session.id, session);
  return [...byId.values()].sort((a, b) => b.modified.localeCompare(a.modified));
}

async function loadAllSessions(): Promise<SessionInfo[]> {
  // Our incremental disk scan (mtime/size cache, only changed files re-parsed)
  // replaces SessionManager.listAll()'s full line-by-line re-parse; the
  // enrichment logic matches upstream.
  const scanned: SessionFileInfo[] = await activeSessionScan();
  const pathToId = new Map<string, string>();
  for (const s of scanned) pathToId.set(sessionPathKey(s.path), s.id);

  const sessions = scanned.map((s) => sessionInfoFromScan(s, pathToId));
  return attachSessionProjectInfo(sessions);
}

/** One scan record → SessionInfo (shared assembly for loadAllSessions / getSessionMeta). */
function sessionInfoFromScan(s: SessionFileInfo, pathToId: Map<string, string>) {
  {
    cacheSessionPath(s.id, s.path);
    const originSessionId = s.parentSessionPath ? pathToId.get(sessionPathKey(s.parentSessionPath)) : undefined;
    let subagent = null;
    if (s.parentSessionPath) {
      try {
        subagent = readSubagentRun(readSessionRelationEntries(s.path), s.id, s.path);
      } catch { /* malformed or concurrently removed session */ }
      // External subagent (pi-subagents ecosystem artifact): the header has no
      // parentSession and no SUBAGENT_META_TYPE entry; the parentSessionPath /
      // externalSubagent inferred from the on-disk path is the source of truth
      // for the parent/child relation. An equivalent subagent relation is
      // synthesized so the frontend badge / parent-child tree / Agents panel
      // treat it identically.
      if (!subagent && s.externalSubagent) {
        subagent = {
          sessionId: s.id,
          sessionPath: s.path,
          parentSessionId: originSessionId ?? s.externalSubagent.parentId,
          parentToolCallId: "",
          profile: s.externalSubagent.profile || "external",
          description: s.name || (s.firstMessage !== "(no messages)" ? s.firstMessage.slice(0, 80) : "external subagent"),
          task: "",
          runInBackground: true,
          // Spawn-mode subagents are frozen once on disk: with real conversation content treat as completed, otherwise interrupted
          status: s.messageCount > 1 ? "completed" as const : "interrupted" as const,
          createdAt: s.created instanceof Date ? s.created.toISOString() : String(s.created),
        };
      }
    }
    return {
      path: s.path,
      id: s.id,
      cwd: s.cwd,
      name: s.name,
      created: s.created.toISOString(),
      modified: s.modified.toISOString(),
      messageCount: s.messageCount,
      firstMessage: s.firstMessage || "(no messages)",
      parentSessionId: originSessionId,
      ...(s.lastRun ? { lastRun: s.lastRun } : {}),
      ...(subagent
        ? { relation: { kind: "subagent" as const, parentSessionId: subagent.parentSessionId, profile: subagent.profile, description: subagent.description, status: subagent.status } }
        : s.parentSessionPath
          ? { relation: { kind: "fork" as const, ...(originSessionId ? { originSessionId } : {}) } }
          : {}),
      transient: false,
    };
  }
}

type ScannedSubagent = NonNullable<ReturnType<typeof readSubagentRun>>;

/**
 * A fork's or subagent's run, read from its file, per scanned row. The scanner
 * hands back the same row object while the file's size and mtime stay the same
 * and a new one once they change, so the row is the cache key: every list
 * rebuild re-read ~140 subagent files synchronously (~36 ms of blocked event
 * loop) though only the session that just ran had changed.
 */
const scannedSubagentRuns = new WeakMap<ScannedSessionInfo, ScannedSubagent | null>();

function resolveScannedSessionRelation(
  scanned: ScannedSessionInfo,
  pathToId: Map<string, string>,
): { originSessionId?: string; subagent: ScannedSubagent | null } {
  const originSessionId = scanned.parentSessionPath
    ? pathToId.get(sessionPathKey(scanned.parentSessionPath))
    : undefined;
  if (!scanned.parentSessionPath) return { originSessionId, subagent: null };

  const cached = scannedSubagentRuns.get(scanned);
  if (cached !== undefined) return { originSessionId, subagent: cached };
  try {
    const subagent = readSubagentRun(readSessionRelationEntries(scanned.path), scanned.id, scanned.path);
    scannedSubagentRuns.set(scanned, subagent);
    return { originSessionId, subagent };
  } catch {
    // Malformed or concurrently removed session: read it again next time.
    return { originSessionId, subagent: null };
  }
}

/**
 * The list's first message is for the row title and the subagent filter, never
 * the whole prompt: a pasted document or an expanded skill made one row 300 KB
 * and the list several MB, fetched again by every open tab after each run. A
 * skill expansion goes as the /skill: command its row shows; any other text is
 * cut to CATALOG_FIRST_MESSAGE_MAX code units, never splitting a surrogate pair.
 */
const CATALOG_FIRST_MESSAGE_MAX = 500;

export function catalogFirstMessage(text: string): string {
  const display = skillExpansionToCommand(text) ?? text;
  if (display.length <= CATALOG_FIRST_MESSAGE_MAX) return display;
  const last = display.charCodeAt(CATALOG_FIRST_MESSAGE_MAX - 1);
  return display.slice(0, last >= 0xd800 && last <= 0xdbff ? CATALOG_FIRST_MESSAGE_MAX - 1 : CATALOG_FIRST_MESSAGE_MAX);
}

function mapScannedSession(
  scanned: ScannedSessionInfo,
  pathToId: Map<string, string>,
): SessionInfo {
  cacheSessionPath(scanned.id, scanned.path);
  const { originSessionId, subagent } = resolveScannedSessionRelation(scanned, pathToId);
  const detailsPending = scanned.detailsPending === true;
  return {
    path: scanned.path,
    id: scanned.id,
    cwd: scanned.cwd,
    name: scanned.name,
    created: scanned.created.toISOString(),
    modified: scanned.modified.toISOString(),
    messageCount: scanned.messageCount,
    // A pending row has no first message yet; the placeholder would read as a
    // real "(no messages)" session until the details arrive.
    firstMessage: detailsPending && !scanned.firstMessage
      ? ""
      : catalogFirstMessage(scanned.firstMessage || "(no messages)"),
    parentSessionId: originSessionId,
    ...(subagent
      ? { relation: { kind: "subagent" as const, parentSessionId: subagent.parentSessionId, profile: subagent.profile, description: subagent.description, status: subagent.status } }
      : scanned.parentSessionPath
        ? { relation: { kind: "fork" as const, ...(originSessionId ? { originSessionId } : {}) } }
        : {}),
    transient: false,
    ...(detailsPending ? { detailsPending: true } : {}),
  };
}

async function buildSessionList(scanned: ScannedSessionInfo[]): Promise<SessionInfo[]> {
  const pathToId = new Map<string, string>();
  for (const session of scanned) pathToId.set(sessionPathKey(session.path), session.id);
  return attachSessionProjectInfo(scanned.map((session) => mapScannedSession(session, pathToId)));
}

/**
 * One session's catalogue row, read the way listAllSessions() reads it
 * (project info, `modified` as the last message time), so the row a caller
 * shows at once is not moved by the next list refresh. Only the file itself
 * is scanned: a fork's `originSessionId` is the caller's to add.
 */
export async function readSessionInfo(filePath: string): Promise<SessionInfo | null> {
  const scanned = await scanSessionFileInfo(filePath);
  return scanned ? (await buildSessionList([scanned]))[0] ?? null : null;
}

/**
 * Return a cheap catalogue for the first paint. Changed files contribute only
 * header/stat metadata; a normal listAllSessions() call hydrates the exact
 * counts, names, and first messages afterwards.
 */
export async function listSessionSummaries(): Promise<SessionInfo[]> {
  return buildSessionList(await listSessionsIncremental({ deferDetails: true }));
}

export async function listAllSessions(options: { force?: boolean; allowStale?: boolean } = {}): Promise<SessionInfo[]> {
  if (options.force) invalidateSessionListCache();
  ensureSessionWatcher();
  const generation = globalThis.__piSessionListGeneration ?? 0;

  // Return cached result if still fresh (avoids re-scanning session files
  // and re-spawning git processes on every page load). The generation guard is
  // required because invalidateSessionListCache() keeps the previous scan
  // (upstream semantics) — a fresh-TTL hit from a bumped generation would
  // serve a catalogue that no longer contains just-created sessions.
  const cache = globalThis.__piSessionListCache;
  if (cache && cache.generation === generation && Date.now() - cache.ts < sessionListCacheTtlMs) {
    return cache.data;
  }

  // Callers that only need session metadata — mapping search hits onto sidebar
  // rows, for example — can take the previous scan and let the rebuild happen in
  // the background. A rebuild costs hundreds of milliseconds because it re-reads
  // every forked and subagent session, and it is triggered by ordinary agent
  // activity rather than by anything the caller did.
  if (options.allowStale && cache) {
    void listAllSessions().catch(() => undefined);
    return cache.data;
  }

  // Coalescing dedup: concurrent callers share the same in-flight promise
  // only while it belongs to the current cache generation.
  if (globalThis.__piSessionListPromise && globalThis.__piSessionListPromiseGeneration === generation) {
    return globalThis.__piSessionListPromise;
  }

  const loadPromise = loadAllSessions().then((data) => {
    // If a mutation invalidated this scan, make this caller join (or start) a
    // scan for the current generation. Returning the stale result here made a
    // refresh race indistinguishable from a successful refresh.
    if ((globalThis.__piSessionListGeneration ?? 0) !== generation) {
      return listAllSessions();
    }
    globalThis.__piSessionListCache = { data, ts: Date.now(), generation };
    return data;
  });
  const trackedPromise = loadPromise.finally(() => {
    if (globalThis.__piSessionListPromise === trackedPromise) {
      globalThis.__piSessionListPromise = undefined;
      globalThis.__piSessionListPromiseGeneration = undefined;
    }
  });

  globalThis.__piSessionListPromise = trackedPromise;
  globalThis.__piSessionListPromiseGeneration = generation;
  return trackedPromise;
}

// ============================================================================
// Session path caches, stored in globalThis for hot-reload safety.
// ============================================================================
declare global {
  var __piSessionPathCache: Map<string, string> | undefined;
  var __piPathToSessionIdCache: Map<string, string> | undefined;
  var __piSessionListPromise: Promise<SessionInfo[]> | undefined;
  var __piSessionListPromiseGeneration: number | undefined;
  var __piSessionListGeneration: number | undefined;
  var __piSessionListCache: { data: SessionInfo[]; ts: number; generation: number } | undefined;
  var __piSessionWatcher: { close(): void } | null | undefined;
  var __piSessionWatcherInit: boolean | undefined;
  var __piSessionWatchDebounce: ReturnType<typeof setTimeout> | undefined;
}

// P1 (session-list server triage/watch plan doc): cache invalidation switched
// to watch-event driven. The TTL is only a fallback — when no watch is
// established / the inotify queue overflows / FSEvents drops events, a forced
// rescan happens after at most 10min; if the watch cannot be established
// (unsupported platform / permissions), degrade to a 60s TTL.
const SESSION_LIST_CACHE_TTL_FALLBACK_MS = 10 * 60_000;
const SESSION_LIST_CACHE_TTL_DEGRADED_MS = 60_000;
let sessionListCacheTtlMs = SESSION_LIST_CACHE_TTL_DEGRADED_MS;

/**
 * Lazily starts the sessions-dir watcher (established on the first
 * listAllSessions, lives for the whole process). Event → 300ms debounce →
 * invalidateSessionListCache(). eventType is not distinguished: Linux
 * rename/change, Windows case-insensitivity, macOS FSEvents batch delays — all
 * treated as "possibly changed" and invalidated; the debounce absorbs the
 * event storms of active-session streaming appends and editor atomic writes
 * (temp file → rename). The watch is only an invalidation signal; rescans stay
 * incremental (mtime/size fingerprints).
 */
function ensureSessionWatcher(): void {
  if (globalThis.__piSessionWatcher) {
    // HMR module reload: the watcher survived in globalThis, so just reset the
    // TTL tier to the fallback tier (module-level let resets to the degraded
    // tier on reload; it must not stay at 60s).
    sessionListCacheTtlMs = SESSION_LIST_CACHE_TTL_FALLBACK_MS;
    return;
  }
  if (globalThis.__piSessionWatcherInit) return; // failed to establish once → TTL stays on the degraded tier permanently
  globalThis.__piSessionWatcherInit = true;
  try {
    const dir = defaultSessionsDir();
    const watcher = watch(dir, { recursive: true }, () => {
      if (globalThis.__piSessionWatchDebounce) clearTimeout(globalThis.__piSessionWatchDebounce);
      const t = setTimeout(() => {
        globalThis.__piSessionWatchDebounce = undefined;
        invalidateSessionListCache();
      }, 300);
      t.unref?.(); // keep the debounce from holding the process open (prod is kept alive by the HTTP server)
      globalThis.__piSessionWatchDebounce = t;
    });
    watcher.on("error", () => { /* watch dying just means falling back to the fallback TTL, not a crash */ });
    watcher.unref?.(); // keep the watcher from holding the process open (tests / one-off scripts); prod stays alive via the HTTP server handle
    globalThis.__piSessionWatcher = watcher;
    sessionListCacheTtlMs = SESSION_LIST_CACHE_TTL_FALLBACK_MS;
  } catch {
    // unsupported platform / insufficient permissions → stay on the degraded tier (60s), no watch
  }
}
const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function defaultSessionsDir(): string {
  return join(getAgentDir(), "sessions");
}

function resolvePathWithinDefaultSessions(
  filePath: string,
  sessionsDir = resolvePath(defaultSessionsDir()),
): string | null {
  const candidatePath = resolvePath(filePath);
  const relativePath = relative(sessionsDir, candidatePath);
  return relativePath !== ""
    && relativePath !== ".."
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath)
    ? candidatePath
    : null;
}

async function findSessionPathById(sessionId: string): Promise<string | null> {
  // The filename is only a candidate hint; the bounded header check remains
  // authoritative so future layouts and malformed files use the full fallback.
  if (!SESSION_ID_PATTERN.test(sessionId)) return null;

  let projectDirs: Dirent[];
  const sessionsDir = resolvePath(defaultSessionsDir());
  try {
    projectDirs = await readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const suffix = `_${sessionId}.jsonl`;
  let match: string | undefined;
  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory() && !projectDir.isSymbolicLink()) continue;
    const projectPath = resolvePathWithinDefaultSessions(
      join(sessionsDir, projectDir.name),
      sessionsDir,
    );
    if (!projectPath) continue;

    let files: string[];
    try {
      files = await readdir(projectPath);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(suffix)) continue;
      const candidate = resolvePathWithinDefaultSessions(
        join(projectPath, file),
        sessionsDir,
      );
      if (!candidate) continue;
      try {
        if (readSessionHeader(candidate)?.id !== sessionId) continue;
      } catch {
        continue;
      }
      // Do not choose between duplicate candidates; retain the existing
      // catalogue fallback for its current resolution semantics.
      if (match && match !== candidate) return null;
      match = candidate;
    }
  }

  return match ?? null;
}

function findSessionIdByPath(filePath: string): string | undefined {
  if (!filePath.endsWith(".jsonl")) return undefined;
  const candidate = resolvePathWithinDefaultSessions(filePath);
  if (!candidate) return undefined;
  try {
    const sessionId = readSessionHeader(candidate)?.id;
    if (!sessionId) return undefined;
    cacheSessionPath(sessionId, candidate);
    return sessionId;
  } catch {
    return undefined;
  }
}

export function invalidateSessionListCache(): void {
  globalThis.__piSessionListGeneration = (globalThis.__piSessionListGeneration ?? 0) + 1;
  // The previous scan is kept, not discarded: it is no longer fresh, but it is
  // still a complete catalogue apart from sessions created moments ago. Callers
  // that pass `allowStale` read it instead of paying for a rebuild.
}

export function getSessionListVersion(): number {
  // Session files another process (the pi CLI) creates or deletes bump no
  // version. Every poll of the version may start a filename check instead.
  void checkSessionMembership(defaultSessionsDir(), invalidateSessionListCache);
  return globalThis.__piSessionListGeneration ?? 0;
}

function getPathCache(): Map<string, string> {
  if (!globalThis.__piSessionPathCache) globalThis.__piSessionPathCache = new Map();
  return globalThis.__piSessionPathCache;
}

function getPathToIdCache(): Map<string, string> {
  if (!globalThis.__piPathToSessionIdCache) globalThis.__piPathToSessionIdCache = new Map();
  return globalThis.__piPathToSessionIdCache;
}

// ---------------------------------------------------------------------------
// Read-only SessionManager cache.
//
// Opening a large session (SessionManager.open -> full JSONL parse + index
// build) costs 150ms for a small session and ~1.1s for an 82MB one. Detail/
// context/pagination routes re-open the same file on every request whenever no
// live runtime wrapper exists, so a fingerprint-validated cache turns repeat
// opens into ~1ms map hits.
//
// Budget: a count cap alone is not enough. Parsed entries retain roughly the
// file's own size in heap (measured: an 82MB session holds ~94MB), so twelve
// large sessions would pin ~1.1GB. Entries are therefore also capped by the
// summed on-disk size of the cached files, and a single session larger than
// SM_CACHE_LIMITS.maxFileBytes is served fresh instead of being cached — one
// oversize session must not evict every useful entry.
//
// Safety: cached managers are READ-ONLY views. Any write path must go through
// a live wrapper or SessionManager.open directly — call openSessionManager
// with { mutable: true } (bypasses the cache) for those. The fingerprint
// (size + mtimeMs) invalidates on external appends (TUI writes), and
// invalidateSessionManagerCache(filePath) is called on delete/rename.
// ---------------------------------------------------------------------------

interface SmCacheEntry {
  sm: unknown;
  fingerprint: string;
  /** On-disk size, the proxy for this entry's retained heap. */
  bytes: number;
}

declare global {
  var __piSmCache: Map<string, SmCacheEntry> | undefined;
}

/**
 * Cache budget. Exported so tests can shrink it to values they can actually
 * produce on disk; production never reassigns these.
 */
export const SM_CACHE_LIMITS = {
  /** Most sessions held at once. */
  maxEntries: 12,
  /** Summed on-disk size of cached sessions. */
  maxTotalBytes: 256 * 1024 * 1024,
  /** A session larger than this is never cached — it would evict everything else. */
  maxFileBytes: 64 * 1024 * 1024,
};

function getSmCache(): Map<string, SmCacheEntry> {
  if (!globalThis.__piSmCache) globalThis.__piSmCache = new Map();
  return globalThis.__piSmCache;
}

function sessionFileStats(filePath: string): { fingerprint: string; bytes: number } | null {
  try {
    const stats = statSync(filePath);
    return { fingerprint: `${stats.size}:${stats.mtimeMs}`, bytes: stats.size };
  } catch {
    return null;
  }
}

/** Evict least-recently-used entries until both the count and byte caps hold. */
function evictSmCache(cache: Map<string, SmCacheEntry>): void {
  let total = 0;
  for (const entry of cache.values()) total += entry.bytes;
  while (cache.size > SM_CACHE_LIMITS.maxEntries || total > SM_CACHE_LIMITS.maxTotalBytes) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    total -= cache.get(oldestKey)?.bytes ?? 0;
    cache.delete(oldestKey);
  }
}

export function invalidateSessionManagerCache(filePath?: string): void {
  const cache = getSmCache();
  if (filePath === undefined) {
    cache.clear();
    return;
  }
  cache.delete(sessionPathKey(filePath));
}

/**
 * Open a session file, reusing a cached read-only SessionManager when the
 * on-disk fingerprint is unchanged. Pass { mutable: true } when the caller
 * intends to append/branch/rewrite — that path always opens fresh.
 */
export function openSessionManager(
  filePath: string,
  options: { mutable?: boolean } = {},
): SessionManager {
  if (options.mutable) return SessionManager.open(filePath, undefined);

  const cache = getSmCache();
  const pathKey = sessionPathKey(filePath);
  const stats = sessionFileStats(filePath);
  if (stats === null) {
    cache.delete(pathKey);
    return SessionManager.open(filePath, undefined);
  }

  const cached = cache.get(pathKey);
  if (cached && cached.fingerprint === stats.fingerprint) {
    // LRU touch.
    cache.delete(pathKey);
    cache.set(pathKey, cached);
    return cached.sm as SessionManager;
  }

  const sm = SessionManager.open(filePath, undefined);
  if (stats.bytes > SM_CACHE_LIMITS.maxFileBytes) {
    // Too large to hold: drop any stale entry for this path and serve fresh.
    cache.delete(pathKey);
    return sm;
  }
  cache.set(pathKey, { sm, fingerprint: stats.fingerprint, bytes: stats.bytes });
  evictSmCache(cache);
  return sm;
}

export async function resolveSessionPath(sessionId: string): Promise<string | null> {
  const cached = getPathCache().get(sessionId);
  if (cached) return cached;

  const targetedPath = await findSessionPathById(sessionId);
  if (targetedPath) {
    cacheSessionPath(sessionId, targetedPath);
    return getPathCache().get(sessionId) ?? null;
  }

  // Unknown layouts, malformed candidates, and duplicate IDs retain the
  // existing authoritative catalogue scan instead of negative-caching a miss.
  await listAllSessions();
  return getPathCache().get(sessionId) ?? null;
}

/**
 * For empty sessions (file lazily not yet written), look up the TUI bridge
 * registry by id and return the registry key (= sessionFile path). Attach
 * detection prioritizes the socket (bridge-registry.json); the file is only
 * for history replay. A live bridge is enough to attach — no need to wait for
 * the file to appear on disk.
 */
export async function findBridgeSessionFileById(sessionId: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/.test(sessionId)) return null;
  const registryPath =
    process.env.PI_BRIDGE_REGISTRY
    ?? join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "bridge-registry.json");
  try {
    const raw = readFileSync(registryPath, "utf8");
    const reg = JSON.parse(raw) as Record<string, unknown>;
    const suffix = `_${sessionId}.jsonl`;
    for (const key of Object.keys(reg)) {
      if (key.endsWith(suffix)) return key;
    }
  } catch {
    // no registry / parse failure → no bridge
  }
  return null;
}

export async function resolveSessionIdByPath(filePath: string): Promise<string | undefined> {
  const pathKey = sessionPathKey(filePath);
  const cached = getPathToIdCache().get(pathKey);
  if (cached) return cached;

  const targetedId = findSessionIdByPath(filePath);
  if (targetedId) return targetedId;

  await listAllSessions();
  return getPathToIdCache().get(pathKey);
}

export function cacheSessionPath(sessionId: string, filePath: string): void {
  const normalizedPath = normalizePath(filePath);
  const pathKey = sessionPathKey(normalizedPath);
  const pathCache = getPathCache();
  const reverseCache = getPathToIdCache();
  const previousPath = pathCache.get(sessionId);
  const previousPathKey = previousPath ? sessionPathKey(previousPath) : undefined;
  const previousSessionId = reverseCache.get(pathKey);
  const previousOwnerPath = previousSessionId ? pathCache.get(previousSessionId) : undefined;
  if (previousPathKey && previousPathKey !== pathKey && reverseCache.get(previousPathKey) === sessionId) {
    reverseCache.delete(previousPathKey);
  }
  if (
    previousSessionId &&
    previousSessionId !== sessionId &&
    previousOwnerPath &&
    sessionPathKey(previousOwnerPath) === pathKey
  ) {
    pathCache.delete(previousSessionId);
  }
  pathCache.set(sessionId, normalizedPath);
  reverseCache.set(pathKey, sessionId);
}

export function invalidateSessionPathCache(sessionId: string): void {
  const pathCache = getPathCache();
  const reverseCache = getPathToIdCache();
  const filePath = pathCache.get(sessionId);
  pathCache.delete(sessionId);
  const pathKey = filePath ? sessionPathKey(filePath) : undefined;
  if (pathKey && reverseCache.get(pathKey) === sessionId) {
    reverseCache.delete(pathKey);
  }
}

export function readSessionHeader(filePath: string): SessionHeader | null {
  const firstLine = readBoundedLines(filePath, SESSION_HEADER_MAX_BYTES, 1)[0]?.trimEnd();
  if (!firstLine) return null;
  try {
    const header = JSON.parse(firstLine) as SessionHeader;
    return header.type === "session" ? header : null;
  } catch {
    return null;
  }
}

export function getSessionEntries(filePath: string): SessionEntry[] {
  const entries = openSessionManager(filePath).getEntries();
  return entries as unknown as SessionEntry[];
}

export function getLatestModelChange(entries: SessionEntry[]): SessionContext["model"] {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "model_change") {
      return { provider: entry.provider, modelId: entry.modelId };
    }
  }
  return null;
}

function getSessionSettings(entries: SessionEntry[], leafId?: string | null): Pick<SessionContext, "thinkingLevel" | "model"> {
  if (leafId === null) return { thinkingLevel: "off", model: null };
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  let current = leafId ? byId.get(leafId) : undefined;
  current ??= entries[entries.length - 1];
  let thinkingLevel: string | undefined;
  // Our semantics: model_change wins first (a stale model stamp that abort
  // persisted after a runtime set_model can sit closer to the leaf than
  // model_change, and a pure "closest wins" rule would roll back to the old
  // model), but with a branch correction: after "edit from here" / branch
  // navigation returns to an earlier node, the new chain's ancestors carry no
  // model_change (it stayed on the old branch), while the new chain's assistant
  // message stamp reflects the model the engine actually ran (the engine's
  // in-memory branch state is not reset). The two shapes differ: an abort
  // residual stamp immediately follows model_change (no user message in
  // between); a new-branch stamp is necessarily separated from the old
  // model_change by a newly sent user message → only when "stamp closer +
  // user in between + different model" does the stamp win; otherwise
  // model_change stays first.
  let model: SessionContext["model"] | undefined;
  let sawModelChange = false;
  let assistantStamp: SessionContext["model"] | undefined;
  // assistant stamp encountered before model_change (= stamp closer to the leaf), with a user message in between
  let stampOnNewBranch = false;

  while (current && (thinkingLevel === undefined || !(sawModelChange && assistantStamp !== undefined))) {
    if (thinkingLevel === undefined && current.type === "thinking_level_change") {
      thinkingLevel = current.thinkingLevel;
    }
    if (!sawModelChange && current.type === "model_change") {
      model = { provider: current.provider, modelId: current.modelId };
      sawModelChange = true;
    } else if (assistantStamp === undefined && current.type === "message" && current.message.role === "assistant") {
      const message = current.message as { provider?: unknown; model?: unknown };
      if (typeof message.provider === "string" && typeof message.model === "string") {
        assistantStamp = { provider: message.provider, modelId: message.model };
        stampOnNewBranch = false;
      }
    } else if (assistantStamp !== undefined && !sawModelChange && current.type === "message" && current.message.role === "user") {
      stampOnNewBranch = true;
    }
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  // Branch correction (see above): stamp closer + user in between + different
  // model → the model actually run on the new branch is the stamped one.
  // With the same model both choices agree, so model_change stands; without a
  // stamp / when the stamp lacks provider, keep the status quo.
  if (model && assistantStamp && stampOnNewBranch &&
      (assistantStamp.provider !== model.provider || assistantStamp.modelId !== model.modelId)) {
    return { thinkingLevel: thinkingLevel ?? "off", model: assistantStamp };
  }
  return { thinkingLevel: thinkingLevel ?? "off", model: model ?? assistantStamp ?? null };
}

export interface BuildSessionContextOptions {
  deferThinking?: boolean;
  deferToolResultImages?: boolean;
  tail?: number;
  excludeLeaf?: boolean;
  /** Session id used to build lazy URLs for historical tool-result images. */
  sessionId?: string;
}

export function buildSessionContext(
  entries: SessionEntry[],
  leafId?: string | null,
  options: BuildSessionContextOptions = {},
): SessionContext {
  const { tail, excludeLeaf } = options;
  // History pages retain the original branch order, including compacted messages.
  // SDK context filtering can drop a page's messages when firstKeptEntryId is outside it.
  const sliced = leafId === null ? [] : sliceActiveBranch(
    entries, leafId ?? null, tail && tail > 0 ? tail : entries.length, excludeLeaf,
  );
  const hasMore = Boolean(tail && tail > 0 && sliced[0]?.parentId);
  const turnsBefore = hasMore ? countTurnsBefore(entries, sliced[0]) : 0;

  // Convert messages and their IDs together to keep fork/navigation targets aligned.
  const messages: AgentMessage[] = [];
  const entryIds: string[] = [];
  for (const entry of sliced) {
    const m = entryToUiMessage(entry, options);
    if (m) {
      messages.push(m);
      entryIds.push(entry.id);
    }
  }

  return {
    messages,
    entryIds,
    oldestEntryId: sliced[0]?.id ?? null,
    hasMore,
    turnsBefore,
    ...getSessionSettings(entries, leafId),
  };
}

/**
 * The fields of entryToUiMessage()'s result that isMessageGroupAnchor() reads,
 * without converting the entry's body.
 */
function turnAnchorShape(entry: SessionEntry): Parameters<typeof isMessageGroupAnchor>[0] | null {
  switch (entry.type) {
    case "message":
      return entry.message.role === "system" ? null : entry.message as AgentMessage;
    case "compaction":
      return { role: "custom", customType: "compaction", display: true };
    case "branch_summary":
      return entry.summary ? { role: "user" } : null;
    case "custom_message":
      return { role: "custom", customType: entry.customType, display: entry.display };
    default:
      return null;
  }
}

/**
 * Turns on the branch above `oldest`, the first entry of a page: the anchors
 * the chat would group by (#791). The minimap numbers loaded turns from it, so
 * a turn keeps its number as older pages load.
 */
function countTurnsBefore(entries: SessionEntry[], oldest: SessionEntry): number {
  const byId = new Map<string, SessionEntry>();
  for (const e of entries) byId.set(e.id, e);
  let turns = 0;
  let current = oldest.parentId ? byId.get(oldest.parentId) : undefined;
  while (current) {
    const shape = turnAnchorShape(current);
    if (shape && isMessageGroupAnchor(shape)) turns++;
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return turns;
}

/**
 * Entry that renders as a standalone visible message in the chat window:
 * user / assistant messages plus the compaction divider. toolResult entries,
 * hidden custom messages and session meta render as attachments or nothing,
 * so they must not consume the `tail` budget — counting raw entries starves
 * user messages out of the window in agent-heavy sessions (a 50-entry window
 * over a tool-heavy session can hold a single user message).
 */
function countsTowardTail(entry: SessionEntry): boolean {
  if (entry.type === "compaction") return true;
  if (entry.type !== "message") return false;
  const role = (entry as { message?: { role?: string } }).message?.role;
  return role === "user" || role === "assistant";
}

/**
 * Raw-entry ceiling for one page, so a span of tool traffic with few visible
 * anchors cannot balloon the payload. Scaled with `tail`; older history still
 * pages in via `before`.
 */
const MIN_RAW_WINDOW_ENTRIES = 200;
const rawWindowCap = (tail: number) => Math.max(MIN_RAW_WINDOW_ENTRIES, tail * 6);

/**
 * Extract the ancestor chain from `leafId` back toward the root, capped at
 * `tail` visible entries (most-recent first after the final reverse).
 * Iterative: a linear session's chain length equals its entry count, so a
 * recursive walk would overflow the stack. The result is still a valid prefix
 * of the active branch — older history is loaded on demand via pagination.
 */
export function sliceActiveBranch(
  entries: SessionEntry[],
  leafId: string | null,
  tail: number,
  excludeLeaf = false,
): SessionEntry[] {
  if (tail <= 0) return entries;
  const byId = new Map<string, SessionEntry>();
  for (const e of entries) byId.set(e.id, e);

  let leaf = leafId ? byId.get(leafId) : entries[entries.length - 1];
  // Pagination: `before` is the oldest entry already loaded, so the next page
  // must start at its parent to avoid duplicating `before` when prepended.
  if (excludeLeaf) leaf = leaf?.parentId ? byId.get(leaf.parentId) : undefined;
  if (!leaf) return [];
  const chain: SessionEntry[] = [];
  let current: SessionEntry | undefined = leaf;
  let visible = 0;
  const rawCap = rawWindowCap(tail);
  while (current) {
    chain.push(current);
    if (countsTowardTail(current)) visible++;
    if (visible >= tail || chain.length >= rawCap) break;
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  chain.reverse();
  return chain;
}
function parseEntryTimestamp(timestamp: string): number | undefined {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64ImageInfo(block: unknown): { bytes: number; mime?: string } | null {
  if (!isRecord(block) || block.type !== "image") return null;

  let data: string | undefined;
  let mime: string | undefined;
  if (typeof block.data === "string") {
    data = block.data;
    mime = typeof block.mimeType === "string" ? block.mimeType : undefined;
  } else if (isRecord(block.source) && block.source.type === "base64" && typeof block.source.data === "string") {
    data = block.source.data;
    mime = typeof block.source.media_type === "string" ? block.source.media_type : undefined;
  }
  if (!data) return null;

  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return { bytes: Math.max(0, Math.floor(data.length * 3 / 4) - padding), mime };
}

function deferToolResultBase64Images(
  message: AgentMessage,
  sessionId: string | undefined,
  entryId: string,
): AgentMessage {
  if (message.role !== "toolResult") return message;

  let omitted = 0;
  let bytes = 0;
  const mimes = new Set<string>();
  const content = message.content.flatMap((block, blockIndex) => {
    const image = base64ImageInfo(block);
    if (!image) return [block];

    // Keep the initial history response small, but preserve an image block that
    // the browser can load only when its collapsed tool result is expanded.
    if (
      sessionId &&
      image.mime &&
      TOOL_RESULT_IMAGE_MIMES.has(image.mime) &&
      image.bytes > 0 &&
      image.bytes <= MAX_TOOL_RESULT_IMAGE_BYTES
    ) {
      const source: ImageContent["source"] = {
        type: "url",
        media_type: image.mime,
        url: `/api/sessions/${encodeURIComponent(sessionId)}/entries/${encodeURIComponent(entryId)}/tool-result-image?blockIndex=${blockIndex}`,
      };
      return [{ type: "image", source } satisfies ImageContent];
    }

    // Retain the old bounded fallback for callers that do not have a session id.
    omitted += 1;
    bytes += image.bytes;
    if (image.mime) mimes.add(image.mime);
    return [];
  });
  if (omitted === 0) return { ...message, content };

  const mimeText = mimes.size > 0 ? `: ${[...mimes].join(", ")}` : "";
  content.push({
    type: "text",
    text: `[${omitted} tool result image${omitted === 1 ? "" : "s"} omitted from initial history payload${mimeText}, ~${bytes} bytes]`,
  });
  return { ...message, content };
}

/**
 * Convert a session entry on the active branch into a UI message.
 * Returns null for entries that do not map to chat history (metadata, non-message types).
 *
 * Exported for reuse by the handle channel (lib/session/handle-adapter.ts):
 * provider backends' getMessages (pi get_entries / omp wrapper) return entries
 * of the same shape and must go through the same unwrapping, otherwise the
 * frontend gets no top-level role and the message area renders empty.
 */
export function entryToUiMessage(
  entry: SessionEntry,
  options: BuildSessionContextOptions,
): AgentMessage | null {
  // Supported message roles: user, assistant, toolResult, bashExecution.
  // bashExecution messages enter the case "message" branch (entry.type === "message").
  // The early return at line below ("!options.deferThinking || message.role !== "assistant"")
  // passes non-assistant messages — including bashExecution — through unchanged.
  // normalizeToolCalls is a secondary guard (returns non-assistant messages as-is).
  switch (entry.type) {
    case "message": {
      // Transcript system messages carry the prompt and tool loadout (Pi >= 0.86).
      // They are provider input, not conversation, so they never render.
      if (entry.message.role === "system") return null;
      // Session files are parsed without validation; old versions, forks, or
      // hand-edited files can contain messages with null/missing content.
      // Mirror the SDK's sessionEntryToContextMessages guard so the
      // deferThinking content.map() below cannot throw on null.
      const displayMessage = withoutMessageSignatures(entry.message);
      const safe = (displayMessage as { content?: unknown }).content == null
        ? { ...displayMessage, content: [] }
        : displayMessage;
      let message = options.deferToolResultImages
        ? deferToolResultBase64Images(normalizeToolCalls(safe), options.sessionId, entry.id)
        : normalizeToolCalls(safe);
      const legacyContent = message.role === "assistant" ? (message as { content: unknown }).content : undefined;
      if (typeof legacyContent === "string") {
        message = { ...message, content: [{ type: "text", text: legacyContent }] } as AgentMessage;
      }
      if (!options.deferThinking || message.role !== "assistant") return message;
      const content = message.content;
      return {
        ...message,
        content: content.map((block) => (
          block.type === "thinking" && block.thinking.trim() !== ""
            ? { ...block, thinking: getThinkingPreview(block.thinking), deferred: true }
            : block
        )),
      };
    }
    case "compaction":
      return {
        role: "custom",
        customType: "compaction",
        content: entry.summary,
        display: true,
        details: {
          tokensBefore: entry.tokensBefore,
          firstKeptEntryId: entry.firstKeptEntryId,
        },
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    case "branch_summary":
      if (!entry.summary) return null;
      return {
        role: "user",
        content: `*The conversation briefly explored another branch and returned with this summary:*\n\n${entry.summary}`,
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    case "custom_message":
      return {
        role: "custom",
        customType: entry.customType,
        content: entry.content ?? [],
        display: entry.display,
        details: entry.details,
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    default:
      return null;
  }
}
