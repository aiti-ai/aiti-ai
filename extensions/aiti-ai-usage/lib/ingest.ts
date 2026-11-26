/**
 * aiti-ai-usage · 数据摄入
 *
 * 三路汇入（全事件驱动，零轮询）：
 *   1. 启动/手动 sync：增量扫描会话 JSONL（mtime,size 对比，幂等 PK 去重）
 *   2. 实时：server.agent.onAgentSession → subscribeEvent("message_end")
 *   3. 代理 key 日志：fs.watch tail（见 proxy-tail.ts）
 *
 * 日汇总维护：摄入后收集受影响 day 分区 → rebuildDaily(days) 重算该分区。
 */
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { UsageDb } from "./db.ts";
import { localDay } from "./db.ts";
import { scanUserText, extractUserText, looksMachinePrompt } from "./user-quotes.ts";

export interface IngestCtx {
  usage: UsageDb;
  sessionsDir: string;   // ~/.pi/agent/sessions
}

// ---------------------------------------------------------------- 异步让步 / 事务

/** 让出事件循环一轮（setImmediate 宏任务边界）。启动期全量摄入必须分批调用，
 *  否则 1GB 级 JSONL 的同步读+解析会把 HTTP 事件循环冻结数分钟（2026-09-12 事故根因）。 */
export function yieldToLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** 把一个批次包进 SQLite 写事务（BEGIN IMMEDIATE，异常回滚）。
 *  autocommit 逐条写会在慢磁盘上放大 N 倍 fsync——批量写入必须包事务。 */
export function withTx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* 事务可能已被自动回滚 */ }
    throw err;
  }
}

// ---------------------------------------------------------------- JSONL 解析

/** Tool usage row (tool_usage table; borrow plan §2.7A). ok=NULL = call recorded only (result message fills it in by key) */
export interface ToolUsageRow {
  session_id: string;
  call_id: string;
  ts: number;
  day: string;
  tool: string;
  ok: number | null;
  duration_ms: number | null;
}

/** Skill invocation row (skill_usage table) */
export interface SkillUsageRow {
  session_id: string;
  msg_id: string;
  ts: number;
  day: string;
  skill: string;
}

/** pi skill invocation discriminator: <skill name="…"> blocks embedded in user text (possibly several) */
const SKILL_BLOCK_RE = /<skill name="([^"\n]+)"[^>]*>/g;
function skillNamesIn(text: string): string[] {
  const out: string[] = [];
  SKILL_BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SKILL_BLOCK_RE.exec(text)) !== null) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

interface ParsedRow {
  session_id: string;
  ts: number;
  day: string;
  provider: string;
  model: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  reasoning: number;
  total_tokens: number;
  cost_total: number;
}

/** 用户输入消息明细行（user_msgs 表；引用扫描结果见 lib/user-quotes.ts）。 */
export interface UserMsgRow {
  msg_id: string;
  ts: number;
  day: string;
  session_id: string;
  kind: "human" | "agent" | "external";
  chars: number;
  lines: number;
  image: number;
  quote_lines: number;
  quote_head: number;
  quote_kinds: string;
}

