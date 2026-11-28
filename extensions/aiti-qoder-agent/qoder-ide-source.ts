/**
 * Qoder CN IDE — session-agent-source provider (session-manager §4.8 slot).
 *
 * The IDE backend (QoderCN.exe) keeps its whole chat history in one SQLite
 * database: %APPDATA%/QoderCN/SharedClientCache/cache/db/local.db
 * (chat_session / chat_record / chat_message, WAL mode).
 *
 * Text columns are field-encrypted by cosy/storage/database.doEncrypt, which
 * calls code.alibaba-inc.com/cosy/encrypt.AesEncryptWithBase64: AES-128-CBC,
 * IV = key, PKCS#7 padding, base64. The key is a compiled-in global string in
 * the binary (recovered 2026-11-18 from doEncrypt's load site) — not a user
 * password, no KDF. tool_result columns are plaintext JSON and pass through.
 *
 * Read-only: the IDE owns the (9GB) file and writes at any moment; WAL allows
 * concurrent readers, busy_timeout absorbs the rest. Never copy the db.
 *
 * Ops (session-manager's provider contract): manifest / list / session.
 * `list` carries `rev` (gmt_modified) so the host's per-session watermark can
 * skip unchanged sessions instead of reparsing the whole source.
 */
import { createDecipheriv } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const QODER_IDE_AGENT_ID = "qodercnide";
const AGENT_LABEL = "Qoder CN IDE";

const DECRYPT_KEY = Buffer.from("QbgzpWzN7tfe43gf");

/** Top-level user sessions; agent_sub_* rows are subagent children (parent_session_id set). */
const TOP_LEVEL = "session_type IN ('assistant','add_user_message') AND (parent_session_id IS NULL OR parent_session_id = '')";

const INJECTED_BLOCKS = [
  /<project_instructions>[\s\S]*?<\/project_instructions>/gi,
  /<system[-_]reminder>[\s\S]*?<\/system[-_]reminder>/gi,
  /<attached_files>[\s\S]*?<\/attached_files>/gi,
  /<current_open_file>[\s\S]*?<\/current_open_file>/gi,
  /<user_info>[\s\S]*?<\/user_info>/gi,
  /<environment_details>[\s\S]*?<\/environment_details>/gi,
];

interface IndexedMessageLike {
  entryId: string;
  role: string;
  ts: string | null;
  model?: string;
  toolName?: string;
  text: string;
  tool?: {
    callID?: string;
    name: string;
    input: Record<string, unknown> | null;
    output?: string;
    isError?: boolean;
  };
}

function dbCandidates(): string[] {
  const out: string[] = [];
  if (process.env.QODERCNIDE_DB) out.push(process.env.QODERCNIDE_DB);
  const roaming = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  out.push(join(roaming, "QoderCN", "SharedClientCache", "cache", "db", "local.db"));
  out.push(join(homedir(), "AppData", "Roaming", "QoderCN", "SharedClientCache", "cache", "db", "local.db"));
  return out;
}

function dbPath(): string {
  return dbCandidates().find((p) => {
    try { return existsSync(p); } catch { return false; }
  }) ?? dbCandidates()[dbCandidates().length - 1];
}

function dbMtimeMs(base: string): number {
  let ms = 0;
  // WAL writes are invisible on the main file until checkpoint.
  for (const p of [base, `${base}-wal`]) {
    try { ms = Math.max(ms, Math.floor(statSync(p).mtimeMs)); } catch { /* absent */ }
  }
  return ms;
}

function decryptField(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  if (value.startsWith("{") || value.startsWith("[")) return value; // plaintext JSON column
  let buf: Buffer;
  try { buf = Buffer.from(value, "base64"); } catch { return ""; }
  if (!buf.length || buf.length % 16 !== 0) return "";
  try {
    const d = createDecipheriv("aes-128-cbc", DECRYPT_KEY, DECRYPT_KEY);
    return Buffer.concat([d.update(buf), d.final()]).toString("utf8");
  } catch {
    return ""; // truncated / legacy row — treat as empty, never fatal
  }
}

function stripInjected(text: string): string {
  let out = text;
  for (const re of INJECTED_BLOCKS) out = out.replace(re, "");
  return out.trim();
}

function tagBody(text: string, tag: string): string {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i").exec(text);
  return m ? m[1].trim() : "";
}

