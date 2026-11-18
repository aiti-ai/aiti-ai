/**
 * pi-session-search — db source: read-only queries against a pi-web
 * session-manager index (SQLite FTS5 trigram, ~20 agent families).
 *
 * The index is owned by session-manager; we NEVER write to it. The database
 * is opened readOnly with a small busy_timeout so a live pi-web writer never
 * blocks us and we never disturb it. If the file cannot be opened (missing,
 * WAL shm unavailable, ...) callers fall back to the file source.
 *
 * Candidate paths (first existing wins):
 *   $PI_SESSION_SEARCH_DB
 *   $PI_WEB_DATA_DIR/session-manager/cache/index.sqlite
 *   ~/.pi/web/data/session-manager/cache/index.sqlite      (prod)
 *   ~/.pi/web-dev/data/session-manager/cache/index.sqlite  (dev)
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DbHandle {
  path: string;
  db: InstanceType<typeof DatabaseSync>;
  /** mtime of the index file when opened — surfaced in tool output as the snapshot time. */
  snapshotMtime: string;
}

let cached: DbHandle | null = null;

export function dbCandidates(): string[] {
  const out: string[] = [];
  if (process.env.PI_SESSION_SEARCH_DB) out.push(process.env.PI_SESSION_SEARCH_DB);
  const home = homedir();
  if (process.env.PI_WEB_DATA_DIR) {
    out.push(join(process.env.PI_WEB_DATA_DIR, "session-manager", "cache", "index.sqlite"));
  }
  out.push(join(home, ".pi", "web", "data", "session-manager", "cache", "index.sqlite"));
  out.push(join(home, ".pi", "web-dev", "data", "session-manager", "cache", "index.sqlite"));
  return out;
}

const DB_OFF = new Set(["off", "0", "false", "none"]);

/** Open (and cache) the first openable candidate index. Returns null when none works.
 *  PI_SESSION_SEARCH_DB=off|0|false|none disables the db source entirely (falls back
 *  to file scans) — used to isolate tests and by users who prefer live files only. */
export function openDb(): DbHandle | null {
  if (process.env.PI_SESSION_SEARCH_DB && DB_OFF.has(process.env.PI_SESSION_SEARCH_DB.trim().toLowerCase())) return null;
  if (cached) {
    try {
      cached.db.prepare("SELECT 1").get(); // liveness probe (closed db throws)
      return cached;
    } catch {
      try { cached.db.close(); } catch { /* already closed */ }
      cached = null;
    }
  }
  for (const path of dbCandidates()) {
    if (!existsSync(path)) continue;
    try {
      const db = new DatabaseSync(path, { readOnly: true });
      try { db.exec("PRAGMA busy_timeout = 2000"); } catch { /* old node */ }
      let snapshotMtime = "";
      try { snapshotMtime = statSync(path).mtime.toISOString(); } catch { /* keep empty */ }
      cached = { path, db, snapshotMtime };
      return cached;
    } catch {
      // WAL shm unavailable / locked / corrupt → try next candidate
    }
  }
  return null;
}

/** Drop the cached handle (used by tests; also re-probes on next call). */
export function closeDb(): void {
  if (cached) {
    try { cached.db.close(); } catch { /* already closed */ }
    cached = null;
  }
}

// ── queries (same SQL shape as the session-manager side; read-only) ─────────

export function resolveRefsDb(db: DbHandle, refs: string[]): { ids: string[]; unresolved: string[] } {
  const ids = new Set<string>();
  const unresolved: string[] = [];
  const byId = db.db.prepare("SELECT id FROM sessions WHERE id = ?");
  const byPath = db.db.prepare("SELECT id FROM sessions WHERE path = ?");
  const byPrefix = db.db.prepare("SELECT id FROM sessions WHERE id LIKE ? ESCAPE '\\' LIMIT 2");
  for (const raw of refs) {
    const ref = String(raw ?? "").trim();
    if (!ref) continue;
    if (byId.get(ref)) { ids.add(ref); continue; }
    const byPathRow = byPath.get(ref) as { id: string } | undefined;
    if (byPathRow) { ids.add(byPathRow.id); continue; }
    const esc = ref.replace(/[\\%_]/g, (c) => "\\" + c);
    const hits = byPrefix.all(`${esc}%`) as Array<{ id: string }>;
    if (hits.length === 1) ids.add(hits[0].id);
    else unresolved.push(ref);
  }
  return { ids: [...ids], unresolved };
}

