/**
 * pi-session-search — file source: streaming scan/read of pi session JSONL
 * files (the fallback when no session-manager index db is available, and the
 * always-fresh path for scope="current").
 *
 * Red lines honored: no readFileSync of potentially-huge session files (only
 * the 512-byte header sniff is synchronous); everything else streams line by
 * line via readline. Scans are bounded: files are visited newest-first and
 * scanning stops once `limit` sessions have matched.
 *
 * pi session JSONL layout (one JSON per line):
 *   {"type":"session","version":3,"id":"<uuid>","cwd":"...","timestamp":"..."}
 *   {"type":"message","id":"<entryId>","timestamp":"...","message":{"role":"user","content":[...]}}
 *   {"type":"compaction",...}           ← raw entries stay in the file; we skip these
 *   {"type":"custom_message",...}, etc.  ← skipped too
 */
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_LIST = 4000; // hard cap on files visited per scan (bounded scans)

export interface SessionFileInfo {
  path: string;
  id: string;
  cwd: string;
  mtimeMs: number;
  size: number;
  firstUser: string; // first user message text (≤120 chars) as display title
}

export function sessionsRoot(ctxSessionDir?: string): string {
  return process.env.PI_CODING_AGENT_SESSION_DIR
    || ctxSessionDir
    || join(homedir(), ".pi", "agent", "sessions");
}

/** Sanitize a numeric tool parameter: non-finite input (NaN from bad LLM JSON)
 *  falls back to the default instead of poisoning LIMIT/OFFSET arithmetic. */
function num(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : def;
  return Math.max(min, Math.min(max, n));
}

/** Extract text from a pi message content (string or typed blocks). */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && typeof b === "object" && (b as { type?: string }).type === "text")
      .map((b) => String((b as { text?: string }).text ?? ""))
      .join("\n");
  }
  return "";
}

async function sniffHeader(path: string): Promise<{ id: string; cwd: string } | null> {
  // Header is the first line; a 512B read is enough for id/cwd/timestamp.
  try {
    const rs = createReadStream(path, { start: 0, end: 511 });
    return await new Promise((resolve) => {
      let got = Buffer.alloc(0);
      rs.on("data", (c: Buffer) => { got = Buffer.concat([got, c]); })
        .on("end", () => {
          rs.destroy();
          try {
            const line = got.toString("utf8").split("\n")[0];
            const h = JSON.parse(line);
            resolve(h?.type === "session" ? { id: String(h.id ?? ""), cwd: String(h.cwd ?? "") } : null);
          } catch { resolve(null); }
        })
        .on("error", () => resolve(null));
    });
  } catch {
    return null;
  }
}

/** List pi session files under root (one level of per-cwd subdirectories),
 *  newest first, bounded by MAX_LIST. Non-pi-family agents keep their own
 *  stores; this source only knows pi's own sessions dir. */
export async function listSessionFiles(root: string, ctxSessionDir?: string): Promise<SessionFileInfo[]> {
  const out: SessionFileInfo[] = [];
  const roots: string[] = [];
  if (existsSync(root)) roots.push(root);
  // The current session dir may live outside the default root (custom dir /
  // PI_CODING_AGENT_SESSION_DIR override) — merge it in when different.
  if (ctxSessionDir && existsSync(ctxSessionDir) && !roots.includes(ctxSessionDir)) roots.push(ctxSessionDir);
  const files: Array<{ path: string; mtimeMs: number }> = [];
  for (const r of roots) {
    let dirs: string[] = [];
    try {
      dirs = readdirSync(r, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(r, d.name));
    } catch { continue; }
    for (const d of dirs) {
      let entries: string[] = [];
      try { entries = readdirSync(d); } catch { continue; }
      for (const f of entries) {
        if (!f.endsWith(".jsonl")) continue;
        const p = join(d, f);
        try {
          const st = statSync(p);
          if (st.isFile()) files.push({ path: p, mtimeMs: st.mtimeMs });
        } catch { /* raced deletion */ }
        if (files.length >= MAX_LIST) break;
      }
      if (files.length >= MAX_LIST) break;
    }
    if (files.length >= MAX_LIST) break;
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const f of files) {
    const head = await sniffHeader(f.path);
    if (!head?.id) continue;
    out.push({ path: f.path, id: head.id, cwd: head.cwd, mtimeMs: f.mtimeMs, size: 0, firstUser: "" });
  }
  return out;
}

