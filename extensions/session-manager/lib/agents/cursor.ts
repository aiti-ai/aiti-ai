/**
 * session-manager — Cursor IDE adapter (not installed locally when written;
 * PSM reference semantics, defensive against schema drift).
 *
 * NOTE: the Cursor Agent CLI (cursor-agent) stores sessions elsewhere —
 * see cursor-cli.ts (adapter id "cursor", aligned with aiti-cursor-agent).
 * 历史：27c5076 曾在本适配器里挂过 CLI chats MVP（meta.json 空壳，无正文、
 * 无法 --resume），已由 cursor-cli.ts（store.db 全量解析）取代。
 *
 * Storage: ~/.config/Cursor/User/globalStorage/state.vscdb (Linux)
 *   table cursorDiskKV (v0.40+):
 *     "composerData:<id>"   → composer meta {name, createdAt, lastUpdatedAt,
 *                              fullConversationHeadersOnly:[{bubbleId}], ...}
 *     "bubbleId:<composerId>:<bubbleId>" → one message
 *                              {type:N, text, toolFormerData:{name,args}, ...}
 * Old workbench.chatdata keys are not handled (pre-0.40).
 *
 * Reads go through a tmp copy (mtime-gated) to avoid locking the live db.
 */
import { existsSync, readdirSync, statSync, mkdirSync, copyFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentAdapter, ExtSessionRef, ExtSourceProbe } from "./types.ts";
import type { IndexedMessage } from "../session-file.ts";

const ROOT = () => join(homedir(), ".config", "Cursor");
const CACHE = () => join("/tmp", "sm-cursor-cache");

function vscdbCandidates(): string[] {
  const out: string[] = [];
  const g = join(ROOT(), "User", "globalStorage", "state.vscdb");
  if (existsSync(g)) out.push(g);
  const ws = join(ROOT(), "User", "workspaceStorage");
  if (existsSync(ws)) {
    try {
      for (const d of readdirSync(ws)) {
        const c = join(ws, d, "state.vscdb");
        if (existsSync(c)) out.push(c);
      }
    } catch { /* unreadable */ }
  }
  return out;
}

