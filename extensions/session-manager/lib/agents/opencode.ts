/**
 * session-manager — OpenCode adapter.
 *
 * Two storage generations, both supported:
 *  - legacy (verified on this machine): JSON files under
 *      ~/.local/share/opencode/storage/
 *      session/{global|<projHash>}/ses_*.json   → meta {id,slug,title,directory,time{created,updated}}
 *      message/<sesId>/msg_*.json               → {role, model{modelID}, time}
 *      part/<msgId>/prt_*.json                  → {type:"text"|"tool"|"reasoning"|...}
 *  - modern: ~/.local/share/opencode/opencode.db (SQLite, same entities).
 *    1.18 以前观测到的 session_message 单表（data 内嵌 parts）在 1.19.5 已停写
 *    （表还在但恒空）——1.19.5 起消息写 message + part 两表（part.data 与 legacy
 *    JSON part 同形，message.data 带 role/modelID/time）。两代 SQL 形状都读，
 *    主路径 message+part，session_message 留作旧 modern 兜底。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentAdapter, ExtSessionRef, ExtSourceProbe } from "./types.ts";
import { statFreshList } from "./fresh.ts";
import type { IndexedMessage } from "../session-file.ts";
import { foldOpencodeFamilyParts, foldedPartsToMessages } from "./opencode-family.ts";

/** A03：fixture/多实例可覆盖（工厂参数注入模块变量——单进程单激活实例场景）。 */
let homeOverride: string | null = null;
const ROOT = () => homeOverride || process.env.AITI_OPENCODE_HOME || join(homedir(), ".local", "share", "opencode");

/** 旧 copyDb 快照目录（2026-09-12 起直读，无复制）——首次成功直读后清残留。 */
const LEGACY_COPY_DIR = join("/tmp", "sm-opencode-cache");
let legacyCleaned = false;
function cleanupLegacyCopyDir(): void {
  if (legacyCleaned) return;
  legacyCleaned = true;
  try { rmSync(LEGACY_COPY_DIR, { recursive: true, force: true }); } catch { /* absent */ }
}

/** readOnly 直开 modern db（WAL 并发读安全，同 zcode 直读改造 2026-09-12；失败 → null）。
 *  曾照抄 copyDb 快照且无 mtime 门控（注释声称有、实际每次 list 全量拷贝），已删。 */
function openModernDb(): DatabaseSync | null {
  const src = join(ROOT(), "opencode.db");
  if (!existsSync(src)) return null;
  try {
    const db = new DatabaseSync(src, { readOnly: true });
    try { db.exec("PRAGMA busy_timeout = 2000"); } catch { /* pragma 不支持时忽略 */ }
    return db;
  } catch {
    return null;
  }
}

interface SessionMetaJson {
  id?: string;
  slug?: string;
  title?: string;
  directory?: string;
  projectID?: string;
  time?: { created?: number; updated?: number };
}

function readJson(p: string): Record<string, unknown> | null {
  try { return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>; } catch { return null; }
}

/** Legacy layout: enumerate session files. */
function legacyList(): ExtSessionRef[] {
  const out: ExtSessionRef[] = [];
  const sessRoot = join(ROOT(), "storage", "session");
  if (!existsSync(sessRoot)) return out;
  for (const bucket of readdirSync(sessRoot)) {
    const b = join(sessRoot, bucket);
    try { if (!statSync(b).isDirectory()) continue; } catch { continue; }
    for (const f of readdirSync(b)) {
      if (f.startsWith("ses_") && f.endsWith(".json")) out.push({ sid: f.replace(/\.json$/, ""), path: join(b, f) });
    }
  }
  return out;
}

function partsForMessage(msgId: string): Array<Record<string, unknown>> {
  const dir = join(ROOT(), "storage", "part", msgId);
  if (!existsSync(dir)) return [];
  const parts: Array<{ sort: string; d: Record<string, unknown> }> = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const d = readJson(join(dir, f));
    if (d) parts.push({ sort: String(d.id ?? f), d });
  }
  parts.sort((a, b) => a.sort.localeCompare(b.sort));
  return parts.map((p) => p.d);
}