export async function parseSessionJsonl(text: string, fallbackId: string): Promise<{
  id: string; cwd: string; title: string;
  rows: ParsedRow[]; userRows: UserMsgRow[]; toolRows: ToolUsageRow[]; skillRows: SkillUsageRow[];
  firstTs: number; lastTs: number;
}> {
  let id = fallbackId;
  let cwd = "";
  const rows: ParsedRow[] = [];
  let title = "";
  let firstTs = 0;
  let lastTs = 0;
  // 用户输入消息暂存（末尾会话上下文齐备后统一判定 kind）
  const pendingUser: Array<{ msgId: string; ts: number; text: string; image: boolean }> = [];
  // tool/skill usage rows (borrow plan §2.7A: stats collected in passing during ingest)
  const toolRows: ToolUsageRow[] = [];
  const skillRows: SkillUsageRow[] = [];
  // 会话级归因：session_info（外部导入会话 / subagent 子会话名）
  let infoName = "";
  let infoExternal = false;
  let userSeq = 0;

  const pushUser = (m: Record<string, any>, e: Record<string, any>) => {
    const { text, image } = extractUserText(m.content);
    const ts = Number(m.timestamp) || Date.parse(String(e?.timestamp ?? "")) || 0;
    const msgId = String(e?.id ?? "") || `anon:${fallbackId}:${ts}:${userSeq}`;
    pendingUser.push({ msgId, ts, text, image });
    // skill invocation: pi prepends skill content to the user message as a <skill name="…"> block (same discriminator as slash-display)
    for (const sm of skillNamesIn(text)) {
      skillRows.push({ session_id: id, msg_id: msgId, ts, day: localDay(ts), skill: sm });
    }
    userSeq++;
  };

  const pushAssistant = (m: Record<string, any>) => {
    const ts = Number(m.timestamp) || 0;
    // toolCall blocks: record the call row first (ok=NULL placeholder; the toolResult message fills ok/duration by key)
    if (Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c?.type === "toolCall" && c.toolName) {
          toolRows.push({
            session_id: id, call_id: String(c.toolCallId || `anon:${ts}:${toolRows.length}`),
            ts, day: localDay(ts), tool: String(c.toolName), ok: null, duration_ms: null,
          });
        }
      }
    }
    const u = m.usage;
    if (!u || !m.model) return;
    rows.push({
      session_id: id,
      ts,
      day: localDay(ts),
      provider: String(m.provider ?? "?"),
      model: String(m.model),
      input: u.input | 0,
      output: u.output | 0,
      cache_read: u.cacheRead | 0,
      cache_write: u.cacheWrite | 0,
      reasoning: u.reasoning | 0,
      total_tokens: u.totalTokens | 0,
      cost_total: u.cost?.total ?? 0,
    });
    if (!firstTs || (ts && ts < firstTs)) firstTs = ts;
    if (ts > lastTs) lastTs = ts;
  };

  const pushToolResult = (m: Record<string, any>, e: Record<string, any>) => {
    const callId = String(m.toolCallId || "");
    if (!callId) return;
    const ts = Number(m.timestamp) || Date.parse(String(e?.timestamp ?? "")) || 0;
    toolRows.push({
      session_id: id, call_id: callId, ts, day: localDay(ts),
      tool: m.toolName ? String(m.toolName) : "",
      ok: m.isError === true ? 0 : 1,
      duration_ms: Number.isFinite(Number(m.durationMs)) ? Math.round(Number(m.durationMs)) : null,
    });
  };

  let scanned = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "session") {
      id = e.id || id;
      cwd = e.cwd || cwd;
      continue;
    }
    if (e.type === "session_info") {
      // 外部 agent 导入会话（importedFrom/external）与 subagent 子会话（name=subagent-*）
      if (e.name != null) infoName = String(e.name);
      if (e.external === true) infoExternal = true;
      continue;
    }
    if (e.type === "message") {
      const m = e.message;
      if (m?.role === "assistant") pushAssistant(m);
      else if (m?.role === "toolResult") pushToolResult(m, e);
      else if (m?.role === "user") {
        pushUser(m, e);
        if (!title) {
          const t = (m.content ?? []).find((c: any) => c.type === "text" && (c.text ?? "").trim());
          if (t) title = t.text.trim().slice(0, 80);
        }
      }
    } else if (e.type === "compaction" && Array.isArray(e.retainedTail)) {
      for (const m of e.retainedTail) if (m?.role === "assistant") pushAssistant(m);
      // 注意：retainedTail 里的 user 消息是已被 message 行记录过的历史副本（append-only 文件），
      // 统计用户输入时跳过，避免重复计数（当前 pi 版本该字段已不落盘）。
    }
    if (e.timestamp) {
      const ts = Date.parse(e.timestamp);
      if (!Number.isNaN(ts)) {
        if (!firstTs || ts < firstTs) firstTs = ts;
        if (ts > lastTs) lastTs = ts;
      }
    }
    if (++scanned % 2000 === 0) await yieldToLoop(); // 大文件行级让步（19MB jsonl 不再单次阻塞秒级）
  }

  // 用户消息 → 明细行（kind 判定：导入会话 > subagent 会话 > 机器模板首条 > 人类）
  const kindBase: UserMsgRow["kind"] | null = infoExternal
    ? "external"
    : /^subagent-/.test(infoName) ? "agent" : null;
  const userRows: UserMsgRow[] = pendingUser.map((u, i) => {
    const st = scanUserText(u.text);
    const kind = kindBase ?? (i === 0 && looksMachinePrompt(u.text) ? "agent" : "human");
    return {
      msg_id: u.msgId,
      ts: u.ts,
      day: localDay(u.ts),
      session_id: id,
      kind,
      chars: st.chars,
      lines: st.lines,
      image: u.image ? 1 : 0,
      quote_lines: st.quoteLines,
      quote_head: st.quoteHead ? 1 : 0,
      quote_kinds: st.kinds.join(","),
    };
  });
  return { id, cwd, title, rows, userRows, toolRows, skillRows, firstTs, lastTs };
}

