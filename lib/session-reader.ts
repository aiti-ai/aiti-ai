import {
  SessionManager,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync, statSync, closeSync, openSync, readSync } from "fs";
import { join, normalize as normalizePath } from "path";
import { writePrivateFileAtomicSync } from "./atomic-file.ts";
import type { AgentMessage, SessionEntry, SessionHeader, SessionInfo, SessionContext } from "./types.ts";
import { normalizeToolCalls } from "./normalize.ts";
import { projectIdentityKey } from "./project-identity.ts";
import { sessionPathKey } from "./session-path.ts";
import type { ProjectInfo } from "./worktree.ts";

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
}

interface ListCacheEntry {
  mtimeMs: number;
  size: number;
  info: SessionFileInfo;
}

interface ListCacheFile {
  version: number;
  updatedAt: string;
  files: Record<string, ListCacheEntry>;
}

const LIST_CACHE_VERSION = 1;
const LIST_CACHE_FILENAME = "session_list_cache.json";
const MAX_CONCURRENT_PARSE = 10;

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
  const header = readSessionHeader(filePath);
  if (!header) return null;
  let name: string | undefined;
  let messageCount = 0;
  let firstMessage = "";
  let lastActivity: number | undefined;
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
  return {
    path: filePath,
    id: header.id,
    cwd: header.cwd ?? "",
    name,
    created: new Date(header.timestamp),
    modified,
    messageCount,
    firstMessage: firstMessage || "(no messages)",
    parentSessionPath: header.parentSession,
  };
}

function readListCache(root: string): ListCacheFile | null {
  const p = join(root, LIST_CACHE_FILENAME);
  try {
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, "utf8")) as ListCacheFile;
    if (raw?.version !== LIST_CACHE_VERSION) return null;
    // JSON round-trip turns Dates into strings — restore them.
    for (const entry of Object.values(raw.files)) {
      entry.info.created = new Date(entry.info.created);
      entry.info.modified = new Date(entry.info.modified);
    }
    return raw;
  } catch {
    return null;
  }
}

function writeListCache(root: string, cache: ListCacheFile): void {
  try {
    writePrivateFileAtomicSync(join(root, LIST_CACHE_FILENAME), JSON.stringify(cache));
  } catch {
    // Non-fatal: the in-memory result is still correct; next scan rebuilds.
  }
}

async function parseChangedFiles(files: string[]): Promise<SessionFileInfo[]> {
  const out = new Array<SessionFileInfo | null>(files.length).fill(null);
  let next = 0;
  const workerCount = Math.min(MAX_CONCURRENT_PARSE, files.length) || 1;
  await Promise.all(Array.from({ length: workerCount }, async () => {
    for (;;) {
      const i = next++;
      if (i >= files.length) return;
      out[i] = deriveSessionFileInfo(files[i]);
    }
  }));
  return out.filter((x): x is SessionFileInfo => x !== null);
}

