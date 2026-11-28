/**
 * cursor-cli-store — Cursor Agent CLI session store reader (pure functions, zero deps).
 *
 * Authority: pi-web-ext/_shared/cursor-cli-store.ts (sync copies after changes).
 * Current copies: pi-web-ext/session-manager/lib/agents/cursor-cli-store.ts,
 *                 pi-web-ext/aiti-cursor-agent/cursor-cli-store.ts
 *
 * Format (clean-room aligned against local data + the xhluca/session-migrate docs;
 * official private format, may drift):
 *
 *   config root: $CURSOR_CONFIG_DIR → $XDG_CONFIG_HOME/cursor → ~/.cursor
 *   <root>/chats/<workspaceKey>/<chatId>/store.db    ← authoritative resume store
 *   <root>/chats/<workspaceKey>/<chatId>/meta.json   ← cheap summary (title/cwd/times; title optional)
 *   <root>/projects/<pathSlug>/agent-transcripts/<chatId>/<chatId>.jsonl ← readable mirror
 *
 * store.db: blobs(id=sha256hex(data), data BLOB) + meta(key '0', hex JSON
 * {agentId, latestRootBlobId, name, createdAt ms, mode, lastUsedModel, ...}).
 * The blob graph is protobuf wire format:
 *
 *   root: repeated f8 = turn refs (f1 = system/context refs — ignored)
 *   turn: f1 = agent-turn
 *   agent-turn: f1 = user message (f1 text, f2 uuid, f25/f26 ts ms);
 *               repeated f2 = steps (f1 assistant{f1 text, f2 ts}, f2 tool call, f3 thinking summary)
 *
 * Read strategy: store.db graph decoding first (authoritative, includes 🛠 tool lines /
 * 💭 thinking summaries); when undecodable, fall back to the readable JSONL transcript
 * (unwrapping <timestamp>/<user_query> wrappers).
 *
 * Format regression test: session-manager/lib/agents/cursor-cli-store.test.mjs —
 * it synthesizes a store.db fixture from scratch with its own protobuf encoder to pin this
 * file's wire assumptions (multi-turn/thinking/tools/fork dedupe/fallback/corruption
 * tolerance); run it first when changing this file or suspecting a cursor upgrade broke
 * the format.
 */
import { existsSync, mkdirSync, copyFileSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const CACHE = () => join("/tmp", "sm-cursor-cache");

export function cursorCliConfigRoot(): string {
  const env = process.env.CURSOR_CONFIG_DIR;
  if (env) return env;
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, "cursor");
  return join(homedir(), ".cursor");
}

export function cursorCliChatsRoot(): string {
  return join(cursorCliConfigRoot(), "chats");
}

/**
 * ACP-hosted sessions (`cursor-agent acp`): one directory per session and the same
 * store.db layout (blobs sha256-addressed + meta key '0' hex JSON), only without the
 * `<workspaceKey>` level that chat-mode writes. Written by the ACP server alone.
 *
 * The two stores are disjoint namespaces for loading (ACP `session/load` rejects a
 * chat-mode id with "Session not found"), but not for resuming: `cursor agent
 * --resume <acp-sid>` accepts an ACP id and writes a *continuation-only* copy under
 * chats/ — see the dedupe rule in listCursorCliChats().
 */
export function cursorCliAcpSessionsRoot(): string {
  return join(cursorCliConfigRoot(), "acp-sessions");
}

export interface CursorCliChatRef {
  sid: string;
  dir: string;
  db: string;
  summary: string;
  /** Which root this copy came from; absent on refs built before ACP support. */
  kind?: "chats" | "acp";
}

/** Last-updated time of a single chat directory (meta.updatedAtMs first, store.db mtime fallback). */
function chatUpdatedAtMs({ db, summary }: CursorCliChatRef): number {
  try {
    const d = JSON.parse(readFileSync(summary, "utf8")) as { updatedAtMs?: number };
    if (typeof d.updatedAtMs === "number") return d.updatedAtMs;
  } catch { /* fall through */ }
  try { return statSync(db).mtimeMs; } catch { return 0; }
}

/**
 * Enumerate CLI sessions across both roots (chat mode and ACP), skipping entries that
 * meta.json marks `hasConversation:false`.
 *
 * Note: `--resume <chatId>` forks the same chat under a new workspaceKey when the cwd
 * differs (the CLI isolates history per workspace) — one ref per sid, newest wins.
 *
 * The ACP copy wins over the chats copy (measured 2026-11-26): `cursor agent --resume
 * <acp-sid>` accepts an ACP session id and writes a copy under chats/ that holds ONLY
 * the continued turns, so newest-first would silently halve the history. The reverse
 * does not happen (ACP rejects a chat-mode id: session/load → not found), so "prefer
 * ACP when present" is monotonic and safe.
 */
