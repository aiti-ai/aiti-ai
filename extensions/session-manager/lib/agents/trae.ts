/**
 * session-manager — Trae IDE adapter (SQLCipher pipeline).
 *
 * Storage: ~/.config/Trae/ModularData/ai-agent/database.db — SQLCipher 4
 * encrypted SQLite (verified 2026-08-24; 139 tables). The raw key is a
 * hardcoded global (identical across installs, matches public research);
 * fallback: scan the ai-agent utility process memory for x'<64hex>'.
 *
 * Pipeline: copy db(+wal/shm) to tmp → `sqlcipher` CLI decrypts into a plain
 * sqlite copy (PRAGMA key + .backup) → node:sqlite reads it. Requires the
 * `sqlcipher` binary on PATH (dependencyHint surfaces the install hint).
 *
 * Key tables: chat_session(title/project), chat_message(order/role),
 * history_v2(messages JSON: {raw_messages:[{role,content[{type:"text",text}],
 * tool_calls[{function_call}]}]}), project(absolute_path), session_project.
 */
import { existsSync, mkdirSync, statSync, copyFileSync, unlinkSync, openSync, readSync, closeSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileAsync, whichBin } from "@aiti-ai/ext-shared/exec-async";
import { DatabaseSync } from "node:sqlite";
import type { AgentAdapter, ExtSessionRef, ExtSourceProbe } from "./types.ts";
import type { IndexedMessage, ParsedSessionFile } from "../session-file.ts";

const DB = () => join(homedir(), ".config", "Trae", "ModularData", "ai-agent", "database.db");
const CACHE = () => join("/tmp", "sm-trae-cache");

/** Publicly documented Trae raw key (SQLCipher x'<hex>' form). */
export const TRAE_KNOWN_KEY = "3605f6691095a993f03d5009c918352ef5be31ae31e8f000212b81ff058da773";

function sqlcipherAvailable(): boolean {
  // 纯 fs PATH 探测（2026-09-12 execSync→async 改造：spawnSync 探针移除）
  return !!whichBin("sqlcipher");
}

/** Memory-scan fallback for the key (Linux /proc; needs same-user or root). */
export function scanTraeKey(): string | null {
  try {
    const HEX = /x'([0-9a-fA-F]{64})'/;
    for (const pidDir of readdirSafe("/proc")) {
      if (!/^\d+$/.test(pidDir)) continue;
      let cmdline = "";
      try { cmdline = readText(join("/proc", pidDir, "cmdline")); } catch { continue; }
      if (!cmdline.includes("NativeExtensionService") && !cmdline.includes("trae")) continue;
      try {
        const maps = readText(join("/proc", pidDir, "maps"));
        for (const line of maps.split("\n")) {
          if (!line.includes("r") || !line.includes("-")) continue;
          const [range] = line.split(" ");
          const [startStr, endStr] = range.split("-");
          const start = parseInt(startStr, 16);
          const end = parseInt(endStr, 16);
          if (!(end > start) || end - start > 512 * 1024 * 1024) continue;
          const fd = openSync(join("/proc", pidDir, "mem"), "rb");
          try {
            const buf = Buffer.alloc(Math.min(end - start, 64 * 1024 * 1024));
            readSync(fd, buf, 0, buf.length, start);
            const m = HEX.exec(buf.toString("latin1"));
            if (m) return m[1];
          } finally { closeSync(fd); }
        }
      } catch { /* no permission for this pid */ }
    }
  } catch { /* non-linux */ }
  return null;
}

function readdirSafe(p: string): string[] {
  try { return readdirSync(p); } catch { return []; }
}
function readText(p: string): string {
  return readFileSync(p, "utf8");
}