async function* iterLines(path: string): AsyncGenerator<string> {
  const rs = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input: rs, crlfDelay: Infinity });
  for await (const line of rl) yield line;
}

async function firstUserText(path: string): Promise<string> {
  for await (const line of iterLines(path)) {
    if (!line.includes('"user"')) continue;
    try {
      const e = JSON.parse(line);
      if (e?.type === "message" && e?.message?.role === "user") {
        const t = messageText(e.message.content).replace(/\s+/g, " ").trim();
        if (t) return t.slice(0, 120);
      }
    } catch { /* skip bad line */ }
  }
  return "";
}

/** Stream-scan session files for a keyword; newest first; one hit per session;
 *  stops after `limit` sessions matched. 2-char queries work (plain substring). */
export async function searchFiles(
  root: string,
  q: string,
  opts: { sessionIds?: string[]; role?: string; limit?: number; cwdPrefix?: string; ctxSessionDir?: string } = {},
): Promise<Array<SearchHitFile>> {
  const ql = (q ?? "").trim();
  if (!ql) return [];
  const limit = num(opts.limit, 8, 1, 50);
  const roleFilter = typeof opts.role === "string" && opts.role && opts.role !== "all" ? opts.role : null;
  const cwdFilter = typeof opts.cwdPrefix === "string" && opts.cwdPrefix ? opts.cwdPrefix : null;
  const refFilter = (opts.sessionIds ?? []).filter((s) => typeof s === "string" && s.length > 0);

  let files = await listSessionFiles(root, opts.ctxSessionDir);
  if (refFilter.length) {
    files = files.filter((f) =>
      refFilter.includes(f.path)
      || refFilter.includes(f.id)
      || refFilter.some((r) => f.id.startsWith(r))); // uuid prefixes
    if (!files.length) return [];
  }
  if (cwdFilter) files = files.filter((f) => f.cwd.startsWith(cwdFilter));

  const hits: SearchHitFile[] = [];
  for (const f of files) {
    let firstEntry: { entryId: string; role: string; ts: string | null; text: string } | null = null;
    for await (const line of iterLines(f.path)) {
      if (!line.includes(ql)) continue; // cheap prescreen before parse
      let e: any;
      try { e = JSON.parse(line); } catch { continue; }
      if (e?.type !== "message" || !e?.message) continue;
      const role = String(e.message.role ?? "");
      if (roleFilter && role !== roleFilter) continue;
      const text = messageText(e.message.content);
      if (!text.toLowerCase().includes(ql.toLowerCase())) continue;
      firstEntry = { entryId: String(e.id ?? ""), role, ts: e.timestamp ?? null, text };
      break; // one hit per session
    }
    if (firstEntry) {
      const idx = firstEntry.text.toLowerCase().indexOf(ql.toLowerCase());
      const start = Math.max(0, idx - 40);
      const snippet = (start > 0 ? "…" : "") + firstEntry.text.slice(start, start + 120) + (start + 120 < firstEntry.text.length ? "…" : "");
      hits.push({
        sessionId: f.id,
        path: f.path,
        cwd: f.cwd,
        mtime: new Date(f.mtimeMs).toISOString(),
        entryId: firstEntry.entryId,
        role: firstEntry.role,
        ts: firstEntry.ts,
        text: snippet,
      });
      if (hits.length >= limit) break;
    }
  }
  return hits;
}

export interface SearchHitFile {
  sessionId: string;
  path: string;
  cwd: string;
  mtime: string;
  entryId: string;
  role: string;
  ts: string | null;
  text: string;
}

/** Read one session file's messages (insertion order; tree branches all included). */
export async function readSessionFile(
  path: string,
  opts: { role?: string; limit?: number; offset?: number; maxChars?: number; entryId?: string } = {},
): Promise<{ messages: Array<MessageRowFile>; total: number } | null> {
  if (!existsSync(path)) return null;
  const limit = num(opts.limit, 20, 1, 200);
  const offset = num(opts.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const maxChars = num(opts.maxChars, 4000, 200, 20000);
  const roleFilter = typeof opts.role === "string" && opts.role && opts.role !== "all" ? opts.role : null;

  const all: MessageRowFile[] = [];
  for await (const line of iterLines(path)) {
    if (!line.includes('"message"')) continue; // cheap prescreen
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e?.type !== "message" || !e?.message) continue;
    const role = String(e.message.role ?? "");
    if (roleFilter && role !== roleFilter) continue;
    const text = messageText(e.message.content);
    all.push({ entryId: String(e.id ?? ""), role, ts: e.timestamp ?? null, text });
  }
  const filtered = opts.entryId ? all.filter((m) => m.entryId === opts.entryId) : all;
  const page = filtered.slice(offset, offset + (opts.entryId ? 1 : limit)).map((m) => {
    const truncated = m.text.length > maxChars;
    return { ...m, text: truncated ? m.text.slice(0, maxChars) + "…[truncated]" : m.text, truncated };
  });
  return { messages: page, total: filtered.length };
}

