import {
  SessionManager,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { openSync, closeSync, existsSync, fstatSync, readFileSync, readSync, readdirSync, statSync, type Dirent, type Stats } from "fs";
import { homedir } from "node:os";
import { open as openFileAsync, readdir } from "fs/promises";
import { dirname, isAbsolute, join, normalize as normalizePath, relative, resolve as resolvePath, sep } from "path";
import { writePrivateFileAtomicSync } from "./atomic-file.ts";
import type { AgentMessage, ImageContent, SessionEntry, SessionHeader, SessionInfo, SessionContext } from "./types.ts";
import type { SessionEntry as PiSessionEntry, SessionInfo as PiSessionInfo } from "@earendil-works/pi-coding-agent";
import { normalizeToolCalls } from "./normalize.ts";
import { getThinkingPreview } from "./message-display.ts";
import { projectIdentityKey } from "./project-identity.ts";
import { sessionPathKey } from "./session-path.ts";
import { MAX_TOOL_RESULT_IMAGE_BYTES, TOOL_RESULT_IMAGE_MIMES } from "./tool-result-images.ts";
import type { ProjectInfo } from "./worktree.ts";
import { readSubagentRun, SUBAGENT_META_TYPE } from "./subagents.ts";

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
   * 外部子代理（pi-subagents 生态工件）：spawn 模式的子代理 session 落在
   *   <sessions>/<cwdDir>/<parentDirName>/<runUuid>/run-N/session.jsonl
   * header 无 parentSession 标记（它走环境变量传父子关系），由落盘路径推断。
   * parentId = parentDirName 末段（父 session uuid）；profile 从 run 工件名 best-effort。
   */
  externalSubagent?: { profile?: string; parentId: string };
}

interface ListCacheEntry {
  mtimeMs: number;
  size: number;
  /**
   * 已解析到的字节偏移（append-only 增量解析基准）：下轮扫描只解析此后追加的行。
   * 缺省 = 该条目尚无偏移基准（旧版缓存条目）；其文件一旦变更即走全量解析并补记偏移。
   */
  offset?: number;
  info: SessionFileInfo;
}

interface ListCacheFile {
  version: number;
  updatedAt: string;
  files: Record<string, ListCacheEntry>;
}

const LIST_CACHE_VERSION = 2; // v2: derive 新增 pi-subagents 嵌套工件路径推断（externalSubagent）；条目 offset 为向后兼容新增（旧缓存缺 offset → 变更时全量解析一次补记）
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
 * 全量解析 + 记录解析终点（字节偏移，作为后续增量解析的基准）。
 * ⚠ 同步读整文件并逐行 JSON.parse——大会话（10-20MB）耗时秒级，只应在
 * 首次解析/基准失效（截断、无偏移）时使用；日常追加走 deriveSessionFileInfoAppended。
 */