/**
 * List session files under a sessions root (same layout the SDK scans:
 * <root>/<encoded-cwd>/*.jsonl).
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
  const changed: string[] = [];
  const merged: SessionFileInfo[] = [];

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
      merged.push(hit.info);
    } else {
      changed.push(f);
    }
  }

  const fresh = changed.length > 0 ? await parseChangedFiles(changed) : [];
  merged.push(...fresh);

  // Rebuild cache: reused entries + freshly parsed ones; drop deleted paths.
  const stale = cache ? Object.keys(cache.files).filter((k) => !knownKeys.has(k)).length : 0;
  if (changed.length > 0 || stale > 0) {
    const files2: ListCacheFile = { version: LIST_CACHE_VERSION, updatedAt: new Date().toISOString(), files: {} };
    for (const info of merged) {
      try {
        const st = statSync(info.path);
        files2.files[sessionPathKey(info.path)] = { mtimeMs: st.mtimeMs, size: st.size, info };
      } catch {
        // file vanished mid-scan — omit
      }
    }
    writeListCache(root, files2);
  }

  return merged.sort((a, b) => b.modified.getTime() - a.modified.getTime());
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

async function loadAllSessions(): Promise<SessionInfo[]> {
  const piSessions: SessionFileInfo[] = await activeSessionScan();
  const pathToId = new Map<string, string>();
  for (const s of piSessions) pathToId.set(sessionPathKey(s.path), s.id);

  // Resolve each unique cwd to its project root (main repo shared by all
  // worktrees). resolveProject caches per-cwd, so this is cheap after warmup.
  // Lazy import: keeps session-reader importable without the git/worktree
  // chain in node tests — resolveProject only runs for the full list build.
  const { resolveProject } = await import("./worktree.ts");
  const uniqueCwds = [...new Set(piSessions.map((s) => s.cwd).filter(Boolean))];
  const projectByCwd = new Map<string, ProjectInfo>();
  await Promise.all(uniqueCwds.map(async (cwd) => {
    projectByCwd.set(cwd, await resolveProject(cwd));
  }));

  return piSessions.map((s) => {
    cacheSessionPath(s.id, s.path);
    const project = s.cwd ? projectByCwd.get(s.cwd) : undefined;
    return {
      path: s.path,
      id: s.id,
      cwd: s.cwd,
      name: s.name,
      created: s.created instanceof Date ? s.created.toISOString() : String(s.created),
      modified: s.modified instanceof Date ? s.modified.toISOString() : String(s.modified),
      messageCount: s.messageCount,
      firstMessage: s.firstMessage || "(no messages)",
      parentSessionId: s.parentSessionPath ? pathToId.get(sessionPathKey(s.parentSessionPath)) : undefined,
      projectRoot: project?.projectRoot ?? s.cwd,
      ...(project?.isWorktree && project.branch ? { worktreeBranch: project.branch } : {}),
    };
  });
}

export async function attachSessionProjectInfo(sessions: SessionInfo[]): Promise<SessionInfo[]> {
  // Lazy import: keeps session-reader importable without the git/worktree
  // chain in node tests (same rationale as loadAllSessions above).
  const { resolveProject } = await import("./worktree.ts");
  const uniqueCwds = [...new Set(sessions.map((s) => s.cwd).filter(Boolean))];
  const projectByCwd = new Map<string, ProjectInfo>();
  await Promise.all(uniqueCwds.map(async (cwd) => {
    projectByCwd.set(cwd, await resolveProject(cwd));
  }));

  return sessions.map((session) => {
    const project = session.cwd ? projectByCwd.get(session.cwd) : undefined;
    const projectRoot = project?.projectRoot ?? session.cwd;
    return {
      ...session,
      projectRoot,
      projectKey: projectIdentityKey(projectRoot),
      ...(project?.isWorktree && project.branch ? { worktreeBranch: project.branch } : {}),
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

export async function listAllSessions(options: { force?: boolean } = {}): Promise<SessionInfo[]> {
  if (options.force) invalidateSessionListCache();
  const generation = globalThis.__piSessionListGeneration ?? 0;

  // Return cached result if still fresh (avoids re-scanning session files
  // and re-spawning git processes on every page load).
  if (globalThis.__piSessionListCache && Date.now() - globalThis.__piSessionListCache.ts < SESSION_LIST_CACHE_TTL_MS) {
    return globalThis.__piSessionListCache.data;
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
    globalThis.__piSessionListCache = { data, ts: Date.now() };
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
  var __piSessionListCache: { data: SessionInfo[]; ts: number } | undefined;
}

const SESSION_LIST_CACHE_TTL_MS = 5_000;

export function invalidateSessionListCache(): void {
  globalThis.__piSessionListGeneration = (globalThis.__piSessionListGeneration ?? 0) + 1;
  globalThis.__piSessionListCache = undefined;
}

function getPathCache(): Map<string, string> {
  if (!globalThis.__piSessionPathCache) globalThis.__piSessionPathCache = new Map();
  return globalThis.__piSessionPathCache;
}

function getPathToIdCache(): Map<string, string> {
  if (!globalThis.__piPathToSessionIdCache) globalThis.__piPathToSessionIdCache = new Map();
  return globalThis.__piPathToSessionIdCache;
}

export async function resolveSessionPath(sessionId: string): Promise<string | null> {
  const cached = getPathCache().get(sessionId);
  if (cached) return cached;

  // Cache miss: scan all sessions to populate cache, then retry
  await listAllSessions();
  return getPathCache().get(sessionId) ?? null;
}

export async function resolveSessionIdByPath(filePath: string): Promise<string | undefined> {
  const pathKey = sessionPathKey(filePath);
  const cached = getPathToIdCache().get(pathKey);
  if (cached) return cached;

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
  const fd = openSync(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    const maxHeaderBytes = 64 * 1024;
    let position = 0;
    let foundNewline = false;

    while (position < maxHeaderBytes && !foundNewline) {
      const buffer = Buffer.allocUnsafe(Math.min(4096, maxHeaderBytes - position));
      const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const data = buffer.subarray(0, bytesRead);
      const newlineIndex = data.indexOf(0x0a);
      chunks.push(newlineIndex === -1 ? data : data.subarray(0, newlineIndex));
      position += bytesRead;
      foundNewline = newlineIndex !== -1;
    }

    if (!foundNewline && position >= maxHeaderBytes) return null;
    const firstLine = Buffer.concat(chunks).toString("utf8").trimEnd();
    if (!firstLine) return null;
    try {
      const header = JSON.parse(firstLine) as SessionHeader;
      return header.type === "session" ? header : null;
    } catch {
      return null;
    }
  } finally {
    closeSync(fd);
  }
}

export function getSessionEntries(filePath: string): SessionEntry[] {
  const entries = SessionManager.open(filePath).getEntries();
  return entries as unknown as SessionEntry[];
}

export function buildSessionContext(
  entries: SessionEntry[],
  leafId?: string | null,
  options: { deferThinking?: boolean; deferToolResultImages?: boolean } = {},
): SessionContext {
  const byId = new Map<string, SessionEntry>();
  for (const e of entries) byId.set(e.id, e);

  // 不走 SDK 的 buildContextEntries（会过滤掉压缩前的原始消息）
  // 改为走全父链，所有消息原样返回，保留压缩前的内容
  const pathEntries = buildFullPath(entries, leafId, byId);
  const { thinkingLevel, model } = getSessionContextSettings(pathEntries);

  const messages: AgentMessage[] = [];
  const entryIds: string[] = [];
  for (const entry of pathEntries) {
    const m = entryToUiMessage(entry, options);
    if (m) {
      messages.push(m);
      entryIds.push(entry.id);
    }
  }

  return {
    messages,
    entryIds,
    thinkingLevel,
    model,
  };
}

/** 从 leaf 到 root 走全父链（不丢弃压缩前的消息）。
 *  leafId === null 时返回空，与 SDK buildSessionPath 语义一致（null = 明确无 leaf）。 */
