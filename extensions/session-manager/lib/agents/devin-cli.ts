/**
 * session-manager — Devin CLI adapter (Cognition `devin` CLI, local sessions).
 *
 * Verified against a real install (devin v3000.15.14, 2026-11-28): local-mode
 * sessions persist to a single SQLite store
 *   $XDG_DATA_HOME/devin/cli/sessions.db   (default ~/.local/share/devin/cli/sessions.db)
 *   sessions:      id, title, working_directory, model, created_at, last_activity_at
 *                  (epoch seconds), main_chain_id (= active chain TAIL node_id), hidden
 *   message_nodes: row_id, session_id, node_id, parent_node_id (tree), created_at,
 *                  chat_message = JSON {role: system|user|assistant|tool, content}
 * The active conversation is the parent chain walked backwards from
 * `main_chain_id`; abandoned branches (older turns after restarts) hang off the
 * same tree and are skipped.
 *
 * Shared-store safety: every session lives in ONE db file, so this adapter is
 * READ-ONLY by design — no archive primitives (an artifact-level remove would
 * move/unlink the whole db = all sessions).
 *
 * id "devin" aligns with the aiti-acp-agent backend agentKey (open-live
 * takeover goes through ACP session/load = true resume). Note the CLI keeps
 * per-session locks: resuming a session that another `devin` process still
 * holds open fails with "already open in another process" — stop the old
 * holder first.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentAdapter, ExtFreshMeta, ExtSessionRef, ExtSourceProbe } from "./types.ts";
import type { IndexedMessage } from "../session-file.ts";

const ROOT = () =>
  process.env.AITI_DEVIN_CLI_HOME ||
  join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "devin", "cli");
const DB = () => join(ROOT(), "sessions.db");

interface DevinSessionRow {
  id: string;
  title: string | null;
  working_directory: string | null;
  model: string | null;
  created_at: number | null;
  last_activity_at: number | null;
  main_chain_id: number | null;
}
interface DevinNodeRow { node_id: number; parent_node_id: number | null; chat_message: string | null; created_at: number | null }
interface DevinMessage { role?: string; content?: unknown }

function isoSeconds(sec: number | null | undefined): string {
  if (!sec || sec <= 0) return new Date(0).toISOString();
  return new Date(sec * 1000).toISOString();
}

/** Extract display text from a chat_message content (string or block list). */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : ""))
      .join("")
      .trim();
  }
  return "";
}

function openDb(): DatabaseSync | null {
  const path = DB();
  if (!existsSync(path)) return null;
  try { return new DatabaseSync(path, { readOnly: true }); } catch { return null; }
}