/** Produce a decrypted plaintext copy of the trae db (mtime-gated). */
async function decryptedCopy(key: string): Promise<string | null> {
  try {
    const src = DB();
    if (!existsSync(src)) return null;
    mkdirSync(CACHE(), { recursive: true });
    const dst = join(CACHE(), "trae-plain.sqlite");
    try {
      if (statSync(dst).mtimeMs >= statSync(src).mtimeMs) return dst;
    } catch { /* first run */ }

    const tmpEnc = join(CACHE(), "trae-enc.sqlite");
    copyFileSync(src, tmpEnc);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(src + suffix)) copyFileSync(src + suffix, tmpEnc + suffix);
      else { try { unlinkSync(tmpEnc + suffix); } catch { /* absent */ } }
    }
    // sqlcipher_export requires the target to NOT exist (tables would collide)
    try { unlinkSync(dst); } catch { /* absent */ }
    // sqlcipher: open encrypted copy → export plaintext via sqlcipher_export
    const script = `PRAGMA key = "x'${key}'";\nATTACH DATABASE '${dst}' AS plain KEY '';\nSELECT sqlcipher_export('plain');\nDETACH plain;\n`;
    await execFileAsync("sqlcipher", [tmpEnc], { input: script });
    try { unlinkSync(tmpEnc); unlinkSync(tmpEnc + "-wal"); unlinkSync(tmpEnc + "-shm"); } catch { /* best effort */ }
    return existsSync(dst) ? dst : null;
  } catch {
    return null;
  }
}

interface RawMessage {
  role?: string;
  content?: Array<{ type?: string; text?: string }> | string;
  tool_calls?: Array<{ function_call?: { name?: string; arguments?: string }; name?: string }>;
}

