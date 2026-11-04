/**
 * session-manager — message index (SQLite FTS5, trigram tokenizer).
 *
 * Incremental: a `files` table stores (mtime_ms, size) per indexed session
 * file; only changed files are re-parsed. Archived sessions keep their rows
 * (archived=1 + archive_ref) even after the live file is gone, so search and
 * browsing still work after archiving ("归档前有索引").
 *
 * Built with node:sqlite (Node ≥22, no native deps). FTS5 trigram tokenizer
 * matches Chinese for ≥3-char queries; 2-char queries fall back to LIKE.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, statSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { parseSessionFile, type IndexedMessage, type SessionFileMeta, type ParsedSessionFile } from "./session-file.ts";
import type { ExtSessionRef } from "./agents/types.ts";
import { computeStatsCached } from "./session-stats.ts";

/**
 * 虚拟会话路径判定（memory://…、provider:ext#agent:sid 等）。
 * ⚠ Windows 修复（2026-09-19）：单字母盘符 `C:\`/`C:/` 会被 `/^[a-z][a-z0-9+.-]*:/i`
 * 误判成 scheme "c:"——后果：syncExt 的 rev 水位分支被跳过（db 型源全量重解析）+
 * GC 判活恒真（文件删了行清不掉）。真 URI scheme 按 RFC ≥2 字符，盘符单字母显式排除。
 */
const URI_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const DRIVE_PATH_RE = /^[a-z]:[\\/]/i;
const isVirtualPath = (p: string): boolean => URI_SCHEME_RE.test(p) && !DRIVE_PATH_RE.test(p);

export interface SessionIndex {
  ensure(): void;
  /** Sync the index with the current live session files (stat-compare).
   *  async：每会话独立事务 + 批间让步事件循环（原单一大事务可达数十秒，阻塞探活）。 */
  sync(sessions: Array<{ path: string; id: string; cwd: string }>): Promise<{ indexed: number; removed: number }>;
  /** M1: incremental sync of one external agent source (scoped, no cross-agent GC).
   *  ref.rev（可选，2026-09-12）：per-session 版本水位（db 型源 zcode/opencode 用
   *  session.time_updated）——带 rev 的 ref 比对 files.mtime_ms === rev，不再 statSync
   *  物理文件（db 型源物理文件恒变，stat 水位恒判变 → 全量重解析事故）。 */
  syncExt(agent: string, refs: ExtSessionRef[], parse: (ref: ExtSessionRef) => ParsedSessionFile | null): { indexed: number; removed: number };
  /** 按需单会话 upsert（enrichExtPlaceholders 用）：只写 sessions/messages/fts，
   *  不动 files 水位、不做 GC——判活与重写交给下一次全量 syncExt（源判变后必重
   *  parse，不存在水位缺写导致永久跳过）。 */
  upsertExtParsed(agent: string, sid: string, refPath: string, parsed: ParsedSessionFile): void;
  /** 列表层时间戳刷新（listFresh 通道，2026-09-10）：只前进 ext 行 modified
   *  （顺带补 name），不碰 messages/fts/message_count——内容仍由全量 syncExt
   *  收敛。仅当源时间比索引新才写（防回退 + 防无谓 rowRev 抖动）。返回变更行数。 */
  refreshExtTimestamps(agent: string, fresh: Array<{ sid: string; timeUpdatedMs?: number; title?: string }>): number;
  /** M1: rows of activated external sources (merged-list tail). */
  extRows(agents?: string[]): Array<IndexedSessionRow & { agent: string }>;
  /** Mark sessions archived (called by the archive pipeline before deletion). */
  markArchived(packageRef: string, sessionIds: string[]): { changed: number };
  /** ext 源行视图层归档翻转（hide/unhide）。与 markArchived 不同：path 保留——
   *  ext 同步 GC 靠 path 判活，置 NULL 会让 archived 行被 GC 误删、随后源同步复活。 */
  setExtArchived(id: string, archived: boolean): number;
  search(q: string, limit: number, filters?: SearchFilters): SearchHit[];
  /** §14.3: aggregated stats (totals / model distribution / heatmap). */
  stats(runningSessionIds: string[], days?: number): import("./session-stats.ts").SessionStats;
  /** §14.4: last message's role + model for row badges/filters. */
  lastMeta(sessionId: string): { model: string | null; role: string } | undefined;
  /** 批量 lastMeta（merged 列表用，一条 SQL）。 */
  lastMetaBatch(sessionIds: string[]): Map<string, { model: string | null; role: string }>;
  /** §14.4: fallback for rows indexed before the last_message migration. */
  lastMessageText(sessionId: string): string;
  /** 批量 lastMessageText 兜底（merged 列表用，一条 SQL）。 */
  lastMessageTextBatch(sessionIds: string[]): Map<string, string>;
  getSession(id: string): IndexedSessionRow | undefined;
  /** 批量 getSession（merged 列表用，一条 SQL）。 */
  getSessionBatch(sessionIds: string[]): Map<string, IndexedSessionRow>;
  /** Archived sessions for the merged list (live list comes from core). */
  archivedRows(): Array<{ id: string; path: string | null; cwd: string; name?: string; created: string; modified: string; messageCount: number; firstMessage: string; lastMessage: string; projectRoot?: string; worktreeBranch?: string; archived: boolean; archiveRef: string | null }>;
  /** Restore an archived row back to live WITHOUT touching its messages/FTS rows
   *  (the restored file is byte-identical — sha256 verified — so the index stays valid). */
  restoreToLive(id: string, path: string): void;
  removeSession(id: string): void;
  /** M1: drop every row owned by one external agent source. */
  removeAgentRows(agent: string): void;
  close(): void;
}