export function listCursorCliChats(): CursorCliChatRef[] {
  const bySid = new Map<string, CursorCliChatRef>();
  const better = (a: CursorCliChatRef, b: CursorCliChatRef): boolean => {
    if (a.kind === "acp" && b.kind !== "acp") return true;
    if (a.kind !== "acp" && b.kind === "acp") return false;
    return chatUpdatedAtMs(a) >= chatUpdatedAtMs(b);
  };
  const add = (ref: CursorCliChatRef): void => {
    const prev = bySid.get(ref.sid);
    if (!prev || better(ref, prev)) bySid.set(ref.sid, ref);
  };

  const root = cursorCliChatsRoot();
  let ws: string[] = [];
  try { ws = readdirSync(root); } catch { ws = []; }
  for (const w of ws) {
    const wd = join(root, w);
    try { if (!statSync(wd).isDirectory()) continue; } catch { continue; }
    let sids: string[] = [];
    try { sids = readdirSync(wd); } catch { continue; }
    for (const sid of sids) {
      const dir = join(wd, sid);
      try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
      const db = join(dir, "store.db");
      const summary = join(dir, "meta.json");
      if (!existsSync(db) && !existsSync(summary)) continue;
      if (existsSync(summary)) {
        try {
          const d = JSON.parse(readFileSync(summary, "utf8")) as { hasConversation?: boolean };
          if (d.hasConversation === false) continue;
        } catch { /* corrupt meta — still listed, parse falls back */ }
      }
      add({ sid, dir, db, summary, kind: "chats" });
    }
  }

  // ACP sessions: one directory per session, no workspaceKey level. A session gets its
  // store.db only once a turn writes something — an abandoned handshake / session/new
  // leaves just meta.json behind, which is exactly what the size check drops.
  const acpRoot = cursorCliAcpSessionsRoot();
  let acpDirs: string[] = [];
  try { acpDirs = readdirSync(acpRoot); } catch { acpDirs = []; }
  for (const sid of acpDirs) {
    const dir = join(acpRoot, sid);
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
    const db = join(dir, "store.db");
    let size = 0;
    try { size = statSync(db).size; } catch { continue; }
    if (size === 0) continue;
    add({ sid, dir, db, summary: join(dir, "meta.json"), kind: "acp" });
  }

  return [...bySid.values()];
}

// ── protobuf wire walk (bounded, defensive) ─────────────────────────────────────

interface PbField { no: number; wt: number; varint?: number; bytes?: Uint8Array }

function readVarint(d: Uint8Array, i: number): { v: number; i: number } | null {
  let v = 0, shift = 0;
  for (;;) {
    if (i >= d.length || shift > 63) return null;
    const b = d[i++]!;
    v += (b & 0x7f) * 2 ** shift;
    shift += 7;
    if (!(b & 0x80)) return { v, i };
  }
}

function pbFields(d: Uint8Array): PbField[] {
  const out: PbField[] = [];
  let i = 0;
  while (i < d.length) {
    const key = readVarint(d, i);
    if (!key) break;
    i = key.i;
    const no = Math.floor(key.v / 8), wt = key.v % 8;
    if (wt === 0) {
      const v = readVarint(d, i);
      if (!v) break;
      i = v.i;
      out.push({ no, wt, varint: v.v });
    } else if (wt === 2) {
      const len = readVarint(d, i);
      if (!len) break;
      const start = len.i;
      if (start + len.v > d.length) break;
      out.push({ no, wt, bytes: d.subarray(start, start + len.v) });
      i = start + len.v;
    } else if (wt === 1) { out.push({ no, wt, bytes: d.subarray(i, i + 8) }); i += 8; }
    else if (wt === 5) { out.push({ no, wt, bytes: d.subarray(i, i + 4) }); i += 4; }
    else break; // groups unsupported — defensive stop
  }
  return out;
}

function utf8(d: Uint8Array): string | null {
  try {
    const s = new TextDecoder("utf-8", { fatal: true }).decode(d);
    // eslint-disable-next-line no-control-regex
    return /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s) ? null : s;
  } catch { return null; }
}

const hex = (d: Uint8Array): string => Buffer.from(d).toString("hex");

/** Field value resolution: 32 bytes = blob ref; shorter may be an inline sub-message. */
function resolveBlob(blobs: Map<string, Uint8Array>, f: PbField): Uint8Array | null {
  if (!f.bytes) return null;
  if (f.bytes.length === 32) return blobs.get(hex(f.bytes)) ?? null;
  return f.bytes;
}