/** user row content → the real question (chat_record.question first, then <user_query>, then de-injected text). */
function userTextFromContent(raw: string, recordQuestion: string | undefined): string {
  let body = "";
  try {
    const j = JSON.parse(raw) as { content?: unknown; contents?: Array<{ type?: string; text?: unknown }> };
    if (typeof j.content === "string" && j.content.trim()) body = j.content;
    if (Array.isArray(j.contents)) {
      for (const b of j.contents) {
        if (b && b.type === "text" && typeof b.text === "string") body += "\n" + b.text;
      }
    }
  } catch {
    body = raw;
  }
  const question = (recordQuestion ?? "").trim();
  if (question) return question;
  const userQuery = tagBody(body.trim(), "user_query");
  if (userQuery) return userQuery;
  return stripInjected(body);
}

function argsTextOf(args: unknown): string {
  if (typeof args === "string") return args;
  if (args == null) return "";
  try { return JSON.stringify(args); } catch { return ""; }
}

function toolInputOf(args: unknown): Record<string, unknown> | null {
  if (args && typeof args === "object" && !Array.isArray(args)) return args as Record<string, unknown>;
  if (typeof args === "string" && args.trim()) {
    try {
      const parsed = JSON.parse(args) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* not JSON */ }
  }
  return null;
}

function modelKeyOf(j: { extra?: { modelInfo?: { model_key?: unknown } } }): string | undefined {
  const key = j.extra?.modelInfo?.model_key;
  return typeof key === "string" && key ? key : undefined;
}

/** assistant row content → text (+ structured tool when the row is a single call with no prose). */
function parseAssistant(raw: string): { text: string; tool?: IndexedMessageLike["tool"]; model?: string } | null {
  let j: {
    content?: unknown;
    contents?: Array<{ type?: string; text?: unknown }>;
    tool_calls?: Array<{ id?: unknown; function?: { name?: unknown; arguments?: unknown } }>;
    extra?: { modelInfo?: { model_key?: unknown } };
  };
  try { j = JSON.parse(raw); } catch { return null; }
  const parts: string[] = [];
  let prose = false;
  if (typeof j.content === "string" && j.content.trim()) { parts.push(j.content.trim()); prose = true; }
  if (Array.isArray(j.contents)) {
    for (const b of j.contents) {
      if (b && b.type === "text" && typeof b.text === "string" && b.text.trim()) { parts.push(b.text.trim()); prose = true; }
    }
  }
  const calls = Array.isArray(j.tool_calls) ? j.tool_calls : [];
  let tool: IndexedMessageLike["tool"];
  for (const c of calls) {
    const fn = c?.function ?? {};
    const name = typeof fn.name === "string" && fn.name ? fn.name : "tool";
    const argsText = argsTextOf(fn.arguments);
    parts.push(`🛠 ${name}${argsText ? ` ${argsText.slice(0, 400)}` : ""}`);
    if (calls.length === 1 && !prose) {
      tool = {
        ...(typeof c.id === "string" && c.id ? { callID: c.id } : {}),
        name,
        input: toolInputOf(fn.arguments),
      };
    }
  }
  const model = modelKeyOf(j);
  return { text: parts.join("\n"), ...(tool ? { tool } : {}), ...(model ? { model } : {}) };
}

function parseModelInfoColumn(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  try {
    const j = JSON.parse(raw) as { model_key?: unknown };
    return typeof j.model_key === "string" && j.model_key ? j.model_key : undefined;
  } catch {
    return undefined;
  }
}

const TOOL_RESULT_MAX = 4000;

/** tool row → toolCallId + output text (tool_result is plaintext JSON; content is encrypted). */
function toolOutputOf(contentRaw: string, toolResultRaw: unknown): { callID: string; output: string } {
  let callID = "";
  if (typeof toolResultRaw === "string" && toolResultRaw.startsWith("{")) {
    try {
      const tr = JSON.parse(toolResultRaw) as { toolCallId?: unknown; content?: unknown; results?: unknown };
      if (typeof tr.toolCallId === "string") callID = tr.toolCallId;
      if (typeof tr.content === "string" && tr.content) return { callID, output: tr.content };
      if (tr.results !== undefined) return { callID, output: JSON.stringify(tr.results) };
    } catch { /* malformed */ }
  }
  const plain = decryptField(contentRaw);
  if (!plain) return { callID, output: "" };
  try {
    const j = JSON.parse(plain) as { tool_call_id?: unknown; content?: unknown };
    if (typeof j.tool_call_id === "string") callID = callID || j.tool_call_id;
    if (typeof j.content === "string") return { callID, output: j.content };
    if (j.content !== undefined) return { callID, output: JSON.stringify(j.content) };
  } catch {
    return { callID, output: plain };
  }
  return { callID, output: "" };
}