/** Flatten one legacy session into normalized messages. */
function legacyParse(ref: ExtSessionRef): ParsedResult {
  const meta = readJson(ref.path) as SessionMetaJson | null;
  if (!meta?.id) return null;
  const msgDir = join(ROOT(), "storage", "message", meta.id);
  if (!existsSync(msgDir)) return null;

  interface MsgRec { id: string; role: string; modelID?: string; created: number }
  const msgs: MsgRec[] = [];
  for (const f of readdirSync(msgDir)) {
    if (!f.endsWith(".json")) continue;
    const d = readJson(join(msgDir, f));
    if (!d || typeof d.id !== "string") continue;
    const time = (d.time ?? {}) as { created?: number };
    msgs.push({
      id: d.id,
      role: d.role === "assistant" ? "assistant" : "user",
      modelID: ((d.model as Record<string, unknown> | undefined)?.modelID) as string | undefined,
      created: typeof time.created === "number" ? time.created : 0,
    });
  }
  msgs.sort((a, b) => a.id.localeCompare(b.id));

  let firstMessage = "", lastMessage = "";
  const messages: IndexedMessage[] = [];
  let seq = 0;
  for (const m of msgs) {
    // 归纳：opencode-family 共享实现（与 zcode adapter 同一份 part 语义）
    const folded = foldOpencodeFamilyParts(partsForMessage(m.id));
    const { messages: foldedMsgs, nextSeq } = foldedPartsToMessages(folded, {
      role: m.role === "assistant" ? "assistant" : "user",
      ts: m.created ? new Date(m.created).toISOString() : null,
      model: m.role === "assistant" ? m.modelID : undefined,
      seqStart: seq,
    });
    seq = nextSeq;
    messages.push(...foldedMsgs);
    for (const fm of foldedMsgs) {
      if (!firstMessage && fm.role === "user") firstMessage = fm.text.slice(0, 500);
      lastMessage = fm.text;
    }
  }

  if (!messages.length) return null;
  const createdIso = meta.time?.created ? new Date(meta.time.created).toISOString() : new Date().toISOString();
  const updatedIso = meta.time?.updated ? new Date(meta.time.updated).toISOString() : createdIso;
  return {
    meta: {
      path: ref.path,
      id: meta.id,
      cwd: meta.directory ?? "",
      name: meta.title || meta.slug || undefined,
      created: createdIso,
      modified: updatedIso,
      messageCount: messages.length,
      firstMessage: firstMessage || "(no messages)",
      lastMessage,
    },
    messages,
  };
}

type ParsedResult = ReturnType<AgentAdapter["parse"]>;

