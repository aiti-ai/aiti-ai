/**
 * session-manager — Zed editor adapter.
 *
 * Storage: ~/.local/share/zed/threads/threads.db — SQLite with one `threads`
 * table: {id, summary, data_type, data BLOB, created_at, updated_at}.
 * The blob is zstd-compressed JSON (data_type="zstd"; verified 2026-08-24):
 *   {"title": str, "messages": [
 *      {"User":  {"id", "content":[{"Text":"…"}]}},
 *      {"Agent": {"content":[{"Text"|"Thinking"…}], "tool_results":{}, …}} ]}
 *
 * Non-"zstd" data_type values are skipped defensively (schema evolution).
 */
import { existsSync, mkdirSync, copyFileSync, statSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { AgentAdapter, ExtSessionRef, ExtSourceProbe } from "./types.ts";
import type { IndexedMessage } from "../session-file.ts";

const DB = () => join(homedir(), ".local", "share", "zed", "threads", "threads.db");

interface ZedContentBlock {
  Text?: string;
  Thinking?: unknown;
  [k: string]: unknown;
}

interface ZedThread {
  title?: string;
  messages?: Array<Record<string, {
    id?: string;
    content?: ZedContentBlock[];
    tool_results?: Record<string, unknown>;
  }>>;
}

export function createZedAdapter(dbPathOverride?: string): AgentAdapter {
  const DB = () => dbPathOverride ?? join(homedir(), ".local", "share", "zed", "threads", "threads.db");
  return {
    id: "zed",
    label: "Zed",
    roots() {
      const r = DB();
      return existsSync(r) ? [r] : [];
    },

    probe(): ExtSourceProbe {
      const dbPath = DB();
      if (!existsSync(dbPath)) return { ok: false, count: 0, watermarkMs: 0 };
      let count = 0;
      let watermarkMs = 0;
      try {
        watermarkMs = statSync(dbPath).mtimeMs;
        const copied = snapshot(DB());
        if (copied) {
          const db = new DatabaseSync(copied, { readOnly: true });
          try { count = db.prepare("SELECT COUNT(*) c FROM threads").get().c; } finally { db.close(); }
        }
      } catch { /* unreadable */ }
      return { ok: true, count, watermarkMs };
    },

    list(): ExtSessionRef[] {
      const out: ExtSessionRef[] = [];
      const copied = snapshot(DB());
      if (!copied) return out;
      try {
        const db = new DatabaseSync(copied, { readOnly: true });
        try {
          const rows = db.prepare("SELECT id, updated_at FROM threads ORDER BY updated_at DESC").all() as
            Array<{ id: string; updated_at: string }>;
          for (const r of rows) out.push({ sid: r.id, path: `${copied}#thread:${r.id}` });
        } finally { db.close(); }
      } catch { /* unreadable */ }
      return out;
    },

    parse(ref) {
      const [dbPath, marker] = ref.path.split("#");
      if (!marker?.startsWith("thread:")) return null;
      let db: DatabaseSync;
      try { db = new DatabaseSync(dbPath, { readOnly: true }); } catch { return null; }
      let thread: ZedThread;
      try {
        const row = db.prepare("SELECT summary, data_type, data FROM threads WHERE id = ?").get(ref.sid) as
          { summary: string; data_type: string; data: Buffer | null } | undefined;
        if (!row?.data) return null;
        if (row.data_type !== "zstd") return null; // defensive: unknown encoding
        thread = JSON.parse(zstdDecompressSync(row.data).toString("utf8")) as ZedThread;
      } catch { return null; }
      finally { db.close(); }
      void dbPath;

      let firstMessage = "", lastMessage = "";
      const messages: IndexedMessage[] = [];
      let seq = 0;

      for (const wrap of thread.messages ?? []) {
        for (const [kind, body] of Object.entries(wrap)) {
          const role = kind === "User" ? "user" : "assistant";
          const content = Array.isArray(body?.content) ? body!.content : [];
          const text = content
            .filter((c) => typeof c.Text === "string")
            .map((c) => c.Text as string)
            .join("\n")
            .trim();
          if (!text) continue;
          seq++;
          if (!firstMessage && role === "user") firstMessage = text.slice(0, 500);
          lastMessage = text;
          messages.push({ entryId: `${seq}`, role, ts: null, text });
        }
      }

      if (!messages.length) return null;
      const mtimeIso = (() => { try { return statSync(ref.path.split("#")[0]).mtime.toISOString(); } catch { return new Date().toISOString(); } })();
      return {
        meta: {
          path: ref.path,
          id: ref.sid,
          cwd: "", // threads are global in Zed; no per-thread cwd recorded
          name: thread.title || undefined,
          created: mtimeIso,
          modified: mtimeIso,
          messageCount: messages.length,
          firstMessage: firstMessage || "(no messages)",
          lastMessage,
        },
        messages,
      };
    },

    // ── A03 P2 首试点（rows 粒度）：单表 blob 原样快照 → DELETE 行 → INSERT 原样插回。
    //  审核结论（§4 表）：threads 单表无级联，SQLite 型最易。快照 envelope 含全部列
    //  （data blob base64），putBack 前管线已做同 id 查重。──
    capabilities: { remove: true, putBack: true, granularity: "rows" },
    snapshot(ref) {
      const [copyPath] = ref.path.split("#");
      try {
        const db = new DatabaseSync(copyPath, { readOnly: true });
        try {
          const row = db.prepare("SELECT id, summary, data_type, data, created_at, updated_at FROM threads WHERE id = ?").get(ref.sid) as any;
          if (!row) return null;
          const payload = {
            v: 1, kind: "zed-row",
            row: { ...row, data: Buffer.from(row.data ?? Buffer.alloc(0)).toString("base64") },
          };
          return { bytes: Buffer.from(JSON.stringify(payload)), layout: DB() };
        } finally { db.close(); }
      } catch { return null; }
    },
    removeSession(ref) {
      const target = DB();
      if (!existsSync(target)) return; // 幂等：不存在=成功
      const db = new DatabaseSync(target);
      try {
        db.exec("PRAGMA busy_timeout = 2000");
        db.exec("BEGIN");
        db.prepare("DELETE FROM threads WHERE id = ?").run(ref.sid);
        db.exec("COMMIT");
      } catch (e) {
        try { db.exec("ROLLBACK"); } catch { /* noop */ }
        throw e; // 管线撤包、源行保留
      } finally { db.close(); }
    },
    putBack(_sid, snap) {
      const payload = JSON.parse(snap.bytes.toString("utf8")) as {
        kind?: string; row?: { id: string; summary?: string | null; data_type?: string; data: string; created_at?: string | null; updated_at?: string | null };
      };
      if (payload?.kind !== "zed-row" || !payload.row) throw new Error("unexpected zed-row snapshot payload");
      const row = payload.row;
      const db = new DatabaseSync(snap.layout);
      try {
        db.exec("PRAGMA busy_timeout = 2000");
        db.prepare("INSERT INTO threads(id, summary, data_type, data, created_at, updated_at) VALUES(?,?,?,?,?,?)")
          .run(row.id, row.summary ?? null, row.data_type ?? "zstd", Buffer.from(row.data, "base64"), row.created_at ?? null, row.updated_at ?? null);
      } finally { db.close(); }
    },
  };
}

/** mtime-gated copy of the threads db（src 由调用方给定：工厂内 = 生效 DB()）。
 *  缓存文件按源库路径哈希隔离——机器上多个 threads.db（真库/fixture/多实例）互不遮蔽。 */
function snapshot(src: string): string | null {
  try {
    const dir = join("/tmp", "sm-zed-cache");
    mkdirSync(dir, { recursive: true });
    const dst = join(dir, "zed-threads-" + createHash("sha256").update(src).digest("hex").slice(0, 16) + ".sqlite");
    try {
      if (statSync(dst).mtimeMs >= statSync(src).mtimeMs) return dst;
    } catch { /* first copy */ }
    copyFileSync(src, dst);
    for (const suffix of ["-wal", "-shm"]) {
      const side = src + suffix;
      if (existsSync(side)) copyFileSync(side, dst + suffix);
    }
    return dst;
  } catch {
    return null;
  }
}