function isoOf(ms: unknown): string | null {
  const n = typeof ms === "number" ? ms : Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function cwdFromProjectUri(uri: unknown): string {
  if (typeof uri !== "string" || !uri.trim()) return "";
  let p = uri.trim();
  if (/\.code-workspace$/i.test(p)) {
    const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    if (i > 0) p = p.slice(0, i);
  }
  return p;
}

function openDb(): DatabaseSync | null {
  const src = dbPath();
  if (!existsSync(src)) return null;
  try {
    const db = new DatabaseSync(src, { readOnly: true });
    try { db.exec("PRAGMA busy_timeout = 3000"); } catch { /* unsupported */ }
    return db;
  } catch {
    return null;
  }
}

// probe is a stat-level check plus one cheap count; cache by mtime so frequent
// host probes do not re-scan. Failures are not cached.
let probeCache: { path: string; mtimeMs: number; result: { ok: boolean; count: number; watermarkMs: number } } | null = null;

function probeInfo(): { ok: boolean; count: number; watermarkMs: number } {
  const src = dbPath();
  const mtimeMs = dbMtimeMs(src);
  if (probeCache && probeCache.path === src && probeCache.mtimeMs === mtimeMs) return probeCache.result;
  const db = openDb();
  if (!db) return { ok: false, count: 0, watermarkMs: mtimeMs };
  let count = 0;
  try {
    count = (db.prepare(`SELECT count(*) AS c FROM chat_session WHERE ${TOP_LEVEL}`).get() as { c?: number } | undefined)?.c ?? 0;
  } catch {
    return { ok: false, count: 0, watermarkMs: mtimeMs };
  } finally {
    db.close();
  }
  probeCache = { path: src, mtimeMs, result: { ok: true, count, watermarkMs: mtimeMs } };
  return probeCache.result;
}

function listSessions(): Array<{ id: string; artifactPath: string; rev?: number }> {
  const src = dbPath();
  const db = openDb();
  // Throw (not []) on read failure: the host's scoped GC uses refs to decide
  // liveness, and an empty list would delete every row of this source.
  if (!db) throw new Error(`qodercnide db unreadable: ${src}`);
  try {
    const rows = db.prepare(
      `SELECT session_id, gmt_modified FROM chat_session WHERE ${TOP_LEVEL} ORDER BY gmt_modified DESC`,
    ).all() as Array<{ session_id: string; gmt_modified?: number | null }>;
    return rows.map((r) => ({
      id: r.session_id,
      artifactPath: `${src}#session:${r.session_id}`,
      // rev = gmt_modified: the db file's mtime changes on every write, so the
      // per-session version, not stat, decides whether to re-parse.
      ...(typeof r.gmt_modified === "number" && r.gmt_modified > 0 ? { rev: r.gmt_modified } : {}),
    }));
  } catch (e) {
    throw new Error(`qodercnide db list failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    db.close();
  }
}

function parseSession(sid: string) {
  const db = openDb();
  if (!db) return null;
  try {
    const sess = db.prepare(
      `SELECT session_title, project_uri, gmt_create, gmt_modified
         FROM chat_session
        WHERE session_id = ? AND ${TOP_LEVEL}`,
    ).get(sid) as {
      session_title?: string | null; project_uri?: string | null;
      gmt_create?: number | null; gmt_modified?: number | null;
    } | undefined;
    if (!sess) return null;

    // chat_record.question is the real user question; chat_message user rows
    // mostly carry injected context only (<project_instructions>, reminders,
    // attached files).
    const questions = new Map<string, string>();
    try {
      const recs = db.prepare("SELECT request_id, question FROM chat_record WHERE session_id = ?").all(sid) as
        Array<{ request_id: string; question?: unknown }>;
      for (const r of recs) {
        const q = decryptField(r.question).trim();
        if (q) questions.set(r.request_id, q);
      }
    } catch { /* older schema without chat_record */ }

    const rows = db.prepare(
      `SELECT id, request_id, role, content, tool_result, model_info, gmt_create
         FROM chat_message
        WHERE session_id = ?
        ORDER BY gmt_create, rowid`,
    ).all(sid) as Array<{
      id: string; request_id: string; role: string; content?: unknown; tool_result?: unknown;
      model_info?: unknown; gmt_create?: number | null;
    }>;

    const messages: IndexedMessageLike[] = [];
    const emittedQuestion = new Set<string>();
    const openTools = new Map<string, IndexedMessageLike["tool"]>();
    let firstMessage = "";
    let lastMessage = "";
    let lastModel: string | undefined;

    const push = (msg: IndexedMessageLike) => {
      messages.push(msg);
      if (!firstMessage && msg.role === "user" && msg.text) firstMessage = msg.text.slice(0, 500);
      if (msg.text) lastMessage = msg.text;
    };

    for (const row of rows) {
      const content = decryptField(row.content);

      if (row.role === "user") {
        // one question per request: the rest are attachment/continuation rows
        if (emittedQuestion.has(row.request_id)) continue;
        const text = userTextFromContent(content, questions.get(row.request_id));
        if (!text) continue;
        emittedQuestion.add(row.request_id);
        push({ entryId: row.id, role: "user", ts: isoOf(row.gmt_create), text });
        continue;
      }

      if (row.role === "assistant") {
        const parsed = parseAssistant(content);
        if (!parsed) continue;
        const model = parseModelInfoColumn(row.model_info) ?? parsed.model ?? lastModel;
        if (model) lastModel = model;
        if (!parsed.text.trim()) continue;
        push({
          entryId: row.id,
          role: "assistant",
          ts: isoOf(row.gmt_create),
          text: parsed.text,
          ...(model ? { model } : {}),
          ...(parsed.tool ? { tool: parsed.tool } : {}),
        });
        if (parsed.tool?.callID) openTools.set(parsed.tool.callID, parsed.tool);
        continue;
      }

      if (row.role === "tool") {
        const { callID, output } = toolOutputOf(content, row.tool_result);
        if (!callID || !output) continue;
        const open = openTools.get(callID);
        if (!open || open.output) continue;
        open.output = output.slice(0, TOOL_RESULT_MAX);
      }
    }

    if (!messages.length) return null;

    const name = typeof sess.session_title === "string" && sess.session_title.trim()
      ? sess.session_title.trim()
      : undefined;
    const created = isoOf(sess.gmt_create) ?? new Date().toISOString();
    const modified = isoOf(sess.gmt_modified) ?? created;
    return {
      meta: {
        path: `${dbPath()}#session:${sid}`,
        id: sid,
        cwd: cwdFromProjectUri(sess.project_uri),
        ...(name ? { name } : {}),
        created,
        modified,
        messageCount: messages.length,
        firstMessage: firstMessage || "(no messages)",
        lastMessage: lastMessage.slice(0, 2000),
        ...(lastModel ? { model: lastModel } : {}),
      },
      messages,
      files: [],
    };
  } finally {
    db.close();
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** session-manager §4.8 provider dispatch (ctx.path = ["agent-source", op]). */
export function qoderIdeSourceApi(ctx: { path: string[]; searchParams: URLSearchParams }): Response | null {
  if (ctx.path[0] !== "agent-source") return null;
  const op = ctx.path[1];
  const params = ctx.searchParams;

  if (op === "manifest") {
    const p = probeInfo();
    return json({
      agents: [{
        id: QODER_IDE_AGENT_ID,
        label: AGENT_LABEL,
        ok: p.ok,
        count: p.count,
        watermarkMs: p.watermarkMs,
      }],
    });
  }

  if (op === "list") {
    if (params.get("agent") !== QODER_IDE_AGENT_ID) return json({ error: "unknown agent" }, 404);
    return json({ sessions: listSessions() });
  }

  if (op === "session") {
    if (params.get("agent") !== QODER_IDE_AGENT_ID) return json({ error: "unknown agent" }, 404);
    const d = parseSession(params.get("sid") ?? "");
    return d ? json(d) : json({ error: "not found" }, 404);
  }

  return null;
}