// ---------------------------------------------------------------- 写入 + 汇总

const dirtyDays = new Set<string>();
/** 标记某天汇总需要重算（实时摄入路径调用；flushDaily 消费）。 */
export function noteDirtyDay(day: string): void {
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) dirtyDays.add(day);
}

export function insertMsgRows(usage: UsageDb, rows: ParsedRow[]): void {
  // 注意：调用方批量场景（sync）必须自行包事务，见 withTx。
  if (rows.length === 0) return;
  const ins = usage.db.prepare(`
    INSERT OR IGNORE INTO msg_usage
      (session_id, ts, day, provider, model, input, output, cache_read, cache_write, reasoning, total_tokens, cost_total)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const r of rows) {
    ins.run(r.session_id, r.ts, r.day, r.provider, r.model,
      r.input, r.output, r.cache_read, r.cache_write, r.reasoning, r.total_tokens, r.cost_total);
    dirtyDays.add(r.day);
  }
}

/**
 * 写入用户输入消息明细（幂等：PK=(msg_id, ts)，fork 副本自动去重）。
 * 冲突时只刷新扫描字段（kind/chars/引用特征）而不动 session_id/day——保持首写会话归属与时间。
 * 实时摄入不可用（user message_end 无 id），本表只由会话文件扫描（启动/手动 Rescan/归档）维护。
 */
export function insertUserRows(usage: UsageDb, rows: UserMsgRow[]): void {
  if (rows.length === 0) return;
  const ins = usage.db.prepare(`
    INSERT INTO user_msgs
      (msg_id, ts, day, session_id, kind, chars, lines, image, quote_lines, quote_head, quote_kinds)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(msg_id, ts) DO UPDATE SET
      kind=excluded.kind, chars=excluded.chars, lines=excluded.lines, image=excluded.image,
      quote_lines=excluded.quote_lines, quote_head=excluded.quote_head, quote_kinds=excluded.quote_kinds`);
  for (const r of rows) {
    ins.run(r.msg_id, r.ts, r.day, r.session_id, r.kind, r.chars, r.lines, r.image,
      r.quote_lines, r.quote_head, r.quote_kinds);
  }
}

/**
 * Tool usage rows (borrow plan §2.7A): PK=(session_id, call_id), safe under replay.
 * call rows (ok=NULL) land first; the toolResult message UPSERTs the same key and only fills
 * ok/duration/tool — repeated rescans overwrite with identical values, never inflating counts.
 */
export function insertToolRows(usage: UsageDb, rows: ToolUsageRow[]): void {
  if (rows.length === 0) return;
  const ins = usage.db.prepare(`
    INSERT INTO tool_usage (session_id, call_id, ts, day, tool, ok, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, call_id) DO UPDATE SET
      ok=COALESCE(excluded.ok, tool_usage.ok),
      duration_ms=COALESCE(excluded.duration_ms, tool_usage.duration_ms),
      tool=CASE WHEN excluded.tool != '' THEN excluded.tool ELSE tool_usage.tool END`);
  for (const r of rows) {
    ins.run(r.session_id, r.call_id, r.ts, r.day, r.tool, r.ok, r.duration_ms);
  }
}

/** Skill invocations: PK=(session_id, msg_id, skill), idempotent. */
export function insertSkillRows(usage: UsageDb, rows: SkillUsageRow[]): void {
  if (rows.length === 0) return;
  const ins = usage.db.prepare(`
    INSERT OR IGNORE INTO skill_usage (session_id, msg_id, ts, day, skill)
    VALUES (?, ?, ?, ?, ?)`);
  for (const r of rows) {
    ins.run(r.session_id, r.msg_id, r.ts, r.day, r.skill);
  }
}

/** Live toolCall blocks (from message_end assistant events): call rows only; file scans fill in results. */
export function recordLiveToolCalls(usage: UsageDb, sessionId: string, msg: Record<string, any>): void {
  if (!Array.isArray(msg.content)) return;
  const ts = Number(msg.timestamp) || Date.now();
  const day = localDay(ts);
  const rows: ToolUsageRow[] = [];
  for (const c of msg.content) {
    if (c?.type === "toolCall" && c.toolName) {
      rows.push({
        session_id: sessionId, call_id: String(c.toolCallId || `anon:${ts}:${rows.length}`),
        ts, day, tool: String(c.toolName), ok: null, duration_ms: null,
      });
    }
  }
  if (rows.length) {
    withTx(usage.db, () => insertToolRows(usage, rows));
  }
}

/** 实时单条（message_end 事件）：幂等写明细 + 刷新会话聚合。 */
export function ingestLiveMessage(usage: UsageDb, sessionId: string, msg: Record<string, any>): void {
  const u = msg.usage;
  if (!u || !msg.model) return;
  const ts = Number(msg.timestamp) || Date.now();
  insertMsgRows(usage, [{
    session_id: sessionId,
    ts,
    day: localDay(ts),
    provider: String(msg.provider ?? "?"),
    model: String(msg.model),
    input: u.input | 0,
    output: u.output | 0,
    cache_read: u.cacheRead | 0,
    cache_write: u.cacheWrite | 0,
    reasoning: u.reasoning | 0,
    total_tokens: u.totalTokens | 0,
    cost_total: u.cost?.total ?? 0,
  }]);
  refreshSessionAggregates(usage, [sessionId]);
}

/** 从 msg_usage 重算会话聚合行。 */
export function refreshSessionAggregates(usage: UsageDb, sessionIds: string[]): void {
  const q = usage.db.prepare(`
    SELECT COUNT(*) n, COALESCE(SUM(total_tokens),0) t, COALESCE(SUM(cost_total),0) c,
           MIN(ts) firstMsg, MAX(ts) lastMsg FROM msg_usage WHERE session_id = ?`);
  const up = usage.db.prepare(`
    UPDATE sessions SET msgs=?, total_tokens=?, cost_total=?, started_at=COALESCE(started_at,?),
      last_ts=CASE WHEN ? > last_ts THEN ? ELSE last_ts END
    WHERE id=?`);
  for (const sid of sessionIds) {
    const a = q.get(sid) as any;
    up.run(a.n, a.t, a.c, a.firstMsg, a.lastMsg, a.lastMsg, sid);
  }
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** 取消待触发的 flush 定时器（shutdown/热重载时调用——否则 db close 后定时器触发会报 database is not open）。 */
export function cancelFlush(): void {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
}
/** 防抖版 flushDaily：高频实时摄入（每条 message_end / 每批 watch 行）只标记，
 *  静默 3s 后一次性重算受影响分区——避免每条消息都全分区 GROUP BY。 */
export function scheduleFlush(usage: UsageDb): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushDaily(usage).catch((e) => console.error("[aiti-ai-usage] scheduleFlush:", e));
  }, 3000);
  (flushTimer as any).unref?.(); // 不阻进程退出
}

/** 重算受影响 day 的两个日汇总分区。异步分批：每 20 天一个事务 + 让出事件循环。 */
export async function flushDaily(usage: UsageDb): Promise<void> {
  // daily_model schema 迁移后的全量重算：meta 标记 → 收集全部 day，清空旧表，一次性重建
  const needRebuild = usage.db.prepare("SELECT v FROM meta WHERE k = 'daily_rebuild'").get() as any;
  if (needRebuild) {
    const days = usage.db.prepare(
      "SELECT day FROM msg_usage UNION SELECT day FROM ext_usage").all() as Array<{ day: string }>;
    usage.db.exec("DELETE FROM daily_model");
    usage.db.prepare("DELETE FROM meta WHERE k = 'daily_rebuild'").run();
    for (const d of days) dirtyDays.add(d.day);
  }
  if (dirtyDays.size === 0) return;
  const days = [...dirtyDays];
  dirtyDays.clear();
  const del1 = usage.db.prepare("DELETE FROM daily_model WHERE day = ?");
  const ins1 = usage.db.prepare(`
    INSERT INTO daily_model (day, agent, provider, model, msgs, input, output, cache_read, cache_write, reasoning, total_tokens, cost_total, credits)
    SELECT day, agent, provider, model, SUM(msgs), SUM(input), SUM(output), SUM(cache_read), SUM(cache_write), SUM(reasoning), SUM(total_tokens), SUM(cost_total), SUM(credits)
    FROM (
      SELECT day, 'pi' agent, provider, model, COUNT(*) msgs, SUM(input) input, SUM(output) output,
             SUM(cache_read) cache_read, SUM(cache_write) cache_write, SUM(reasoning) reasoning,
             SUM(total_tokens) total_tokens, SUM(cost_total) cost_total, 0 credits
      FROM msg_usage WHERE day = ? GROUP BY provider, model
      UNION ALL
      SELECT day, agent, provider, model, COUNT(*) msgs, SUM(input) input, SUM(output) output,
             SUM(cache_read) cache_read, SUM(cache_write) cache_write, SUM(reasoning) reasoning,
             SUM(total_tokens) total_tokens, SUM(cost_total) cost_total, SUM(credits) credits
      FROM ext_usage WHERE day = ? GROUP BY agent, provider, model
    ) GROUP BY day, agent, provider, model`);
  const del2 = usage.db.prepare("DELETE FROM daily_key WHERE day = ?");
  const ins2 = usage.db.prepare(`
    INSERT INTO daily_key (day, provider, key_name, model, reqs, ok, err429, input, output, cache_read, cache_write)
    SELECT day, provider, key_name, COALESCE(model,'?'), COUNT(*),
           SUM(CASE WHEN status BETWEEN 200 AND 399 THEN 1 ELSE 0 END),
           SUM(CASE WHEN status = 429 THEN 1 ELSE 0 END),
           COALESCE(SUM(input),0), COALESCE(SUM(output),0), COALESCE(SUM(cache_read),0), COALESCE(SUM(cache_write),0)
    FROM key_req WHERE day = ? GROUP BY provider, key_name, model`);
  const CHUNK = 20;
  for (let i = 0; i < days.length; i += CHUNK) {
    const chunk = days.slice(i, i + CHUNK);
    withTx(usage.db, () => {
      for (const d of chunk) {
        del1.run(d); ins1.run(d, d); // ins1: msg_usage.day + ext_usage.day 两个占位
        del2.run(d); ins2.run(d);
      }
    });
    if (i + CHUNK < days.length) await yieldToLoop();
  }
}

// ---------------------------------------------------------------- 会话文件同步

function collectJsonlFiles(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectJsonlFiles(p, out);
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

/** 分批重算会话聚合行（每 CHUNK 个会话一个事务 + 让步）。 */
export async function refreshSessionAggregatesAsync(usage: UsageDb, sessionIds: string[], chunk = 200): Promise<void> {
  const q = usage.db.prepare(`
    SELECT COUNT(*) n, COALESCE(SUM(total_tokens),0) t, COALESCE(SUM(cost_total),0) c,
           MIN(ts) firstMsg, MAX(ts) lastMsg FROM msg_usage WHERE session_id = ?`);
  const up = usage.db.prepare(`
    UPDATE sessions SET msgs=?, total_tokens=?, cost_total=?, started_at=COALESCE(started_at,?),
      last_ts=CASE WHEN ? > last_ts THEN ? ELSE last_ts END
    WHERE id=?`);
  for (let i = 0; i < sessionIds.length; i += chunk) {
    const slice = sessionIds.slice(i, i + chunk);
    withTx(usage.db, () => {
      for (const sid of slice) {
        const a = q.get(sid) as any;
        up.run(a.n, a.t, a.c, a.firstMsg, a.lastMsg, a.lastMsg, sid);
      }
    });
    if (i + chunk < sessionIds.length) await yieldToLoop();
  }
}

/** user_msgs 全量重扫标记：db.ensure() 在老库升级（表新建）时写入，
 *  sync 链读它 → force 忽略文件水位跑一轮全量 → 完成后 clearUserMsgsRebuild 删除。 */
export function userMsgsRebuildPending(db: DatabaseSync): boolean {
  try { return !!db.prepare("SELECT 1 x FROM meta WHERE k = 'user_msgs_rebuild'").get(); }
  catch { return false; }
}
export function clearUserMsgsRebuild(db: DatabaseSync): void {
  try { db.prepare("DELETE FROM meta WHERE k = 'user_msgs_rebuild'").run(); } catch { /* noop */ }
}

/** 增量同步活跃会话目录（异步分批：每文件一个写事务 + 让出事件循环一轮）。
 *  opts.force=true（user_msgs 重建标记）时忽略 mtime/size 水位，逐文件重新解析。
 *  返回处理的文件数。启动期全量 1GB 级数据时不再冻结主线程（2026-09-12 修复）。 */
export async function syncLiveSessions(ctx: IngestCtx, opts: { force?: boolean } = {}): Promise<number> {
  const { usage } = ctx;
  const db = usage.db;
  let changed = 0;
  const touchedSessions = new Set<string>();
  const files = collectJsonlFiles(ctx.sessionsDir); // 目录快照，同步遍历毫秒级
  const prevStmt = db.prepare("SELECT session_id, mtime_ms, size FROM files WHERE path = ?");
  for (const file of files) {
    let st: fs.Stats;
    try { st = fs.statSync(file); } catch { continue; }
    const prev = prevStmt.get(file) as any;
    if (!opts.force && prev && prev.mtime_ms === Math.round(st.mtimeMs) && prev.size === st.size) continue;

    let text: string;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    const parsed = await parseSessionJsonl(text, path.basename(file, ".jsonl"));
    withTx(db, () => {
      if (prev && prev.session_id !== parsed.id) {
        db.prepare("DELETE FROM msg_usage WHERE session_id = ?").run(prev.session_id);
        db.prepare("DELETE FROM sessions WHERE id = ?").run(prev.session_id);
        // user_msgs 不删：键是 (msg_id, ts) 与 session 无关，消息是「用户确实写过」的行为记录，
        // 文件改名/重建不应抹掉历史输入统计。
      }
      insertMsgRows(usage, parsed.rows);
      insertUserRows(usage, parsed.userRows);
      insertToolRows(usage, parsed.toolRows);
      insertSkillRows(usage, parsed.skillRows);
      // 会话行：保留实时状态字段（state），只覆盖内容字段
      db.prepare(`
        INSERT INTO sessions (id, cwd, title, started_at, last_ts, msgs, total_tokens, cost_total, archived, state, source_file)
        VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, COALESCE((SELECT state FROM sessions WHERE id=?),'active'), ?)
        ON CONFLICT(id) DO UPDATE SET
          cwd=excluded.cwd, title=CASE WHEN excluded.title != '' THEN excluded.title ELSE sessions.title END,
          source_file=excluded.source_file`).run(
        parsed.id, parsed.cwd, parsed.title, parsed.firstTs || null, parsed.lastTs || null, parsed.id, file);
      db.prepare(`INSERT INTO files (path, session_id, mtime_ms, size) VALUES (?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET session_id=excluded.session_id, mtime_ms=excluded.mtime_ms, size=excluded.size`)
        .run(file, parsed.id, Math.round(st.mtimeMs), st.size);
    });
    touchedSessions.add(parsed.id);
    changed++;
    await yieldToLoop(); // 每文件让步：单文件最长阻塞 = 该文件 read+parse（大文件 ~0.5s），其余请求不排队
  }
  // 归档后原文件消失 → files 表清条目（数据由归档扫描接管）
  const gone: string[] = [];
  for (const f of db.prepare("SELECT path FROM files").all() as Array<{ path: string }>) {
    if (!fs.existsSync(f.path)) gone.push(f.path);
  }
  if (gone.length) {
    withTx(db, () => {
      const del = db.prepare("DELETE FROM files WHERE path = ?");
      for (const p of gone) del.run(p);
    });
  }
  await refreshSessionAggregatesAsync(usage, [...touchedSessions]);
  return changed;
}