export function createDevinCliAdapter(): AgentAdapter {
  return {
    id: "devin", // Devin CLI (same key as the aiti-acp-agent devin backend; windsurf = Devin Desktop is a different store)
    label: "Devin",
    roots() {
      const r = ROOT();
      return existsSync(r) ? [r] : [];
    },

    probe(): ExtSourceProbe {
      let count = 0;
      let watermarkMs = 0;
      const db = openDb();
      if (!db) return { ok: false, count: 0, watermarkMs: 0 };
      try {
        const rows = db.prepare("SELECT last_activity_at FROM sessions WHERE COALESCE(hidden, 0) = 0").all() as Array<{ last_activity_at: number | null }>;
        count = rows.length;
        for (const r of rows) {
          if (r.last_activity_at && r.last_activity_at * 1000 > watermarkMs) watermarkMs = r.last_activity_at * 1000;
        }
      } catch { /* unreadable */ } finally {
        try { db.close(); } catch { /* already closed */ }
      }
      return { ok: count > 0, count, watermarkMs };
    },

    /**
     * db-backed source: rev = per-session last_activity_at (ms) — see types.ts ExtSessionRef.rev:
     * the shared db file changes constantly, a stat watermark would re-parse everything; rev gives sync a per-session watermark.
     */
    listFresh(): ExtFreshMeta[] {
      const db = openDb();
      if (!db) return [];
      try {
        const rows = db.prepare("SELECT id, title, last_activity_at FROM sessions WHERE COALESCE(hidden, 0) = 0").all() as Array<{ id: string; title: string | null; last_activity_at: number | null }>;
        return rows.map((r) => ({
          sid: r.id,
          ...(r.last_activity_at && r.last_activity_at > 0 ? { timeUpdatedMs: r.last_activity_at * 1000 } : {}),
          ...(r.title ? { title: r.title } : {}),
        }));
      } catch { return []; } finally {
        try { db.close(); } catch { /* already closed */ }
      }
    },

    list(): ExtSessionRef[] {
      const db = openDb();
      if (!db) return [];
      try {
        const rows = db.prepare("SELECT id, last_activity_at FROM sessions WHERE COALESCE(hidden, 0) = 0").all() as Array<{ id: string; last_activity_at: number | null }>;
        return rows.map((r) => ({ sid: r.id, path: DB(), ...(r.last_activity_at && r.last_activity_at > 0 ? { rev: r.last_activity_at * 1000 } : {}) }));
      } catch { return []; } finally {
        try { db.close(); } catch { /* already closed */ }
      }
    },

    parse(ref) {
      const db = openDb();
      if (!db) return null;
      try {
        const row = db.prepare(
          "SELECT id, title, working_directory, model, created_at, last_activity_at, main_chain_id FROM sessions WHERE id = ? AND COALESCE(hidden, 0) = 0",
        ).get(ref.sid) as DevinSessionRow | undefined;
        if (!row) return null;

        // Active chain = walk parent_node_id backwards from main_chain_id.
        const nodes = db.prepare("SELECT node_id, parent_node_id, chat_message, created_at FROM message_nodes WHERE session_id = ?").all(ref.sid) as DevinNodeRow[];
        const byNode = new Map<number, DevinNodeRow>();
        for (const n of nodes) byNode.set(n.node_id, n);
        let ordered: DevinNodeRow[] = [];
        if (row.main_chain_id != null && byNode.has(row.main_chain_id)) {
          const chain: DevinNodeRow[] = [];
          const seen = new Set<number>();
          let cur: number | null = row.main_chain_id;
          while (cur != null && !seen.has(cur)) {
            const n = byNode.get(cur);
            if (!n) break;
            seen.add(cur);
            chain.push(n);
            cur = n.parent_node_id;
          }
          chain.reverse();
          ordered = chain;
        } else if (nodes.length > 0) {
          // No chain pointer (older db) — fall back to node_id order.
          ordered = [...nodes].sort((a, b) => a.node_id - b.node_id);
        }

        const messages: IndexedMessage[] = [];
        let firstUser = "", lastMessage = "";
        for (const n of ordered) {
          if (!n.chat_message) continue;
          let m: DevinMessage;
          try { m = JSON.parse(n.chat_message) as DevinMessage; } catch { continue; }
          const role = m.role;
          if (role !== "user" && role !== "assistant" && role !== "tool") continue; // system/thinking etc. stay off the timeline
          const text = contentText(m.content);
          if (!text) continue;
          if (role === "tool") {
            messages.push({ entryId: `${messages.length + 1}`, role: "toolResult", ts: isoSeconds(n.created_at), text: text.slice(0, 2000) });
          } else {
            messages.push({
              entryId: `${messages.length + 1}`,
              role,
              ts: isoSeconds(n.created_at),
              text,
              ...(role === "assistant" && row.model ? { model: row.model, provider: "devin" } : {}),
            });
          }
          if (role === "user" && !firstUser) firstUser = text;
          lastMessage = text;
        }
        if (!messages.length) return null;

        const created = isoSeconds(row.created_at);
        const modified = isoSeconds(row.last_activity_at);
        return {
          meta: {
            path: ref.path,
            id: ref.sid,
            cwd: row.working_directory ?? "",
            name: row.title ?? undefined,
            created,
            modified,
            messageCount: messages.length,
            firstMessage: firstUser || row.title || "(no messages)",
            lastMessage,
          },
          messages,
        };
      } finally {
        try { db.close(); } catch { /* already closed */ }
      }
    },
  };
}