/** Extract display text from a "{f1 text} sub-message or bare string" node. */
function textField(d: Uint8Array): string | null {
  for (const f of pbFields(d)) {
    if (f.no === 1 && f.wt === 2 && f.bytes) {
      const t = utf8(f.bytes);
      if (t !== null) return t;
    }
  }
  return utf8(d);
}

/** Harvest readable utf-8 string fields from an opaque node (tool calls). */
function harvestTexts(d: Uint8Array, depth = 0): string[] {
  const out: string[] = [];
  if (depth > 6) return out;
  for (const f of pbFields(d)) {
    if (f.wt !== 2 || !f.bytes || f.bytes.length === 32) continue;
    const t = utf8(f.bytes);
    if (t !== null && t.trim()) out.push(t.trim());
    else out.push(...harvestTexts(f.bytes, depth + 1));
  }
  return out;
}

// ── store.db graph decoding ─────────────────────────────────────────────────────────

export interface CursorCliStoreMeta {
  agentId?: string; latestRootBlobId?: string; name?: string;
  createdAt?: number; mode?: string; lastUsedModel?: string;
}

interface StoreRead { meta: CursorCliStoreMeta; copied: string }

/** mtime-gated tmp snapshot (+wal/shm); never locks cursor's live files. 0700: holds session content. */
function snapshotDb(src: string): string | null {
  try {
    mkdirSync(CACHE(), { recursive: true, mode: 0o700 });
    const dst = join(CACHE(), src.replace(/[/\\]/g, "_"));
    let st: { mtimeMs: number };
    try { st = statSync(src); } catch { return null; }
    try {
      if (statSync(dst).mtimeMs >= st.mtimeMs) return dst;
    } catch { /* first copy */ }
    copyFileSync(src, dst);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(src + suffix)) copyFileSync(src + suffix, dst + suffix);
      else { try { unlinkSync(dst + suffix); } catch { /* absent */ } }
    }
    return dst;
  } catch {
    return null;
  }
}