/** ext 源行「从列表移除」的 archive_ref 标记（视图层归档，无 .pwarc 包）。 */
export const EXT_ARCHIVE_REF = "__ext__";

export interface SearchFilters {
  model?: string;
  role?: string;
  archived?: boolean;
}

export interface IndexedSessionRow {
  id: string;
  path: string | null;
  cwd: string;
  name: string | null;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  lastMessage: string;
  archived: number;
  archiveRef: string | null;
  /** 站位行专属：外部复合 id（"cursor:<chatId>"）；普通 pi/ext 行为 NULL。 */
  extId?: string | null;
  /** 站位行专属：外部 agent 键（header.agent）；普通 pi 行为 'pi'（SELECT 需显式带出）。 */
  agent?: string | null;
  /** ext 行专属：源内父会话原生 sid（zcode subagent_child 等）；pi 行为 NULL。 */
  parentSid?: string | null;
}

export interface SearchHit {
  sessionId: string;
  title: string;
  cwd: string;
  modified: string;
  archived: boolean;
  text: string;
  role: string;
}

/** 只读文件头部 n 字节（自愈嗅探用，避免大文件全量读取）。 */
function readHead(path: string, n: number): string {
  let fd: number | null = null;
  try {
    const buf = Buffer.alloc(n);
    fd = openSync(path, "r");
    const got = readSync(fd, buf, 0, n, 0);
    return buf.toString("utf8", 0, got);
  } catch {
    return "";
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* already closed */ }
  }
}