function buildFullPath(
  entries: SessionEntry[],
  leafId: string | null | undefined,
  byId: Map<string, SessionEntry>,
): SessionEntry[] {
  if (leafId === null) return [];

  let leaf: SessionEntry | undefined;
  if (leafId) leaf = byId.get(leafId);
  leaf ??= entries[entries.length - 1];
  if (!leaf) return [];

  const path: SessionEntry[] = [];
  let current: SessionEntry | undefined = leaf;
  while (current) {
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  path.reverse();
  return path;
}

/** 沿路径收集 thinkingLevel 与 model（等价于 SDK 的 getSessionContextSettings，基于本地全路径计算）。 */
function getSessionContextSettings(path: SessionEntry[]): { thinkingLevel: string; model: { provider: string; modelId: string } | null } {
  let thinkingLevel = "off";
  let model: { provider: string; modelId: string } | null = null;
  for (const entry of path) {
    if (entry.type === "thinking_level_change") {
      thinkingLevel = entry.thinkingLevel;
    } else if (entry.type === "model_change") {
      model = { provider: entry.provider, modelId: entry.modelId };
    } else if (entry.type === "message" && entry.message.role === "assistant") {
      model = { provider: entry.message.provider, modelId: entry.message.model };
    }
  }
  return { thinkingLevel, model };
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

function omitToolResultBase64Images(message: AgentMessage): AgentMessage {
  if (message.role !== "toolResult") return message;

  let omitted = 0;
  let bytes = 0;
  const mimes = new Set<string>();
  const content = message.content.filter((block) => {
    const image = base64ImageInfo(block);
    if (!image) return true;
    omitted += 1;
    bytes += image.bytes;
    if (image.mime) mimes.add(image.mime);
    return false;
  });
  if (omitted === 0) return message;

  const mimeText = mimes.size > 0 ? `: ${[...mimes].join(", ")}` : "";
  content.push({
    type: "text",
    text: `[${omitted} tool result image${omitted === 1 ? "" : "s"} omitted from initial history payload${mimeText}, ~${bytes} bytes]`,
  });
  return { ...message, content };
}

// Convert a session entry on the active branch into a UI message.
// Returns null for entries that do not map to chat history (metadata, non-message types).
function entryToUiMessage(
  entry: SessionEntry,
  options: { deferThinking?: boolean; deferToolResultImages?: boolean },
): AgentMessage | null {
  // Supported message roles: user, assistant, toolResult, bashExecution.
  // bashExecution messages enter the case "message" branch (entry.type === "message").
  // The early return at line below ("!options.deferThinking || message.role !== "assistant"")
  // passes non-assistant messages — including bashExecution — through unchanged.
  // normalizeToolCalls is a secondary guard (returns non-assistant messages as-is).
  switch (entry.type) {
    case "message": {
      // Session files are parsed without validation; old versions, forks, or
      // hand-edited files can contain messages with null/missing content.
      // Mirror the SDK's sessionEntryToContextMessages guard so the
      // deferThinking content.map() below cannot throw on null.
      const raw = entry.message;
      const safe = (raw as { content?: unknown }).content == null
        ? { ...raw, content: [] }
        : raw;
      const message = options.deferToolResultImages
        ? omitToolResultBase64Images(normalizeToolCalls(safe))
        : normalizeToolCalls(safe);
      if (!options.deferThinking || message.role !== "assistant") return message;
      return {
        ...message,
        content: message.content.map((block) => (
          block.type === "thinking" && block.thinking.trim() !== ""
            ? { ...block, thinking: "", deferred: true }
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