function deriveSessionFileInfoFull(filePath: string): { info: SessionFileInfo; parsedEnd: number } | null {
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
  // pi-subagents 工件适配：spawn 模式的子代理 session 落在
  //   <sessions>/<cwdDir>/<parentDirName>/<runUuid>/run-N/session.jsonl
  // header 无 parentSession（它用环境变量传父子关系），从落盘路径推断父 session 文件；
  // profile 从同目录 subagent-artifacts/<runUuid>_<profile>_transcript.jsonl best-effort 提取。
  let parentSessionPath = header.parentSession;
  let externalSubagent: SessionFileInfo["externalSubagent"];
  if (!parentSessionPath) {
    const m = filePath.match(/\/([^/]+)\/([^/]+)\/run-\d+\/session\.jsonl$/);
    if (m) {
      const candidate = `${filePath.slice(0, m.index)}/${m[1]}.jsonl`;
      if (existsSync(candidate)) {
        parentSessionPath = candidate;
        // pi session 文件名 = <timestamp>_<uuid>，末段即父 session id（父文件被归档后仍可标记）
        const parentId = m[1].includes("_") ? m[1].split("_").pop()! : m[1];
        let profile: string | undefined;
        try {
          const artsDir = join(dirname(dirname(filePath)), "subagent-artifacts");
          const hit = readdirSync(artsDir).find(
            (f) => f.startsWith(`${m[2]}_`) && f.endsWith("_transcript.jsonl"),
          );
          if (hit) profile = hit.slice(m[2].length + 1, -"_transcript.jsonl".length) || undefined;
        } catch {
          // 无 artifacts 目录（清理过/老版本）— profile 留空
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
    },
    parsedEnd,
  };
}

/**
 * Append-only 增量解析：只解析 prev.offset 之后的追加段，字段累计语义与全量版逐条镜像
 * （message 计数、user/assistant 活动时间戳、首条 user 消息、session_info 改名后者覆盖）。
 * 返回 null = 基准无效（无偏移/文件截断重写/读失败），调用方回退全量解析。
 * IO 走 fs.promises 异步读，不阻塞事件循环（服务端红线）。
 */
async function deriveSessionFileInfoAppended(
  filePath: string,
  prev: ListCacheEntry,
  st: Pick<Stats, "size">,
): Promise<{ info: SessionFileInfo; parsedEnd: number } | null> {
  const start = prev.offset;
  if (typeof start !== "number" || !Number.isFinite(start) || start < 0) return null;
  if (st.size < start) return null; // truncated / rewritten — full re-parse
  if (st.size === start) return { info: prev.info, parsedEnd: start }; // mtime-only change, no appended bytes

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
  // \n 不会是多字节 UTF-8 序列的一部分（自同步编码），字符串级切行安全。
  let end = start;
  let lineStart = 0;
  for (;;) {
    const nl = chunk.indexOf("\n", lineStart);
    const isTail = nl === -1;
    const line = isTail ? chunk.slice(lineStart) : chunk.slice(lineStart, nl);
    // 与 SDK parseSessionEntryLine 同语义：空行/坏行跳过；可完整解析的无换行尾行也计入
    //（写入方 append \n 前的窗口），半行则留待下轮（end 不推进过它）。
    const entry = line.trim() ? tryParseEntryLine(line) : null;
    if (entry) {
      if (entry.type === "session_info") {
        name = (entry as { name?: string }).name?.trim() || undefined;
      } else if (entry.type === "message") {
        messageCount++;
        const ts = getMessageActivityTime(entry as SessionEntry & { message?: AgentMessage });
        if (typeof ts === "number" && ts > lastActivityMs) lastActivityMs = ts;
        if (!firstMessage || firstMessage === "(no messages)") {
          const msg = (entry as { message?: AgentMessage }).message;
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

  return {
    info: {
      ...prev.info,
      name,
      messageCount,
      firstMessage,
      modified: new Date(lastActivityMs),
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
    // 内存层：1.5MB+ JSON 每次扫描同步 parse 不菲（dev/prod 双实例共享 sessions 目录时
    // 对方写入会使 mtime 变化 → 自动失效重读，语义安全）。
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
    // 同步刷新内存层指向刚写入的版本（避免下轮扫描因 mtime 变化重读盘）。
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
 * 变更文件解析：增量优先（append-only 追加段，KB 级/次），基准缺失/失效回退全量。
 * 按解析字节数分批让出事件循环（setImmediate）——大库冷扫描（1500+ 文件，活跃
 * 会话 10-20MB）不再冻结 dev server 的其他请求（服务端红线：禁长阻塞）。
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
    // 让步预算：增量段只计实际解析字节；全量解析按整文件计（同步大块）。
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
    // pi-subagents 嵌套工件：父目录名与父 session 文件同名；下两层固定
    // <runUuid>/run-N/session.jsonl。只探固定名，不任意递归。
    try {
      for (const sub of readdirSync(dir, { withFileTypes: true })) {
        if (!sub.isDirectory() && !sub.isSymbolicLink()) continue;
        const subDir = join(dir, sub.name);
        // pi fork 子代理（pi 内部 fork 子代理落盘）：<parentDir>/forks/<date>_<id>.jsonl
        // 平铺一层，文件名与顶层会话同构（<date>_<uuid>.jsonl）；父子关系由 header
        // parentSession（父会话文件路径）在解析期推导——这里只需把文件扫进列表。
        // 与上方的 run-N 工件探测正交（forks 目录只存在于 fork 父目录下）。
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
  // （本轮 stat/解析结果直接组装，不再对全部文件二次 statSync。）
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
    .sort((a, b) => b.modified.getTime() - a.modified.getTime());
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
/** 单条 SessionInfo（P0-A 轻量 meta 端点用）：走同一增量扫描缓存（mtime/size，
 *  命中已有缓存零磁盘成本），拼装与列表完全同源（relation/项目信息/扩展标注在外层）。 */
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
  // 分批限并发：冷启动一波几十个 git spawn 在繁忙事件循环上排队数秒；批间让步。
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
  // 我方增量磁盘扫描（mtime/size 缓存，只重解析变更文件）替代
  // SessionManager.listAll() 的全量逐行重解析；富化逻辑与上游一致。
  const scanned: SessionFileInfo[] = await activeSessionScan();
  const pathToId = new Map<string, string>();
  for (const s of scanned) pathToId.set(sessionPathKey(s.path), s.id);

  const sessions = scanned.map((s) => sessionInfoFromScan(s, pathToId));
  return attachSessionProjectInfo(sessions);
}

/** 单条扫描记录 → SessionInfo（loadAllSessions / getSessionMeta 共用拼装）。 */
function sessionInfoFromScan(s: SessionFileInfo, pathToId: Map<string, string>) {
  {
    cacheSessionPath(s.id, s.path);
    const originSessionId = s.parentSessionPath ? pathToId.get(sessionPathKey(s.parentSessionPath)) : undefined;
    let subagent = null;
    if (s.parentSessionPath) {
      try {
        subagent = readSubagentRun(readSessionRelationEntries(s.path), s.id, s.path);
      } catch { /* malformed or concurrently removed session */ }
      // 外部子代理（pi-subagents 生态工件）：header 无 parentSession 且无 SUBAGENT_META_TYPE
      // entry，落盘路径推断出的 parentSessionPath/externalSubagent 即父子关系真源。
      // 构造等价 subagent relation：前端徽标/父子树/Agents 面板对它一视同仁。
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
          // spawn 模式子代理落盘后不再变化：有实际对话内容视为完成，否则中断
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
      ...(subagent
        ? { relation: { kind: "subagent" as const, parentSessionId: subagent.parentSessionId, profile: subagent.profile, description: subagent.description, status: subagent.status } }
        : s.parentSessionPath
          ? { relation: { kind: "fork" as const, ...(originSessionId ? { originSessionId } : {}) } }
          : {}),
      transient: false,
    };
  }
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
  globalThis.__piSessionListCache = undefined;
}

export function getSessionListVersion(): number {
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
 * 空会话（文件惰性未落盘）时，按 id 反查 TUI 桥注册表，返回 registry key
 * （= sessionFile 路径）。attach 判定以 socket（bridge-registry.json）为优先，
 * 文件只是历史回放；有 live bridge 即可 attach，不必等文件落盘。
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
    // 无注册表/解析失败 → 无桥
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
  const entries = SessionManager.open(filePath).getEntries();
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
  // 我方语义：model_change 优先（运行中 set_model 后 abort 落盘的旧模型残戳会比
  // model_change 更靠近 leaf，按「就近优先」会回退旧模型），但增加 branch 纠偏：
  // 「从这里编辑」/分支导航 branch 回更早节点后，新链祖先上没有切模型时的 model_change
  // （它留在旧分支上），而新链 assistant 消息戳才是引擎实际执行的模型（引擎内存态
  // branch 不重置）。两种形状的区别：abort 残戳紧跟 model_change（中间无 user）；
  // branch 新链的戳与旧 model_change 之间必然隔着新发的 user 消息 →
  // 仅当「戳更近 + 隔了 user + 模型不同」时才以戳为准，其余维持 model_change 优先。
  let model: SessionContext["model"] | undefined;
  let sawModelChange = false;
  let assistantStamp: SessionContext["model"] | undefined;
  // assistant 戳先于 model_change 被遇到（= 戳更靠近 leaf），且两者之间隔着 user 消息
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

  // branch 纠偏（见上）：戳更近、隔了 user、模型不同 → 新分支上实际执行的就是戳的模型。
  // 同模型时取谁都一致，维持 model_change；无戳/戳缺 provider 时回退现状。
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
    ...getSessionSettings(entries, leafId),
  };
}

/**
 * Extract the ancestor chain from `leafId` back toward the root, capped at
 * `tail` entries (most-recent first after the final reverse). Iterative: a
 * linear session's chain length equals its entry count, so a recursive walk
 * would overflow the stack. The result is still a valid prefix of the active
 * branch — older history is loaded on demand via pagination.
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
  while (current && chain.length < tail) {
    chain.push(current);
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

// Convert a session entry on the active branch into a UI message.
// Returns null for entries that do not map to chat history (metadata, non-message types).
function entryToUiMessage(
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
      // Session files are parsed without validation; old versions, forks, or
      // hand-edited files can contain messages with null/missing content.
      // Mirror the SDK's sessionEntryToContextMessages guard so the
      // deferThinking content.map() below cannot throw on null.
      const raw = entry.message;
      const safe = (raw as { content?: unknown }).content == null
        ? { ...raw, content: [] }
        : raw;
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