export function openSessionIndex(dbPath: string): SessionIndex {
  const db = new DatabaseSync(dbPath);
  // dev/prod 双实例共享同一 dataDir（PI_WEB_DATA_DIR）时两进程并发写本库：
  // 无 busy_timeout 时并发写立即 SQLITE_BUSY → sync 事务回滚 → 行间歇性丢失（实测
  // 站位行时有时无）。5s 重试窗口足够另一进程事务提交。
  try { db.exec("PRAGMA busy_timeout = 5000"); } catch { /* old node without pragma support */ }
  // WAL：写不阻塞读、COMMIT 免全量 journal 同步——3G 级索引库大事务 COMMIT 从秒级降到
  // 毫秒级（journal_mode 持久化进库文件，设一次永久生效；synchronous=NORMAL 为 WAL 推荐档）。
  try { db.exec("PRAGMA journal_mode = WAL"); db.exec("PRAGMA synchronous = NORMAL"); } catch { /* old node */ }
  // wal 收敛上限：长跑防积压（实测 wal 滚到 17M——auto-checkpoint 被推迟时同步
  // fsync 会造成秒级事件循环卡顿，即探活单次失败的毛刺源之一）
  try { db.exec("PRAGMA journal_size_limit = 8388608"); } catch { /* old node */ }
  const impl: SessionIndex = {
    ensure() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS files (
          path TEXT PRIMARY KEY,
          mtime_ms INTEGER NOT NULL,
          size INTEGER NOT NULL,
          indexed_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          path TEXT,
          cwd TEXT NOT NULL,
          name TEXT,
          created TEXT NOT NULL,
          modified TEXT NOT NULL,
          message_count INTEGER NOT NULL DEFAULT 0,
          first_message TEXT NOT NULL DEFAULT '',
          last_message TEXT NOT NULL DEFAULT '',
          archived INTEGER NOT NULL DEFAULT 0,
          archive_ref TEXT
        );
        CREATE TABLE IF NOT EXISTS messages (
          session_id TEXT NOT NULL,
          entry_id TEXT NOT NULL,
          role TEXT NOT NULL,
          ts TEXT,
          model TEXT,
          provider TEXT,
          tool_name TEXT,
          text TEXT NOT NULL,
          PRIMARY KEY (session_id, entry_id)
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
          session_id UNINDEXED,
          role UNINDEXED,
          text,
          tokenize='trigram'
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_modified ON sessions(modified);
        CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
        CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
      `);
      // §14.4 migration: add last_message to existing DBs (ensure() is a no-op on old schemas).
      const cols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === "last_message")) {
        db.exec("ALTER TABLE sessions ADD COLUMN last_message TEXT NOT NULL DEFAULT ''");
      }
      // M1 multi-agent: composite ids ("claude:<uuid>") + agent column ("pi" default).
      if (!cols.some((c) => c.name === "agent")) {
        db.exec("ALTER TABLE sessions ADD COLUMN agent TEXT NOT NULL DEFAULT 'pi'");
        db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent)");
      }
      // 站位文件：pi 会话（uuid） → 外部复合 id 的反向指针（仅站位行非 NULL）。
      if (!cols.some((c) => c.name === "ext_id")) {
        db.exec("ALTER TABLE sessions ADD COLUMN ext_id TEXT");
      }
      // ext 行源内父子链（2026-09-13）：zcode session.parent_id（subagent_child）等，
      // 存源内原生 sid（非复合 id）——API 层按 agent 组合。pi 行恒 NULL。
      if (!cols.some((c) => c.name === "parent_sid")) {
        db.exec("ALTER TABLE sessions ADD COLUMN parent_sid TEXT");
        // 一次性回填：syncExt 按 rev（session.time_updated）水位跳过未变会话，存量行
        // 永远等不到 parent_sid——清 zcode 源水位，下一轮 syncExt 全量重 parse（直读，
        // 每会话毫秒级）自然落库。AITI_ZCODE_HOME 重定向的实例不在匹配范围（非默认布局）。
        db.prepare("DELETE FROM files WHERE path LIKE '%.zcode/cli/db/db.sqlite#session:%'").run();
      }
      // 2026-09-12 一次性清理：zcode/opencode 旧 copyDb 副本的水位行。副本路径已随
      // 直读改造废弃（refs path 改指源库），残留行永不匹配、纯垃圾。每次 ensure 跑
      // 一条 PK 索引 DELETE，清理完成后为 no-op，成本可忽略。
      db.prepare("DELETE FROM files WHERE path LIKE '/tmp/sm-zcode-cache%' OR path LIKE '/tmp/sm-opencode-cache%'").run();
    },

    async sync(sessions) {
      let indexed = 0;
      const now = new Date().toISOString();
      const livePaths = new Set<string>();
      const unchangedPaths = new Set<string>();
      const upsertSession = db.prepare(`
        INSERT INTO sessions (id, path, cwd, name, created, modified, message_count, first_message, last_message, agent, ext_id, archived, archive_ref)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT archived FROM sessions WHERE id = ?), 0), COALESCE((SELECT archive_ref FROM sessions WHERE id = ?), NULL))
        ON CONFLICT(id) DO UPDATE SET
          path=excluded.path, cwd=excluded.cwd, name=excluded.name, created=excluded.created,
          modified=excluded.modified, message_count=excluded.message_count, first_message=excluded.first_message, last_message=excluded.last_message,
          agent=excluded.agent, ext_id=excluded.ext_id;
      `);
      const deleteMessages = db.prepare("DELETE FROM messages WHERE session_id = ?");
      const deleteFts = db.prepare("DELETE FROM fts WHERE session_id = ?");
      const upsertFile = db.prepare("INSERT OR REPLACE INTO files (path, mtime_ms, size, indexed_at) VALUES (?, ?, ?, ?)");
      const insertMessage = db.prepare("INSERT OR REPLACE INTO messages (session_id, entry_id, role, ts, model, provider, tool_name, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      const insertFts = db.prepare("INSERT INTO fts (session_id, role, text) VALUES (?, ?, ?)");
      const getFile = db.prepare("SELECT mtime_ms, size FROM files WHERE path = ?");

      const tx = (fn: () => void) => { db.exec("BEGIN"); try { fn(); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; } };

      // 让步原语：批间把事件循环还给探活/请求（guard curl -m 3 不再撞上长阻塞）。
      const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));
      // 活跃会话静默期：mtime 距今 < QUIET_MS 的文件本轮跳过——AI 追加消息会高频触发
      // 全量重索引（DELETE 全部消息+FTS → 逐条重插），是 2026-09-10 阻塞事件循环 →
      // guard 探活超时 → 重启风暴的元凶；静默后才收敛，搜索滞后 ≤1min 可接受。
      // livePaths 照记：GC 判活不受静默跳过影响。
      const QUIET_MS = 60_000;
      const nowMs = Date.now();
      const jobs: Array<{ st: ReturnType<typeof statSync>; parsed: ParsedSessionFile }> = [];
      let sinceYield = 0;
      for (const s of sessions) {
        if (!existsSync(s.path)) continue;
        livePaths.add(s.path);
        const st = statSync(s.path);
        const row = getFile.get(s.path) as { mtime_ms: number; size: number } | undefined;
        if (row && row.mtime_ms === st.mtimeMs && row.size === st.size) { unchangedPaths.add(s.path); continue; } // unchanged
        // 静默期只挡「已索引过但又变了」的复索引（高频全量重索引正是这个场景）；
        // 首次见到的文件（无水位行）立即索引，新会话不受 60s 延迟。
        if (row && nowMs - st.mtimeMs < QUIET_MS) continue; // 活跃写入中：本轮跳过，静默后收敛
        const raw = readFileSync(s.path, "utf8");
        const parsed = parseSessionFile(s.path, raw);
        if (!parsed) continue;
        jobs.push({ st, parsed });
        if (++sinceYield >= 5) { sinceYield = 0; await yieldToLoop(); } // 解析在事务外，批间让步
      }

      // 每会话独立事务 + 会话间让步：单次连续阻塞从「全会话单大事务」（大会话可达数十秒）
      // 压到单会话事务以内，事件循环始终可响应。
      for (const { st, parsed } of jobs) {
        const m = parsed.meta;
        tx(() => {
          upsertSession.run(m.id, m.path, m.cwd, m.name ?? null, m.created, m.modified, m.messageCount, m.firstMessage, m.lastMessage, m.agent ?? "pi", m.extId ?? null, m.id, m.id);
          deleteMessages.run(m.id);
          deleteFts.run(m.id);
          for (const msg of parsed.messages) {
            insertMessage.run(m.id, msg.entryId, msg.role, msg.ts, msg.model ?? null, msg.provider ?? null, msg.toolName ?? null, msg.text);
            insertFts.run(m.id, msg.role, msg.text);
          }
          upsertFile.run(m.path, st.mtimeMs, st.size, now);
        });
        indexed++;
        await yieldToLoop();
      }

      tx(() => {

        // 自愈重建（2026-09-08）：站位行曾被误删而 files 水印仍在 → unchanged 快捷
        // 路径会永久跳过它（实测：zcode 站位行丢失后不再重建）。只对 unchanged 跳过
        // 的文件做头部嗅探（前 512B 含 "extId" 即站位 header——站位文件总共两行），
        // 命中才全量 parse+upsert；非站位大文件零额外读取。
        const orphanCheck = db.prepare("SELECT 1 FROM sessions WHERE id = ?");
        for (const p of unchangedPaths) {
          const head = readHead(p, 512);
          if (!head.includes('"extId"')) continue; // 普通会话：不读全文
          const parsed = parseSessionFile(p, readFileSync(p, "utf8"));
          if (!parsed?.meta.extId) continue;
          if (orphanCheck.get(parsed.meta.id)) continue;
          const st = statSync(p);
          const m = parsed.meta;
          upsertSession.run(m.id, m.path, m.cwd, m.name ?? null, m.created, m.modified, m.messageCount, m.firstMessage, m.lastMessage, m.agent ?? "pi", m.extId ?? null, m.id, m.id);
          indexed++;
        }

        // Remove index rows whose live file vanished AND are not archived.
        // External-agent rows (composite ids with an agent prefix, no ext_id) are
        // owned by their own source sync and must never be GC'd from here.
        // 站位行（ext_id 非空）是 pi 文件的身份，文件没了 = 用户已删 → 一并 GC。
        // 误删防护（2026-09-08）：livePaths 缺席 ≠ 文件没了——本轮 list 可能偶发
        // 遗漏（缓存/扫描竞态，实测导致站性行被误删且永不重建）。删前确认文件真不在。
        const all = db.prepare("SELECT id, path, archived FROM sessions WHERE agent = 'pi' OR ext_id IS NOT NULL").all() as Array<{ id: string; path: string | null; archived: number }>;
        for (const row of all) {
          if (row.archived) continue;
          if (!row.path || (!livePaths.has(row.path) && !existsSync(row.path))) {
            impl.removeSession(row.id);
          }
        }
      });
      try { db.exec("PRAGMA wal_checkpoint(PASSIVE)"); } catch { /* 忙时跳过，下轮再试 */ }
      return { indexed, removed: 0 };
    },

    /** M1: incremental sync of one external agent source (scoped, no cross-agent GC). */
    async syncExt(agent: string, refs: ExtSessionRef[], parse: (ref: ExtSessionRef) => ParsedSessionFile | null | Promise<ParsedSessionFile | null>): Promise<{ indexed: number; removed: number }> {
      let indexed = 0;
      const now = new Date().toISOString();
      const livePaths = new Set<string>();
      const upsertSession = db.prepare(`
        INSERT INTO sessions (id, path, cwd, name, created, modified, message_count, first_message, last_message, agent, parent_sid)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          path=excluded.path, cwd=excluded.cwd, name=excluded.name, created=excluded.created,
          modified=excluded.modified, message_count=excluded.message_count,
          first_message=excluded.first_message, last_message=excluded.last_message,
          parent_sid=excluded.parent_sid;
      `);
      const deleteMessages = db.prepare("DELETE FROM messages WHERE session_id = ?");
      const deleteFts = db.prepare("DELETE FROM fts WHERE session_id = ?");
      const upsertFile = db.prepare("INSERT OR REPLACE INTO files (path, mtime_ms, size, indexed_at) VALUES (?, ?, ?, ?)");
      const insertMessage = db.prepare("INSERT OR REPLACE INTO messages (session_id, entry_id, role, ts, model, provider, tool_name, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      const insertFts = db.prepare("INSERT INTO fts (session_id, role, text) VALUES (?, ?, ?)");
      const getFile = db.prepare("SELECT mtime_ms, size FROM files WHERE path = ?");

      const tx = (fn: () => void) => { db.exec("BEGIN"); try { fn(); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; } };

      // Phase 1 (sync): stat-compare to find changed refs — no parsing yet.
      const changed: Array<{ ref: ExtSessionRef; mtimeMs: number; size: number }> = [];
      const virtualSids = new Set<string>();
      // 自愈（2026-09-08）：行曾被误删而 files 水印仍在时，unchanged 快捷路径会永久
      // 跳过重建（与 sync() 站位行同款问题）。水印命中但行缺席 → 强制 re-parse。
      const rowExists = db.prepare("SELECT 1 FROM sessions WHERE id = ?");
      for (const ref of refs) {
        const realPath = ref.path.split("#")[0];
        // per-session 版本水位（2026-09-12）：db 型源（zcode/opencode）物理文件每次
        // 同步都在变（写入/WAL），按文件 stat 恒判变 → 全量重解析（61GB/轮拷贝风暴
        // 事故根因）。rev = 源库 session.time_updated——会话没变就零 IO 跳过。
        // livePaths 照记：GC 判活不因水位跳过而误杀（同 stat 路径语义）。
        if (typeof ref.rev === "number" && Number.isFinite(ref.rev) && !isVirtualPath(ref.path)) {
          livePaths.add(realPath);
          const row = getFile.get(ref.path) as { mtime_ms: number; size: number } | undefined;
          if (row && row.mtime_ms === ref.rev && rowExists.get(`${agent}:${ref.sid}`)) continue; // rev 未变 & 行在
          changed.push({ ref, mtimeMs: ref.rev, size: 0 });
          continue;
        }
        // fully-virtual artifacts ("memory://…", "provider:ext#agent:sid") have no
        // file to stat — always re-parse (providers control their own cost) and
        // keep them GC-alive by sid.
        if (!existsSync(realPath)) {
          if (isVirtualPath(ref.path)) { virtualSids.add(`${agent}:${ref.sid}`); changed.push({ ref, mtimeMs: 0, size: 0 }); continue; }
          continue;
        }
        livePaths.add(realPath);
        const st = statSync(realPath);
        const row = getFile.get(ref.path) as { mtime_ms: number; size: number } | undefined;
        if (row && row.mtime_ms === st.mtimeMs && row.size === st.size && rowExists.get(`${agent}:${ref.sid}`)) continue; // unchanged & alive
        changed.push({ ref, mtimeMs: st.mtimeMs, size: st.size });
      }

      // Phase 2 (async-capable): parse outside the transaction (proxy adapters may await).
      type Parsed = NonNullable<Awaited<ReturnType<typeof parse>>>;
      const parsedList: Array<{ ref: ExtSessionRef; mtimeMs: number; size: number; parsed: Parsed }> = [];
      for (const c of changed) {
        let parsed: Parsed;
        try { parsed = (await parse(c.ref)) as Parsed; } catch { continue; }
        if (!parsed) continue;
        parsedList.push({ ref: c.ref, mtimeMs: c.mtimeMs, size: c.size, parsed });
      }

      // Phase 3: per-session transactions + yields（原单一大事务写全部 → 每会话独立
      // 事务、会话间让步事件循环；scoped GC 独立小事务）。

      let sinceYield = 0;
      for (const { ref, mtimeMs, size, parsed } of parsedList) {
        const m = parsed.meta;
        const id = `${agent}:${m.id}`;
        tx(() => {
          upsertSession.run(id, ref.path, m.cwd ?? "", m.name ?? null, m.created, m.modified, m.messageCount, m.firstMessage, m.lastMessage, agent, m.parentSid ?? null);
          deleteMessages.run(id);
          deleteFts.run(id);
          for (const msg of parsed.messages) {
            insertMessage.run(id, msg.entryId, msg.role, msg.ts, msg.model ?? null, msg.provider ?? null, msg.toolName ?? null, msg.text);
            insertFts.run(id, msg.role, msg.text);
          }
          upsertFile.run(ref.path, mtimeMs, size, now);
        });
        indexed++;
        if (++sinceYield >= 5) { sinceYield = 0; await new Promise<void>((r) => setImmediate(r)); }
      }

      // Scoped GC: drop this agent's rows whose artifact vanished. Virtual paths
      // share the same real file — presence of the real file keeps them all alive;
      // fully-virtual refs stay alive by id while the provider keeps listing them.
      tx(() => {
        const mine = db.prepare("SELECT id, path FROM sessions WHERE agent = ?").all(agent) as Array<{ id: string; path: string | null }>;
        for (const r of mine) {
          const rp = r.path?.split("#")[0] ?? null;
          const aliveByFile = rp !== null && livePaths.has(rp);
          const aliveByVirtual = virtualSids.has(r.id);
          if (!aliveByFile && !aliveByVirtual) impl.removeSession(r.id);
        }
      });
      void now;
      return { indexed, removed: 0 };
    },

    upsertExtParsed(agent, sid, refPath, parsed) {
      const m = parsed.meta;
      const id = `${agent}:${sid}`;
      db.exec("BEGIN");
      try {
        db.prepare(`
          INSERT INTO sessions (id, path, cwd, name, created, modified, message_count, first_message, last_message, agent, parent_sid)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            path=excluded.path, cwd=excluded.cwd, name=excluded.name, created=excluded.created,
            modified=excluded.modified, message_count=excluded.message_count,
            first_message=excluded.first_message, last_message=excluded.last_message,
            parent_sid=excluded.parent_sid;
        `).run(id, refPath, m.cwd ?? "", m.name ?? null, m.created, m.modified, m.messageCount, m.firstMessage, m.lastMessage, agent, m.parentSid ?? null);
        const deleteMessages = db.prepare("DELETE FROM messages WHERE session_id = ?");
        const deleteFts = db.prepare("DELETE FROM fts WHERE session_id = ?");
        const insertMessage = db.prepare("INSERT OR REPLACE INTO messages (session_id, entry_id, role, ts, model, provider, tool_name, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
        const insertFts = db.prepare("INSERT INTO fts (session_id, role, text) VALUES (?, ?, ?)");
        deleteMessages.run(id);
        deleteFts.run(id);
        for (const msg of parsed.messages) {
          insertMessage.run(id, msg.entryId, msg.role, msg.ts, msg.model ?? null, msg.provider ?? null, msg.toolName ?? null, msg.text);
          insertFts.run(id, msg.role, msg.text);
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },

    /** 运行中 ext 会话时间戳-only 刷新：sessions.modified 前进（name 顺带），
     *  messages/fts/message_count 不动。只对「源 time 严格 > 索引现有」的行写——
     *  避免时钟回拨/无变化时制造 rowRev 抖动（patch 风暴）。
     *  fresh 由 adapter.listFresh() 供（零 parse 轻量快照），未入索引的行跳过
     *  （站位未落/未 sync 的会话由全量 syncExt 补全）。 */
    refreshExtTimestamps(agent, fresh) {
      let changed = 0;
      const getRow = db.prepare("SELECT modified, name FROM sessions WHERE id = ? AND agent = ?");
      const updMod = db.prepare("UPDATE sessions SET modified = ? WHERE id = ?");
      const updName = db.prepare("UPDATE sessions SET name = ? WHERE id = ?");
      db.exec("BEGIN");
      try {
        for (const f of fresh) {
          if (typeof f.timeUpdatedMs !== "number" || !Number.isFinite(f.timeUpdatedMs) || f.timeUpdatedMs <= 0) {
            continue;
          }
          const id = `${agent}:${f.sid}`;
          const cur = getRow.get(id, agent) as { modified: string; name: string | null } | undefined;
          if (!cur) continue; // 未入索引 → 全量 sync 兜底
          const curMs = Date.parse(cur.modified);
          if (!Number.isFinite(curMs) || f.timeUpdatedMs <= curMs) continue; // 未前进 → 不写
          updMod.run(new Date(f.timeUpdatedMs).toISOString(), id);
          const title = typeof f.title === "string" ? f.title.trim() : "";
          if (title) updName.run(title, id);
          changed++;
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      return changed;
    },

    /** M1: rows of activated external sources (merged-list tail). ext_id 非空的是
     *  站位 pi 文件行（agent 已随 header 写入），不属于外部源同步管辖，排除。 */
    extRows(agents?: string[]): Array<IndexedSessionRow & { agent: string }> {
      // archived=0：ext 行「从列表移除」后留在归档分组（archivedRows 出），live 尾不再重复
      const where = agents && agents.length ? `WHERE agent IN (${agents.map(() => "?").join(",")}) AND ext_id IS NULL AND archived = 0` : "WHERE agent != 'pi' AND ext_id IS NULL AND archived = 0";
      const params = agents && agents.length ? agents : [];
      return db.prepare(
        `SELECT id, path, cwd, name, created, modified, message_count as messageCount, first_message as firstMessage, last_message as lastMessage, archived, archive_ref as archiveRef, agent, ext_id as extId, parent_sid as parentSid FROM sessions ${where} ORDER BY modified DESC`,
      ).all(...params) as Array<IndexedSessionRow & { agent: string }>;
    },

    /** Mark sessions archived (called by the archive pipeline before deletion).
     *  Returns the number of rows actually flipped — an unindexed session id (no
     *  row) updates 0 rows and must be treated as an integrity failure by the
     *  caller (archive without a record = unrecoverable from the UI). */
    markArchived(packageRef, sessionIds) {
      const stmt = db.prepare("UPDATE sessions SET archived = 1, archive_ref = ?, path = NULL WHERE id = ?");
      let changed = 0;
      const tx = () => { db.exec("BEGIN"); try { for (const id of sessionIds) changed += stmt.run(packageRef, id).changes; db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; } };
      tx();
      // keep messages + fts so search still works
      return { changed };
    },

    search(q, limit, filters) {
      const ql = q.trim();
      if (!ql) return [];
      const like = `%${ql}%`;
      let rows: Array<{ session_id: string; text: string; role: string }>;
      if (ql.length >= 3) {
        const safe = ql.replace(/"/g, '""');
        try {
          if (filters?.model) {
            // ORDER BY bm25: FTS5's default is rowid (insertion) order, which buries
            // hot-term hits from recently indexed sessions beyond LIMIT.
            rows = db.prepare("SELECT f.session_id, f.text, f.role FROM fts f JOIN messages m ON m.session_id=f.session_id AND m.entry_id=f.entry_id WHERE f.fts MATCH ? AND f.role LIKE ? AND m.model = ? ORDER BY bm25(fts) LIMIT ?")
              .all(`"${safe}"`, filters.role ?? "%", filters.model, limit) as typeof rows;
          } else {
            rows = db.prepare("SELECT session_id, text, role FROM fts WHERE fts MATCH ? AND role LIKE ? ORDER BY bm25(fts) LIMIT ?")
              .all(`"${safe}"`, filters?.role ?? "%", limit) as typeof rows;
          }
        } catch {
          rows = [];
        }
      } else {
        // 2-char fallback: LIKE on messages. One row per session (MAX rowid of
        // the matching rows) so LIMIT counts sessions, not message rows — an
        // unsorted row-level LIMIT can surface as few as 4 of 105 matching sessions.
        const sub = "SELECT session_id, MAX(rowid) AS mid FROM messages WHERE text LIKE ?"
          + (filters?.role ? " AND role = ?" : "") + (filters?.model ? " AND model = ?" : "")
          + " GROUP BY session_id";
        const base = `SELECT m.session_id, m.text, m.role FROM messages m JOIN (${sub}) g ON m.session_id = g.session_id AND m.rowid = g.mid JOIN sessions s ON s.id = m.session_id ORDER BY s.modified DESC LIMIT ?`;
        const params: Array<string | number> = [like];
        if (filters?.role) params.push(filters.role);
        if (filters?.model) params.push(filters.model);
        params.push(limit);
        rows = db.prepare(base).all(...params) as typeof rows;
      }
      const out: SearchHit[] = [];
      const seen = new Set<string>();
      for (const r of rows) {
        if (seen.has(r.session_id)) continue; // one hit per session
        seen.add(r.session_id);
        const s = db.prepare("SELECT id, cwd, name, modified, archived FROM sessions WHERE id = ?").get(r.session_id) as
          { id: string; cwd: string; name: string | null; modified: string; archived: number } | undefined;
        if (!s) continue;
        if (filters?.archived !== undefined && (s.archived === 1) !== filters.archived) continue;
        // snippet around the match
        const idx = r.text.toLowerCase().indexOf(ql.toLowerCase());
        const start = Math.max(0, idx - 40);
        const snippet = (start > 0 ? "…" : "") + r.text.slice(start, start + 120) + (start + 120 < r.text.length ? "…" : "");
        out.push({
          sessionId: s.id,
          title: s.name ?? "",
          cwd: s.cwd,
          modified: s.modified,
          archived: s.archived === 1,
          text: snippet,
          role: r.role,
        });
      }
      return out;
    },

    stats(runningSessionIds, days) {
      return computeStatsCached(db, dbPath, runningSessionIds, days);
    },

    /** §14.4: last message's role + model for row badges/filters. */
    lastMeta(sessionId) {
      return db.prepare("SELECT model, role FROM messages WHERE session_id = ? ORDER BY rowid DESC LIMIT 1").get(sessionId) as { model: string | null; role: string } | undefined;
    },

    /** 批量 lastMeta：一条 SQL 取全部会话的最后消息 role/model（merged 列表用，
     *  避免 472 条逐会话 SQL）。返回 Map<sessionId, {role, model}>。 */
    lastMetaBatch(sessionIds) {
      if (sessionIds.length === 0) return new Map();
      const placeholders = sessionIds.map(() => "?").join(",");
      const rows = db.prepare(
        `SELECT m.session_id, m.model, m.role FROM messages m
         JOIN (SELECT session_id, MAX(rowid) AS max_rowid FROM messages
               WHERE session_id IN (${placeholders}) GROUP BY session_id) latest
           ON m.session_id = latest.session_id AND m.rowid = latest.max_rowid`,
      ).all(...sessionIds) as Array<{ session_id: string; model: string | null; role: string }>;
      const map = new Map<string, { model: string | null; role: string }>();
      for (const r of rows) map.set(r.session_id, { model: r.model, role: r.role });
      return map;
    },

    /** §14.4: fallback for rows indexed before the last_message migration. */
    lastMessageText(sessionId) {
      const r = db.prepare("SELECT text FROM messages WHERE session_id = ? AND role IN ('user','assistant') ORDER BY rowid DESC LIMIT 1").get(sessionId) as { text: string } | undefined;
      return r?.text ?? "";
    },

    /** 批量 lastMessageText 兜底：仅对索引行缺 last_message 的会话（旧索引迁移前），
     *  一条 SQL 取全部。返回 Map<sessionId, text>。 */
    lastMessageTextBatch(sessionIds) {
      if (sessionIds.length === 0) return new Map();
      const placeholders = sessionIds.map(() => "?").join(",");
      const rows = db.prepare(
        `SELECT m.session_id, m.text FROM messages m
         JOIN (SELECT session_id, MAX(rowid) AS max_rowid FROM messages
               WHERE session_id IN (${placeholders}) AND role IN ('user','assistant')
               GROUP BY session_id) latest
           ON m.session_id = latest.session_id AND m.rowid = latest.max_rowid`,
      ).all(...sessionIds) as Array<{ session_id: string; text: string }>;
      const map = new Map<string, string>();
      for (const r of rows) map.set(r.session_id, r.text ?? "");
      return map;
    },

    getSession(id) {
      return db.prepare("SELECT id, path, cwd, name, created, modified, message_count as messageCount, first_message as firstMessage, last_message as lastMessage, archived, archive_ref as archiveRef, ext_id as extId, agent, parent_sid as parentSid FROM sessions WHERE id = ?").get(id) as IndexedSessionRow | undefined;
    },

    /** 批量 getSession：一条 SQL 取全部（merged 列表用，避免 491 条逐会话查询）。 */
    getSessionBatch(sessionIds) {
      if (sessionIds.length === 0) return new Map();
      const placeholders = sessionIds.map(() => "?").join(",");
      const rows = db.prepare(
        `SELECT id, path, cwd, name, created, modified, message_count as messageCount, first_message as firstMessage, last_message as lastMessage, archived, archive_ref as archiveRef, ext_id as extId, agent, parent_sid as parentSid FROM sessions WHERE id IN (${placeholders})`,
      ).all(...sessionIds) as IndexedSessionRow[];
      return new Map(rows.map((r) => [r.id, r]));
    },

    archivedRows() {
      return (db.prepare("SELECT id, path, cwd, name, created, modified, message_count as messageCount, first_message as firstMessage, last_message as lastMessage, archived, archive_ref as archiveRef FROM sessions WHERE archived = 1 ORDER BY modified DESC").all() as IndexedSessionRow[]).map((r) => ({
        id: r.id,
        path: r.path,
        cwd: r.cwd,
        name: r.name ?? undefined,
        created: r.created,
        modified: r.modified,
        messageCount: r.messageCount,
        firstMessage: r.firstMessage,
        lastMessage: r.lastMessage,
        archived: true,
        archiveRef: r.archiveRef,
      }));
    },

    setExtArchived(id, archived) {
      return db.prepare("UPDATE sessions SET archived = ?, archive_ref = ? WHERE id = ?")
        .run(archived ? 1 : 0, archived ? EXT_ARCHIVE_REF : null, id).changes;
    },

    restoreToLive(id, path) {
      db.prepare("UPDATE sessions SET archived = 0, archive_ref = NULL, path = ? WHERE id = ?").run(path, id);
      // messages + fts stay — the restored file is byte-identical (sha256-verified on extract),
      // so search/lastMeta/stats are immediately correct; the next sync re-parses harmlessly.
    },

    removeSession(id) {
      db.prepare("DELETE FROM fts WHERE session_id = ?").run(id);
      db.prepare("DELETE FROM messages WHERE session_id = ?").run(id);
      db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    },

    removeAgentRows(agent) {
      const rows = db.prepare("SELECT id FROM sessions WHERE agent = ?").all(agent) as Array<{ id: string }>;
      for (const r of rows) impl.removeSession(r.id);
    },

    close() {
      try { db.close(); } catch { /* already closed */ }
    },
  };
  impl.ensure();
  return impl;
}

/** Reusable helpers for the archive pipeline. */
export function sessionMessages(db: DatabaseSync, sessionId: string): Array<IndexedMessage & { session_id: string }> {
  return db.prepare("SELECT session_id, entry_id as entryId, role, ts, model, provider, tool_name as toolName, text FROM messages WHERE session_id = ? ORDER BY rowid").all(sessionId) as never;
}