/** mtime-gated copy of a live vscdb (+wal/shm if present); returns the copy path. */
function snapshotDb(src: string): string | null {
  try {
    mkdirSync(CACHE(), { recursive: true });
    const name = src.replace(/[/\\]/g, "_");
    const dst = join(CACHE(), name);
    let st: { mtimeMs: number };
    try { st = statSync(src); } catch { return null; }
    // reuse the copy when unchanged
    try {
      const dstSt = statSync(dst);
      if (dstSt.mtimeMs >= st.mtimeMs) return dst;
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

interface ComposerRow { composerId: string; name?: string; createdAt?: number; lastUpdatedAt?: number }

function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) as { name: string } | undefined;
  return !!row;
}

function listComposers(dbPath: string): Array<ComposerRow & { dbPath: string }> {
  const copied = snapshotDb(dbPath);
  if (!copied) return [];
  let db: DatabaseSync;
  try { db = new DatabaseSync(copied, { readOnly: true }); } catch { return []; }
  try {
    if (!tableExists(db, "cursorDiskKV")) return [];
    const rows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all() as
      Array<{ key: string; value: string | null }>;
    const out: Array<ComposerRow & { dbPath: string }> = [];
    for (const r of rows) {
      const id = r.key.slice("composerData:".length);
      if (!r.value) continue;
      try {
        const d = JSON.parse(r.value) as Record<string, unknown>;
        out.push({
          composerId: id,
          name: typeof d.name === "string" ? d.name : undefined,
          createdAt: typeof d.createdAt === "number" ? d.createdAt : undefined,
          lastUpdatedAt: typeof d.lastUpdatedAt === "number" ? d.lastUpdatedAt : undefined,
          dbPath: copied,
        });
      } catch { /* corrupt row */ }
    }
    return out;
  } finally { db.close(); }
}

export function createCursorAdapter(): AgentAdapter {
  return {
    id: "cursor-ide",
    label: "Cursor IDE",
    roots() {
      const r = ROOT();
      return existsSync(r) ? [r] : [];
    },

    probe(): ExtSourceProbe {
      let count = 0;
      let watermarkMs = 0;
      for (const p of vscdbCandidates()) {
        try {
          watermarkMs = Math.max(watermarkMs, statSync(p).mtimeMs);
          count += 1; // db artifact count; real session count needs activation
        } catch { /* raced */ }
      }
      return { ok: count > 0, count, watermarkMs };
    },

    list(): ExtSessionRef[] {
      const out: ExtSessionRef[] = [];
      for (const p of vscdbCandidates()) {
        for (const c of listComposers(p)) {
          out.push({ sid: c.composerId, path: `${c.dbPath}#composer:${c.composerId}` });
        }
      }
      return out;
    },

    parse(ref) {
      const [dbPath, marker] = ref.path.split("#");
      if (!marker?.startsWith("composer:")) return null;
      const composerId = marker.slice("composer:".length);
      let db: DatabaseSync;
      try { db = new DatabaseSync(dbPath, { readOnly: true }); } catch { return null; }
      try {
        if (!tableExists(db, "cursorDiskKV")) return null;
        const compRow = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?").get(`composerData:${composerId}`) as { value: string | null } | undefined;
        if (!compRow?.value) return null;
        let comp: Record<string, unknown>;
        try { comp = JSON.parse(compRow.value) as Record<string, unknown>; } catch { return null; }

        // conversation order: headers only reference bubbleIds
        const headers = Array.isArray(comp.fullConversationHeadersOnly)
          ? comp.fullConversationHeadersOnly as Array<{ bubbleId: string }>
          : [];

        interface Bubble { text?: string; type?: number; toolFormerData?: { name?: string }; timingInfo?: number }
        const bubbles = new Map<string, Bubble>();
        const rows = db.prepare(
          "SELECT key, value FROM cursorDiskKV WHERE key LIKE ?",
        ).all(`bubbleId:${composerId}:%`) as Array<{ key: string; value: string | null }>;
        for (const r of rows) {
          if (!r.value) continue;
          try {
            const b = JSON.parse(r.value) as Bubble;
            bubbles.set(r.key.slice(`bubbleId:${composerId}:`.length), b);
          } catch { /* corrupt */ }
        }

        const ordered = headers.length
          ? headers.map((h) => ({ bid: h.bubbleId, b: bubbles.get(h.bubbleId) })).filter((x) => x.b)
          : [...bubbles.entries()].map(([bid, b]) => ({ bid, b }));

        let seq = 0, firstMessage = "", lastMessage = "";
        const messages: IndexedMessage[] = [];
        for (const { bid, b } of ordered as Array<{ bid: string; b: Bubble }>) {
          // even type ≈ user, odd ≈ assistant in cursor's convention (defensive:
          // fall back to presence of text prefix)
          const role = (b!.type ?? 1) % 2 === 0 ? "user" : "assistant";
          let text = typeof b!.text === "string" ? b!.text : "";
          if (b!.toolFormerData?.name) {
            const args = typeof b!.toolFormerData.args === "string"
              ? String(b!.toolFormerData.args).slice(0, 300) : "";
            text += `${text ? "\n" : ""}🛠 ${b!.toolFormerData.name}${args ? ` ${args}` : ""}`;
          }
          if (!text.trim()) continue;
          seq++;
          if (!firstMessage && role === "user") firstMessage = text.slice(0, 500);
          lastMessage = text;
          messages.push({ entryId: `${seq}`, role, ts: null, text });
        }

        if (!messages.length) return null;
        const createdIso = typeof comp.createdAt === "number" ? new Date(comp.createdAt).toISOString() : new Date().toISOString();
        const updatedIso = typeof comp.lastUpdatedAt === "number" ? new Date(comp.lastUpdatedAt).toISOString() : createdIso;
        return {
          meta: {
            path: ref.path,
            id: composerId,
            cwd: "", // workspace mapping lives outside globalStorage
            name: typeof comp.name === "string" && comp.name ? comp.name : undefined,
            created: createdIso,
            modified: updatedIso,
            messageCount: messages.length,
            firstMessage: firstMessage || "(no messages)",
            lastMessage,
          },
          messages,
        };
      } finally { db.close(); }
    },
  };
}