export function createOpencodeAdapter(homeOverrideArg?: string): AgentAdapter {
  homeOverride = homeOverrideArg ?? homeOverride;
  const ROOT = () => homeOverride || process.env.AITI_OPENCODE_HOME || join(homedir(), ".local", "share", "opencode");
  // ── A03 P2：legacy 多文件真归档原语（会话 = session.json + message/<sid>/ + part/<msgId>/ 跨目录集合）──
  const collectLegacyFiles = (ref: ExtSessionRef): string[] => {
    const files: string[] = [ref.path];
    const sid = ref.sid;
    const msgDir = join(ROOT(), "storage", "message", sid);
    if (existsSync(msgDir)) {
      for (const f of readdirSync(msgDir)) {
        const mp = join(msgDir, f);
        try { if (statSync(mp).isFile()) files.push(mp); } catch { continue; }
        const partDir = join(ROOT(), "storage", "part", f.replace(/\.json$/, ""));
        if (existsSync(partDir)) {
          for (const pf of readdirSync(partDir)) {
            const pp = join(partDir, pf);
            try { if (statSync(pp).isFile()) files.push(pp); } catch { continue; }
          }
        }
      }
    }
    return files;
  };
  return {
    id: "opencode",
    label: "OpenCode",
    roots() {
      const r = ROOT();
      return existsSync(r) ? [r] : [];
    },

    probe() {
      let count = 0;
      let watermarkMs = 0;
      // legacy storage
      const refs = legacyList();
      count += refs.length;
      for (const r of refs) {
        try { watermarkMs = Math.max(watermarkMs, statSync(r.path).mtimeMs); } catch { /* raced */ }
      }
      // modern db
      const dbPath = join(ROOT(), "opencode.db");
      if (existsSync(dbPath)) {
        try { watermarkMs = Math.max(watermarkMs, statSync(dbPath).mtimeMs); } catch { /* raced */ }
        // WAL：写入先进 -wal，主文件 mtime 只在 checkpoint 时才动 —— 同 zcode 修复（probe 水位停滞 → 同步延迟不可控）
        try { watermarkMs = Math.max(watermarkMs, statSync(dbPath + "-wal").mtimeMs); } catch { /* no wal */ }
        // 库内会话计数（1.19.5 起新会话只写 db，legacy 计数不再代表全量；
        // 迁移会话两源并存时粗估允许重复——probe.count 契约即 rough estimate）
        const db = openModernDb();
        if (db) {
          try { count += db.prepare("SELECT COUNT(*) AS c FROM session").get().c; }
          catch { /* schema drift */ } finally { db.close(); }
        }
      }
      return { ok: count > 0 || existsSync(dbPath), count, watermarkMs };
    },

    listFresh() { return statFreshList(this.list()); },
    list() {
      // modern db sessions（防御式——schema 可能漂移）。直读源 db（2026-09-12 去 copyDb），
      // rev = time_updated：syncExt 按 per-session 版本水位判变。
      // 1.19.5 起新会话只写 db（legacy JSON 停写）→ 恒合并两源，db 优先去重
      // （opencode 迁移会把旧会话搬进库；legacy 文件残留时以库为准）。
      const out: ExtSessionRef[] = [];
      const seen = new Set<string>();
      const db = openModernDb();
      if (db) {
        try {
          const rows = db.prepare("SELECT id, time_updated FROM session").all() as
            Array<{ id: string; time_updated?: number | null }>;
          for (const row of rows) {
            seen.add(row.id);
            out.push({
              sid: row.id,
              path: `${join(ROOT(), "opencode.db")}#session:${row.id}`,
              ...(typeof row.time_updated === "number" && row.time_updated > 0 ? { rev: row.time_updated } : {}),
            });
          }
          cleanupLegacyCopyDir();
        } catch { /* unreadable */ } finally { db.close(); }
      }
      for (const r of legacyList()) {
        if (!seen.has(r.sid)) out.push(r);
      }
      return out;
    },

    parse(ref) {
      if (ref.path.includes("#session:")) return parseModernDb(ref);
      return legacyParse(ref);
    },

    // 仅 legacy 文件代支持真归档（modern db 本机为空、SQL 防御路径未验证——如实不支持）；
    // 多文件会话按 per-file base64 容器打包，remove 级联清 message/part 目录，putBack 原样还原。
    capabilities: { remove: true, putBack: true, granularity: "artifact" },
    snapshot(ref) {
      if (ref.path.includes("#session:")) return null; // modern 代不支持
      try {
        const files = collectLegacyFiles(ref);
        if (files.length <= 1 && !existsSync(ref.path)) return null;
        const packed = files.map((abs) => ({ abs, b64: readFileSync(abs).toString("base64") }));
        return { bytes: Buffer.from(JSON.stringify({ v: 1, kind: "opencode-legacy-files", files: packed })), layout: ref.path };
      } catch { return null; }
    },
    removeSession(ref) {
      const msgDir = join(ROOT(), "storage", "message", ref.sid);
      const partDirs = new Set<string>();
      if (existsSync(msgDir)) {
        for (const f of readdirSync(msgDir)) {
          const pd = join(ROOT(), "storage", "part", f.replace(/\.json$/, ""));
          if (existsSync(pd)) partDirs.add(pd);
        }
      }
      for (const abs of collectLegacyFiles(ref)) {
        try { rmSync(abs, { force: true }); } catch { /* 不存在=幂等 */ }
      }
      for (const pd of partDirs) {
        try { rmSync(pd, { recursive: true, force: true }); } catch { /* noop */ }
      }
      try { if (existsSync(msgDir) && !readdirSync(msgDir).length) rmSync(msgDir, { recursive: true, force: true }); } catch { /* noop */ }
    },
    putBack(_sid, snap) {
      const payload = JSON.parse(snap.bytes.toString("utf8")) as { kind?: string; files?: Array<{ abs: string; b64: string }> };
      if (payload?.kind !== "opencode-legacy-files" || !Array.isArray(payload.files)) throw new Error("unexpected opencode-legacy snapshot payload");
      for (const f of payload.files) {
        mkdirSync(dirname(f.abs), { recursive: true });
        writeFileSync(f.abs, Buffer.from(f.b64, "base64"));
      }
    },
  };
}

interface DbMessageRec { id?: string; data: string | null; timeCreated?: number | null }