export interface MessageRowFile {
  entryId: string;
  role: string;
  ts: string | null;
  text: string;
  truncated: boolean;
}

/** Read the CURRENT session straight from the live session manager — the
 *  freshest possible source (includes everything compacted away; no disk). */
export function readCurrentEntries(ctx: any, opts: { role?: string; limit?: number; offset?: number; maxChars?: number; entryId?: string } = {}):
  { messages: Array<MessageRowFile>; total: number; sessionId: string; cwd: string } {
  const sm = ctx?.sessionManager;
  const entries = (typeof sm?.getEntries === "function" ? sm.getEntries() : []) as Array<any>;
  const limit = num(opts.limit, 20, 1, 200);
  const offset = num(opts.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const maxChars = num(opts.maxChars, 4000, 200, 20000);
  const roleFilter = typeof opts.role === "string" && opts.role && opts.role !== "all" ? opts.role : null;

  const all: MessageRowFile[] = [];
  for (const e of entries) {
    if (e?.type !== "message" || !e?.message) continue; // skip compaction/custom entries — raw text only
    const role = String(e.message.role ?? "");
    if (roleFilter && role !== roleFilter) continue;
    const text = messageText((e.message as { content?: unknown }).content);
    all.push({ entryId: String(e.id ?? ""), role, ts: e.timestamp ?? null, text });
  }
  const filtered = opts.entryId ? all.filter((m) => m.entryId === opts.entryId) : all;
  const page = filtered.slice(offset, offset + (opts.entryId ? 1 : limit)).map((m) => {
    const truncated = m.text.length > maxChars;
    return { ...m, text: truncated ? m.text.slice(0, maxChars) + "…[truncated]" : m.text, truncated };
  });
  return {
    messages: page,
    total: filtered.length,
    sessionId: typeof sm?.getSessionId === "function" ? String(sm.getSessionId()) : "",
    cwd: typeof sm?.getCwd === "function" ? String(sm.getCwd()) : "",
  };
}

/** In-memory search over the current session's entries. */
export function searchCurrent(ctx: any, q: string, opts: { role?: string; limit?: number } = {}): Array<SearchHitFile> {
  const ql = (q ?? "").trim().toLowerCase();
  if (!ql) return [];
  const limit = Math.max(1, Math.min(50, Math.floor(opts.limit ?? 8)));
  const roleFilter = typeof opts.role === "string" && opts.role && opts.role !== "all" ? opts.role : null;
  const sm = ctx?.sessionManager;
  const entries = (typeof sm?.getEntries === "function" ? sm.getEntries() : []) as Array<any>;
  const hits: SearchHitFile[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (e?.type !== "message" || !e?.message) continue;
    const role = String(e.message.role ?? "");
    if (roleFilter && role !== roleFilter) continue;
    const text = messageText((e.message as { content?: unknown }).content);
    const lower = text.toLowerCase();
    const idx = lower.indexOf(ql);
    if (idx < 0) continue;
    if (seen.has(e.id)) continue;
    seen.add(String(e.id ?? ""));
    const start = Math.max(0, idx - 40);
    const snippet = (start > 0 ? "…" : "") + text.slice(start, start + 120) + (start + 120 < text.length ? "…" : "");
    hits.push({
      sessionId: String(sm?.getSessionId?.() ?? ""),
      path: "current",
      cwd: String(sm?.getCwd?.() ?? ""),
      mtime: "",
      entryId: String(e.id ?? ""),
      role,
      ts: e.timestamp ?? null,
      text: snippet,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

/** Search reads the first-user title lazily only when needed; keep listSessionFiles
 *  cheap by not populating firstUser during the scan (sniff header only). */
export async function enrichTitles(files: SessionFileInfo[]): Promise<SessionFileInfo[]> {
  for (const f of files.slice(0, 20)) f.firstUser = await firstUserText(f.path);
  return files;
}