export interface SearchOpts {
  agents?: string[];
  sessionIds?: string[];
  role?: string;
  /** Project directory prefix filter — applied IN the SQL so LIMIT counts only
   *  matching sessions (post-filtering after LIMIT would silently drop hits). */
  cwdPrefix?: string;
  limit?: number;
}

/** Sanitize a numeric tool parameter: non-finite input (NaN from bad LLM JSON)
 *  falls back to the default instead of poisoning LIMIT/OFFSET arithmetic. */
function num(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : def;
  return Math.max(min, Math.min(max, n));
}

export interface SearchHit {
  sessionId: string;
  agent: string | null;
  title: string;
  cwd: string;
  modified: string;
  archived: boolean;
  entryId: string;
  role: string;
  ts: string | null;
  text: string;
}

export function searchSessionsDb(db: DbHandle, q: string, opts: SearchOpts = {}): SearchHit[] {
  const ql = (q ?? "").trim();
  if (!ql) return [];
  const limit = num(opts.limit, 8, 1, 50);
  const ids = (opts.sessionIds ?? []).filter((s) => typeof s === "string" && s.length > 0);
  const agents = (opts.agents ?? []).filter((s) => typeof s === "string" && s.length > 0);
  const roleFilter = typeof opts.role === "string" && opts.role ? opts.role : null;
  const cwdFilter = typeof opts.cwdPrefix === "string" && opts.cwdPrefix ? opts.cwdPrefix : null;

  const conds: string[] = [];
  const params: Array<string | number> = [];
  if (ids.length) {
    conds.push(`f.session_id IN (${ids.map(() => "?").join(",")})`);
    params.push(...ids);
  }
  if (agents.length) {
    conds.push(`s.agent IN (${agents.map(() => "?").join(",")})`);
    params.push(...agents);
  }
  if (roleFilter) {
    conds.push("f.role = ?");
    params.push(roleFilter);
  }
  if (cwdFilter) {
    conds.push("s.cwd LIKE ? ESCAPE '\\'");
    params.push(cwdFilter.replace(/[\\%_]/g, (c) => "\\" + c) + "%");
  }
  const where = conds.length ? "AND " + conds.join(" AND ") : "";

  let rows: Array<{ session_id: string; text: string; role: string; entry_id: string | null; ts: string | null }>;
  if (ql.length >= 3) {
    const safe = ql.replace(/"/g, '""');
    try {
      rows = db.db.prepare(
        `SELECT f.session_id, f.text, f.role FROM fts f
         JOIN sessions s ON s.id = f.session_id
         WHERE f.fts MATCH ? ${where}
         ORDER BY bm25(fts) LIMIT ?`,
      ).all(`"${safe}"`, ...params, limit) as typeof rows;
      const anchor = db.db.prepare("SELECT entry_id, ts FROM messages WHERE session_id = ? AND text = ? ORDER BY rowid LIMIT 1");
      for (const r of rows) {
        const m = anchor.get(r.session_id, r.text) as { entry_id: string; ts: string | null } | undefined;
        r.entry_id = m?.entry_id ?? null;
        r.ts = m?.ts ?? null;
      }
    } catch {
      rows = [];
    }
  } else {
    // short query: trigram can't match <3 chars → substring fallback on messages
    const likeConds = ["m.text LIKE ?"];
    const likeParams: Array<string | number> = [`%${ql}%`];
    if (ids.length) {
      likeConds.push(`m.session_id IN (${ids.map(() => "?").join(",")})`);
      likeParams.push(...ids);
    }
    if (roleFilter) {
      likeConds.push("m.role = ?");
      likeParams.push(roleFilter);
    }
    if (cwdFilter) {
      likeConds.push("s.cwd LIKE ? ESCAPE '\\'");
      likeParams.push(cwdFilter.replace(/[\\%_]/g, (c) => "\\" + c) + "%");
    }
    const agentJoin = agents.length ? `AND s.agent IN (${agents.map(() => "?").join(",")})` : "";
    if (agents.length) likeParams.push(...agents);
    rows = db.db.prepare(
      `SELECT m.session_id, m.entry_id, m.text, m.role, m.ts AS ts
       FROM messages m JOIN sessions s ON s.id = m.session_id
       WHERE ${likeConds.join(" AND ")} ${agentJoin}
       GROUP BY m.session_id
       ORDER BY s.modified DESC LIMIT ?`,
    ).all(...likeParams, limit) as typeof rows;
  }

  const out: SearchHit[] = [];
  const seen = new Set<string>();
  const getRow = db.db.prepare("SELECT id, agent, cwd, name, modified, archived FROM sessions WHERE id = ?");
  for (const r of rows) {
    if (seen.has(r.session_id)) continue;
    const s = getRow.get(r.session_id) as { id: string; agent: string | null; cwd: string; name: string | null; modified: string; archived: number } | undefined;
    if (!s) continue;
    seen.add(r.session_id);
    const idx = r.text.toLowerCase().indexOf(ql.toLowerCase());
    const start = Math.max(0, idx - 40);
    const snippet = (start > 0 ? "…" : "") + r.text.slice(start, start + 120) + (start + 120 < r.text.length ? "…" : "");
    out.push({
      sessionId: s.id,
      agent: s.agent ?? null,
      title: s.name ?? "",
      cwd: s.cwd,
      modified: s.modified,
      archived: s.archived === 1,
      entryId: r.entry_id ?? "",
      role: r.role,
      ts: r.ts,
      text: snippet,
    });
  }
  return out;
}

export interface MessagesOpts {
  role?: string;
  limit?: number;
  offset?: number;
  maxChars?: number;
  entryId?: string;
}

export interface MessageRow {
  entryId: string;
  role: string;
  ts: string | null;
  model: string | null;
  toolName: string | null;
  text: string;
  truncated: boolean;
}

export function sessionMessagesDb(db: DbHandle, ref: string, opts: MessagesOpts = {}):
  { row: Record<string, unknown>; messages: MessageRow[]; total: number } | null {
  const resolved = resolveRefsDb(db, [ref ?? ""]);
  if (resolved.ids.length !== 1) return null;
  const id = resolved.ids[0];
  const row = db.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) return null;

  const limit = num(opts.limit, 20, 1, 200);
  const offset = num(opts.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const maxChars = num(opts.maxChars, 4000, 200, 20000);
  const roleFilter = typeof opts.role === "string" && opts.role && opts.role !== "all" ? opts.role : null;

  const where: string[] = ["session_id = ?"];
  const params: Array<string | number> = [id];
  if (roleFilter) { where.push("role = ?"); params.push(roleFilter); }
  if (opts.entryId) { where.push("entry_id = ?"); params.push(opts.entryId); }
  const whereSql = "WHERE " + where.join(" AND ");

  const total = (db.db.prepare(`SELECT COUNT(*) AS n FROM messages ${whereSql}`).get(...params) as { n: number }).n;
  const rows = db.db.prepare(
    `SELECT entry_id, role, ts, model, tool_name, text FROM messages ${whereSql}
     ORDER BY rowid LIMIT ? OFFSET ?`,
  ).all(...params, opts.entryId ? 1 : limit, opts.entryId ? 0 : offset) as
    Array<{ entry_id: string; role: string; ts: string | null; model: string | null; tool_name: string | null; text: string }>;

  const messages: MessageRow[] = rows.map((r) => {
    const truncated = r.text.length > maxChars;
    return {
      entryId: r.entry_id,
      role: r.role,
      ts: r.ts,
      model: r.model,
      toolName: r.tool_name,
      text: truncated ? r.text.slice(0, maxChars) + "…[truncated]" : r.text,
      truncated,
    };
  });
  return { row, messages, total };
}