/** Trae wraps user turns in per-block <system-reminder> chunks (date/terminals etc.); strip them and keep the rest. */
export function stripSystemReminder(s: string): string {
  return s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

/** toolResult blocks arrive wrapped in <toolcall_status>/<toolcall_result>; unwrap for readability. */
export function stripToolWrapper(s: string): string {
  return s
    .replace(/<toolcall_status>[^<]*<\/toolcall_status>\s*/g, "")
    .replace(/<toolcall_result>/g, "")
    .replace(/<\/toolcall_result>/g, "")
    .trim();
}

/** user turns are wrapped in <user_input>…</user_input>; unwrap. */
export function stripUserInput(s: string): string {
  return s
    .replace(/<user_input>\s*/g, "")
    .replace(/<\/user_input>\s*/g, "")
    .trim();
}

export function createTraeAdapter(): AgentAdapter {
  return {
    id: "trae",
    label: "Trae",
    dependencyHint: "需要 sqlcipher 二进制（apt install sqlcipher）解密本地库",
    roots() {
      const r = join(homedir(), ".config", "Trae");
      return existsSync(r) ? [r] : [];
    },

    async probe() {
      const src = DB();
      if (!existsSync(src)) return { ok: false, count: 0, watermarkMs: 0 };
      // 内容级水位：NativeExtensionService 每 ~10 min 重写一遍 model_config_cache
      // （17 行删旧插新 + request_at/request_pin 刷新，与聊天无关，实测 2026-09-08），
      // 用 src mtime 当水位会让源永远"有更新"。改用聊天表时间戳（经 mtime 门控的
      // 解密缓存，仅在 src 真变后第一次 probe 才解密，其余 stat 级零成本）。
      const plain = await decryptedCopy(TRAE_KNOWN_KEY);
      let watermarkMs = 0;
      if (plain) {
        try {
          const db = new DatabaseSync(plain, { readOnly: true });
          try {
            if (tableOk(db, "chat_session")) {
              const r = db.prepare(
                "SELECT max(v) AS mv FROM (" +
                "SELECT max(created_at) AS v FROM chat_session UNION ALL SELECT max(updated_at) FROM chat_session UNION ALL SELECT max(deleted_at) FROM chat_session " +
                (tableOk(db, "history_v2") ? "UNION ALL SELECT max(created_at) FROM history_v2 " : "") +
                ") WHERE v IS NOT NULL",
              ).get() as { mv: number | null };
              if (r?.mv) watermarkMs = r.mv * 1000;
            }
          } finally { db.close(); }
        } catch { /* decrypt/read race — fall back to mtime */ }
      }
      if (!watermarkMs) {
        try { watermarkMs = statSync(src).mtimeMs; } catch { /* raced */ }
      }
      return { ok: true, count: 0 /* unknown until decrypt */, watermarkMs };
    },

    async list() {
      const plain = (await decryptedCopy(TRAE_KNOWN_KEY)) ?? await (async () => {
        const scanned = scanTraeKey();
        return scanned ? await decryptedCopy(scanned) : null;
      })();
      if (!plain) return [];
      let db: DatabaseSync;
      try { db = new DatabaseSync(plain, { readOnly: true }); } catch { return []; }
      try {
        if (!tableOk(db, "chat_session")) return [];
        const rows = db.prepare("SELECT session_id FROM chat_session WHERE deleted_at = 0").all() as Array<{ session_id: string }>;
        return rows.map((r) => ({ sid: r.session_id, path: `${plain}#session:${r.session_id}` }));
      } catch { return []; }
      finally { db.close(); }
    },

    async parse(ref): Promise<ParsedSessionFile | null> {
      const [dbPath, marker] = ref.path.split("#");
      if (!marker?.startsWith("session:")) return null;
      const sid = ref.sid;
      let db: DatabaseSync;
      try { db = new DatabaseSync(dbPath, { readOnly: true }); } catch { return null; }
      try {
        if (!tableOk(db, "history_v2") || !tableOk(db, "project")) return null;
        const sessRow = db.prepare(
          "SELECT s.session_title, p.absolute_path, s.created_at, s.updated_at FROM chat_session s LEFT JOIN project p ON p.project_id = s.project_id WHERE s.session_id = ?",
        ).get(sid) as { session_title?: string; absolute_path?: string; created_at?: number; updated_at?: number } | undefined;

        const histRows = db.prepare(
          "SELECT messages, created_at FROM history_v2 WHERE session_id = ? AND deleted_at = 0 ORDER BY id",
        ).all(sid) as Array<{ messages: string | null; created_at?: number }>;

        interface ChatMsg { role: "user" | "assistant" | "toolResult"; ts: number | null; model?: string; toolName?: string; text: string }
        const out: ChatMsg[] = [];
        for (const row of histRows) {
          if (!row.messages) continue;
          let doc: { raw_messages?: RawMessage[] };
          try { doc = JSON.parse(row.messages) as { raw_messages?: RawMessage[] }; } catch { continue; }
          for (const rm of doc.raw_messages ?? []) {
            const role = rm.role === "assistant" ? "assistant" : rm.role === "user" ? "user" : "toolResult";
            let text = "";
            if (role === "user") {
              // per-block strip: only drop blocks that are pure system-reminder wrappers
              const parts: string[] = [];
              if (typeof rm.content === "string") {
                const s = stripSystemReminder(rm.content);
                if (s) parts.push(s);
              } else if (Array.isArray(rm.content)) {
                for (const c of rm.content) {
                  if (c.type !== "text" || typeof c.text !== "string") continue;
                  const s = stripSystemReminder(c.text);
                  if (s) parts.push(s);
                }
              }
              text = parts.join("\n");
              text = stripUserInput(text);
              if (!text.trim()) continue; // pure wrapper turn (no user text)
            } else {
              if (typeof rm.content === "string") text = rm.content;
              else if (Array.isArray(rm.content)) {
                text = rm.content.filter((c) => c.type === "text" && typeof c.text === "string")
                  .map((c) => c.text).join("\n");
              }
              if (role === "toolResult") text = stripToolWrapper(text);
              for (const tc of rm.tool_calls ?? []) {
                const name = tc.function_call?.name ?? tc.name ?? "tool";
                const args = tc.function_call?.arguments ?? "";
                text += `${text ? "\n" : ""}🛠 ${name}${args ? ` ${String(args).slice(0, 300)}` : ""}`;
              }
              if (!text.trim()) continue;
            }
            out.push({ role, ts: row.created_at ? new Date(row.created_at * 1000).toISOString() : null, text });
          }
        }
        if (!out.length) return null;

        const createdIso = sessRow?.created_at ? new Date(sessRow.created_at * 1000).toISOString() : new Date().toISOString();
        const updatedIso = sessRow?.updated_at ? new Date(sessRow.updated_at * 1000).toISOString() : createdIso;
        void dbPath;
        return {
          meta: {
            path: ref.path,
            id: sid,
            cwd: sessRow?.absolute_path ?? "",
            name: sessRow?.session_title || undefined,
            created: createdIso,
            modified: updatedIso,
            messageCount: out.length,
            firstMessage: out.find((m) => m.role === "user")?.text.slice(0, 500) ?? "(no messages)",
            lastMessage: out[out.length - 1]?.text ?? "",
          },
          messages: out.map((m, i) => ({ entryId: String(i + 1), role: m.role, ts: m.ts, model: m.model, toolName: m.toolName, text: m.text })),
        };
      } finally { db.close(); }
    },
  } as AgentAdapter;
}

function tableOk(db: DatabaseSync, table: string): boolean {
  try {
    const r = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) as { name: string } | undefined;
    return !!r;
  } catch { return false; }
}
