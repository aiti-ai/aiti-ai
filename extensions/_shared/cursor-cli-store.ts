/**
 * cursor-cli-store —— Cursor Agent CLI 会话存储读取器（纯函数、零依赖）。
 *
 * 权威源：pi-web-ext/_shared/cursor-cli-store.ts（改动后同步到各扩展副本）。
 * 当前副本：pi-web-ext/session-manager/lib/agents/cursor-cli-store.ts、
 *          pi-web-ext/aiti-cursor-agent/cursor-cli-store.ts
 *
 * 格式（clean-room 对齐本机数据 + xhluca/session-migrate 文档；官方私有格式，可能漂移）：
 *
 *   config root: $CURSOR_CONFIG_DIR → $XDG_CONFIG_HOME/cursor → ~/.cursor
 *   <root>/chats/<workspaceKey>/<chatId>/store.db    ← 权威 resume 存储
 *   <root>/chats/<workspaceKey>/<chatId>/meta.json   ← 廉价摘要（title/cwd/时间；title 可缺省）
 *   <root>/projects/<pathSlug>/agent-transcripts/<chatId>/<chatId>.jsonl ← 可读镜像
 *
 * store.db：blobs(id=sha256hex(data), data BLOB) + meta(key '0', hex JSON
 * {agentId, latestRootBlobId, name, createdAt ms, mode, lastUsedModel, ...})。
 * blob 图为 protobuf wire：
 *
 *   root: repeated f8 = turn 引用（f1 = system/context 引用 — 忽略）
 *   turn: f1 = agent-turn
 *   agent-turn: f1 = user 消息（f1 文本, f2 uuid, f25/f26 ts ms）；
 *               repeated f2 = steps（f1 assistant{f1 text,f2 ts}，f2 工具调用，f3 thinking 摘要）
 *
 * 读取策略：store.db 图解码优先（权威，含 🛠 工具行 / 💭 thinking 摘要）；
 * 不可解时兑底可读 JSONL 转录（解 <timestamp>/<user_query> 包装）。
 *
 * 格式回归测试：session-manager/lib/agents/cursor-cli-store.test.mjs ——
 * 自带独立 protobuf 编码器从零合成 store.db fixture 钉死本文件的 wire
 * 假设（多轮/思考/工具/fork 去重/兑底/损坏兼容）；改本文件或怀疑 cursor
 * 升级破坏格式时先跑它。
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

export interface CursorCliChatRef { sid: string; dir: string; db: string; summary: string }

/** 单个 chat 目录的更新时间（meta.updatedAtMs 优先，兑底 store.db mtime）。 */
function chatUpdatedAtMs({ db, summary }: CursorCliChatRef): number {
  try {
    const d = JSON.parse(readFileSync(summary, "utf8")) as { updatedAtMs?: number };
    if (typeof d.updatedAtMs === "number") return d.updatedAtMs;
  } catch { /* fall through */ }
  try { return statSync(db).mtimeMs; } catch { return 0; }
}

/**
 * 枚举 CLI 会话目录（跳过 meta.json 明确 hasConversation:false 的）。
 *
 * 注意：`--resume <chatId>` 在不同 cwd 下会把同 chatId 分叉到新 workspaceKey
 * 目录（CLI 按工作区隔离历史）——同 sid 多目录时只保留最近更新的那个。
 */
export function listCursorCliChats(): CursorCliChatRef[] {
  const root = cursorCliChatsRoot();
  if (!existsSync(root)) return [];
  const bySid = new Map<string, CursorCliChatRef>();
  let ws: string[] = [];
  try { ws = readdirSync(root); } catch { return []; }
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
        } catch { /* corrupt meta — 仍列出，parse 兑底 */ }
      }
      const ref: CursorCliChatRef = { sid, dir, db, summary };
      const prev = bySid.get(sid);
      if (!prev || chatUpdatedAtMs(ref) >= chatUpdatedAtMs(prev)) bySid.set(sid, ref);
    }
  }
  return [...bySid.values()];
}

// ── protobuf wire 走读（有界、防御式） ─────────────────────────────────────

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
    else break; // groups 不支持 — 防御式停走
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

/** 字段值解析：32 字节 = blob 引用；更短的可能是内联子消息。 */
function resolveBlob(blobs: Map<string, Uint8Array>, f: PbField): Uint8Array | null {
  if (!f.bytes) return null;
  if (f.bytes.length === 32) return blobs.get(hex(f.bytes)) ?? null;
  return f.bytes;
}

/** 从「{f1 text} 子消息或裸字符串」节点提取展示文本。 */
function textField(d: Uint8Array): string | null {
  for (const f of pbFields(d)) {
    if (f.no === 1 && f.wt === 2 && f.bytes) {
      const t = utf8(f.bytes);
      if (t !== null) return t;
    }
  }
  return utf8(d);
}

/** 从不透明节点收割可读 utf-8 字符串字段（工具调用）。 */
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

// ── store.db 图解码 ─────────────────────────────────────────────────────────

export interface CursorCliStoreMeta {
  agentId?: string; latestRootBlobId?: string; name?: string;
  createdAt?: number; mode?: string; lastUsedModel?: string;
}

interface StoreRead { meta: CursorCliStoreMeta; copied: string }

/** mtime 门控 tmp 快照（+wal/shm），永不锁 cursor 的活文件。0700：含会话内容。 */
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
    if (!turnRefs.length) return null; // 未知布局 → jsonl 兑底

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
              userTs = uf.varint > 1e12 ? uf.varint : null; // ms epoch 合理性
            }
          }
        } else if (f.no === 2) {
          for (const sf of pbFields(body)) {
            if (sf.wt !== 2 || !sf.bytes) continue;
            const sub = resolveBlob(blobs, sf);
            const text = sub ? textField(sub) : utf8(sf.bytes);
            if (sf.no === 1 && text) stepTexts.push(text);                        // assistant
            else if (sf.no === 3 && text) stepTexts.push("💭 " + text);           // thinking 摘要
            else if (sf.no === 2) {                                               // 工具调用（不透明）
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

// ── 可读 JSONL 转录兑底 ─────────────────────────────────────────────────────

function findTranscript(sid: string): string | null {
  const projRoot = join(cursorCliConfigRoot(), "projects");
  if (!existsSync(projRoot)) return null;
  let slugs: string[] = [];
  try { slugs = readdirSync(projRoot); } catch { return null; }
  let best: { p: string; m: number } | null = null;
  for (const slug of slugs) {
    // 同 sid 可能因 --resume 换 cwd 分叉出多份转录 —— 取 mtime 最新
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
    // 解 "<timestamp>…</timestamp>\n<user_query>\n…\n</user_query>" 包装
    const m = text.match(/<user_query>\n?([\s\S]*?)\n?<\/user_query>/);
    const clean = (m ? m[1] : text).trim();
    if (!clean) continue;
    msgs.push({ role, ts: null, text: clean });
  }
  return msgs.length ? msgs : null;
}

// ── 会话级读取 ──────────────────────────────────────────────────────────────

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

/** 读一个 CLI 会话（store.db 权威 → jsonl 兑底）。dir 缺省时按 sid 扫描。 */
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