function readStoreMeta(dbPath: string): StoreRead | null {
  const copied = snapshotDb(dbPath);
  if (!copied) return null;
  try {
    const db = new DatabaseSync(copied, { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM meta WHERE key = '0'").get() as { value: string | Uint8Array } | undefined;
      if (!row?.value) return null;
      const raw = typeof row.value === "string" ? row.value : Buffer.from(row.value).toString("ascii");
      return { meta: JSON.parse(Buffer.from(raw, "hex").toString("utf8")) as CursorCliStoreMeta, copied };
    } finally { db.close(); }
  } catch { return null; }
}

export interface CursorCliMessage { role: "user" | "assistant"; ts: string | null; text: string }

function decodeStoreGraph(copied: string, rootId: string): CursorCliMessage[] | null {
  let db: DatabaseSync;
  try { db = new DatabaseSync(copied, { readOnly: true }); } catch { return null; }
  try {
    const blobs = new Map<string, Uint8Array>();
    for (const r of db.prepare("SELECT id, data FROM blobs").all() as Array<{ id: string; data: Uint8Array }>) {
      blobs.set(r.id, r.data);
    }
    const root = blobs.get(rootId);
    if (!root) return null;
    const turnRefs = pbFields(root).filter((f) => f.no === 8 && f.wt === 2);
    if (!turnRefs.length) return null; // unknown layout → jsonl fallback

    const msgs: CursorCliMessage[] = [];
    for (const tr of turnRefs) {
      const turn = resolveBlob(blobs, tr);
      if (!turn) continue;
      const atRef = pbFields(turn).find((f) => f.no === 1 && f.wt === 2);
      if (!atRef) continue;
      const at = resolveBlob(blobs, atRef);
      if (!at) continue;

      let userText = "", userTs: number | null = null;
      const stepTexts: string[] = [];
      for (const f of pbFields(at)) {
        if (f.wt !== 2) continue;
        const body = resolveBlob(blobs, f);
        if (!body) continue;
        if (f.no === 1) {
          for (const uf of pbFields(body)) {
            if (uf.no === 1 && uf.wt === 2 && uf.bytes && !userText) {
              const t = utf8(uf.bytes);
              if (t !== null) userText = t;
            } else if ((uf.no === 25 || uf.no === 26) && uf.varint && !userTs) {
              userTs = uf.varint > 1e12 ? uf.varint : null; // ms epoch sanity
            }
          }
        } else if (f.no === 2) {
          for (const sf of pbFields(body)) {
            if (sf.wt !== 2 || !sf.bytes) continue;
            const sub = resolveBlob(blobs, sf);
            const text = sub ? textField(sub) : utf8(sf.bytes);
            if (sf.no === 1 && text) stepTexts.push(text);                        // assistant
            else if (sf.no === 3 && text) stepTexts.push("💭 " + text);           // thinking summary
            else if (sf.no === 2) {                                               // tool call (opaque)
              const parts = sub ? harvestTexts(sub) : [];
              stepTexts.push("🛠 " + (parts.join(" ").slice(0, 300) || "(tool call)"));
            }
          }
        }
      }
      if (userText.trim()) msgs.push({ role: "user", ts: userTs ? new Date(userTs).toISOString() : null, text: userText });
      const aText = stepTexts.join("\n").trim();
      if (aText) msgs.push({ role: "assistant", ts: null, text: aText });
    }
    return msgs.length ? msgs : null;
  } finally { db.close(); }
}

// ── readable JSONL transcript fallback ─────────────────────────────────────────────────────

function findTranscript(sid: string): string | null {
  const projRoot = join(cursorCliConfigRoot(), "projects");
  if (!existsSync(projRoot)) return null;
  let slugs: string[] = [];
  try { slugs = readdirSync(projRoot); } catch { return null; }
  let best: { p: string; m: number } | null = null;
  for (const slug of slugs) {
    // The same sid may have multiple transcripts forked by --resume cwd switches — take the newest mtime
    const p = join(projRoot, slug, "agent-transcripts", sid, `${sid}.jsonl`);
    if (!existsSync(p)) continue;
    try {
      const m = statSync(p).mtimeMs;
      if (!best || m > best.m) best = { p, m };
    } catch { /* raced */ }
  }
  return best?.p ?? null;
}

function decodeTranscript(path: string): CursorCliMessage[] | null {
  let raw = "";
  try { raw = readFileSync(path, "utf8"); } catch { return null; }
  const msgs: CursorCliMessage[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e: { role?: string; message?: { content?: unknown } };
    try { e = JSON.parse(line) as typeof e; } catch { continue; }
    const role = e.role === "assistant" ? "assistant" : "user";
    const content = e.message?.content;
    const text = Array.isArray(content)
      ? content.filter((c) => c && typeof c === "object" && (c as { type?: string }).type === "text")
        .map((c) => (c as { text?: string }).text ?? "").join("\n")
      : "";
    if (!text.trim()) continue;
    // Unwrap the "<timestamp>…</timestamp>\n<user_query>\n…\n</user_query>" wrapper
    const m = text.match(/<user_query>\n?([\s\S]*?)\n?<\/user_query>/);
    const clean = (m ? m[1] : text).trim();
    if (!clean) continue;
    msgs.push({ role, ts: null, text: clean });
  }
  return msgs.length ? msgs : null;
}

// ── session-level read ──────────────────────────────────────────────────────────────

export interface CursorCliSession {
  sid: string;
  dir: string;
  name?: string;
  cwd: string;
  createdMs?: number;
  updatedMs: number;
  mode?: string;
  model?: string;
  messages: CursorCliMessage[];
}

/** Read one CLI session (store.db authoritative → jsonl fallback). Scans by sid when dir is omitted. */
export function readCursorCliChat(sid: string, dir?: string): CursorCliSession | null {
  let chatDir = dir;
  if (!chatDir || !existsSync(chatDir)) {
    chatDir = listCursorCliChats().find((c) => c.sid === sid)?.dir;
    if (!chatDir) return null;
  }
  const dbPath = join(chatDir, "store.db");
  const summaryPath = join(chatDir, "meta.json");

  let summary: { title?: string; createdAtMs?: number; updatedAtMs?: number; cwd?: string } = {};
  if (existsSync(summaryPath)) {
    try { summary = JSON.parse(readFileSync(summaryPath, "utf8")) as typeof summary; } catch { /* corrupt */ }
  }

  const store = existsSync(dbPath) ? readStoreMeta(dbPath) : null;
  const msgs = store?.meta.latestRootBlobId ? decodeStoreGraph(store.copied, store.meta.latestRootBlobId) : null;
  const messages = msgs ?? (findTranscript(sid) ? decodeTranscript(findTranscript(sid)!) : null) ?? [];
  if (!messages.length) return null;

  const updatedMs = summary.updatedAtMs ?? (() => { try { return statSync(dbPath || chatDir).mtimeMs; } catch { return Date.now(); } })();
  return {
    sid,
    dir: chatDir,
    name: store?.meta.name || summary.title || undefined,
    cwd: summary.cwd ?? "",
    createdMs: store?.meta.createdAt ?? summary.createdAtMs,
    updatedMs,
    mode: store?.meta.mode,
    model: store?.meta.lastUsedModel,
    messages,
  };
}