/** 1.19.5+ schema：message 表（role/modelID 在 data JSON）+ part 表（data 与 legacy JSON part 同形）。 */
function dbMessagesModern(db: DatabaseSync, sid: string): DbMessageRec[] {
  return db.prepare(
    "SELECT id, data, time_created AS timeCreated FROM message WHERE session_id = ? ORDER BY time_created, id",
  ).all(sid) as DbMessageRec[];
}

/** 旧 modern schema（1.18- 观测）：session_message 单表，data 内嵌 parts。1.19.5 起恒空，留作兜底。 */
function dbMessagesInlineParts(db: DatabaseSync, sid: string): DbMessageRec[] {
  return db.prepare(
    "SELECT data FROM session_message WHERE session_id = ? ORDER BY seq",
  ).all(sid) as DbMessageRec[];
}

function parseModernDb(ref: ExtSessionRef): ParsedResult {
  const [dbPath] = ref.path.split("#");
  let db: DatabaseSync;
  try { db = new DatabaseSync(dbPath, { readOnly: true }); } catch { return null; }
  try {
    const sid = ref.sid;
    const sessRow = db.prepare("SELECT directory, title, time_created, time_updated FROM session WHERE id = ?").get(sid) as
      { directory?: string; title?: string; time_created?: number; time_updated?: number } | undefined;
    if (!sessRow) return null;
    // 主路径：message + part 两表（1.19.5+）；message 表不存在时退回 session_message 内嵌形状
    let hasMessageTable = true;
    try { db.prepare("SELECT 1 FROM message LIMIT 1").get(); } catch { hasMessageTable = false; }
    interface MsgRow { id?: string; role: "user" | "assistant"; model?: string; ts: number | null; parts: Array<Record<string, unknown>> }
    const msgRows: MsgRow[] = [];
    if (hasMessageTable) {
      for (const r of dbMessagesModern(db, sid)) {
        let role: "user" | "assistant" = "user";
        let model: string | undefined;
        let ts: number | null = r.timeCreated ?? null;
        try {
          const d = JSON.parse(r.data ?? "{}") as Record<string, unknown>;
          if (d.role === "assistant") role = "assistant";
          if (typeof d.modelID === "string") model = d.modelID;
          const t = d.time as { created?: unknown } | undefined;
          if (typeof t?.created === "number") ts = t.created;
        } catch { /* keep defaults */ }
        const prows = db.prepare("SELECT data FROM part WHERE message_id = ? ORDER BY id").all(r.id ?? "") as
          Array<{ data: string | null }>;
        const parts = prows.map((p) => { try { return JSON.parse(p.data ?? "{}") as Record<string, unknown>; } catch { return {}; } });
        msgRows.push({ id: r.id, role, model, ts, parts });
      }
    } else {
      for (const r of dbMessagesInlineParts(db, sid)) {
        if (!r.data) continue;
        let d: Record<string, unknown>;
        try { d = JSON.parse(r.data) as Record<string, unknown>; } catch { continue; }
        msgRows.push({
          role: d.role === "assistant" ? "assistant" : "user",
          parts: Array.isArray(d.parts) ? d.parts as Array<Record<string, unknown>> : [],
          ts: null,
        });
      }
    }
    let seq = 0, firstMessage = "", lastMessage = "";
    const messages: IndexedMessage[] = [];
    for (const row of msgRows) {
      const folded = foldOpencodeFamilyParts(row.parts);
      const { messages: foldedMsgs, nextSeq } = foldedPartsToMessages(folded, {
        role: row.role,
        ts: typeof row.ts === "number" && row.ts > 0 ? new Date(row.ts).toISOString() : null,
        model: row.role === "assistant" ? row.model : undefined,
        seqStart: seq,
      });
      seq = nextSeq;
      messages.push(...foldedMsgs);
      for (const fm of foldedMsgs) {
        if (!firstMessage && fm.role === "user") firstMessage = fm.text.slice(0, 500);
        lastMessage = fm.text;
      }
    }
    if (!messages.length) return null;
    return {
      meta: {
        path: ref.path,
        id: sid,
        cwd: sessRow.directory ?? "",
        name: sessRow.title || undefined,
        created: new Date(Number(sessRow.time_created ?? Date.now())).toISOString(),
        modified: new Date(Number(sessRow.time_updated ?? sessRow.time_created ?? Date.now())).toISOString(),
        messageCount: messages.length,
        firstMessage: firstMessage || "(no messages)",
        lastMessage,
      },
      messages,
    };
  } finally { db.close(); }
}
