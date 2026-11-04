/**
 * session-manager — Windsurf / Devin Desktop adapter (Devin Local, ACP).
 *
 * Verified against a real install (Devin Desktop 3.8.20, 2026-08-25):
 * local-mode sessions persist to
 *   ~/.config/Devin/User/acp-messages/<sessionUuid>.db
 * SQLite per session:
 *   meta(key,value)  → info JSON {title(=首条提问), configOptions, availableCommands}
 *   messages         → {position, kind, payload}; kind ∈ agent_thought|agent_message,
 *     payload = ACP streaming envelope {kind, content:[{sessionUpdate:"*_chunk",
 *     content:{type:"text",text}, _meta:{streamingMessageId}}…]} — chunks must be
 *     concatenated. User prompt is NOT stored as a row; info.title carries it.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentAdapter, ExtSessionRef, ExtSourceProbe } from "./types.ts";
import { artifactPrimitives, artifactCapabilities } from "./archive-artifact.ts";
import { statFreshList } from "./fresh.ts";
import type { IndexedMessage } from "../session-file.ts";

const ROOT = () => join(homedir(), ".config", "Devin", "User", "acp-messages");

interface AcpRow { position: number; kind: string; payload: string }
interface AcpPayload {
  kind?: string;
  content?: Array<{ sessionUpdate?: string; content?: { type?: string; text?: string }; _meta?: Record<string, unknown> }>;
}

export function createWindsurfAdapter(): AgentAdapter {
  return {
    id: "windsurf", // Devin Desktop(原 Windsurf)——存储键沿用 windsurf 命名
    label: "Devin",
    roots() {
      const r = ROOT();
      return existsSync(r) ? [r] : [];
    },

    probe(): ExtSourceProbe {
      let count = 0;
      let watermarkMs = 0;
      try {
        for (const f of readdirSync(ROOT())) {
          if (!f.endsWith(".db")) continue;
          count++;
          watermarkMs = Math.max(watermarkMs, statSync(join(ROOT(), f)).mtimeMs);
        }
      } catch { /* unreadable */ }
      return { ok: count > 0, count, watermarkMs };
    },

    listFresh() { return statFreshList(this.list()); },
    list(): ExtSessionRef[] {
      const out: ExtSessionRef[] = [];
      try {
        for (const f of readdirSync(ROOT())) {
          if (f.endsWith(".db")) out.push({ sid: f.replace(/\.db$/, ""), path: join(ROOT(), f) });
        }
      } catch { /* unreadable */ }
      return out;
    },

    ...artifactPrimitives(),
    capabilities: artifactCapabilities(),
    parse(ref) {
      let db: DatabaseSync;
      try { db = new DatabaseSync(ref.path, { readOnly: true }); } catch { return null; }
      try {
        let title: string | undefined;
        const infoRow = db.prepare("SELECT value FROM meta WHERE key='info'").get() as { value?: string } | undefined;
        if (infoRow?.value) {
          try { title = (JSON.parse(infoRow.value) as { title?: string }).title || undefined; } catch { /* ignore */ }
        }

        const rows = db.prepare("SELECT kind, payload FROM messages ORDER BY position").all() as AcpRow[];
        const messages: IndexedMessage[] = [];
        let firstMessage = "", lastMessage = "";

        for (const r of rows) {
          // skip agent_thought (reasoning) — keep the timeline clean
          if (r.kind !== "agent_message") continue;
          let p: AcpPayload;
          try { p = JSON.parse(r.payload) as AcpPayload; } catch { continue; }
          const text = (p.content ?? [])
            .map((c) => c.content?.text ?? "")
            .join("")
            .trim();
          if (!text) continue;
          messages.push({ entryId: `${messages.length + 1}`, role: "assistant", ts: null, text });
          lastMessage = text;
        }

        // user prompt is only recoverable via the auto-generated title
        if (title) {
          firstMessage = title;
          messages.unshift({ entryId: "0", role: "user", ts: null, text: title });
        }

        if (!messages.length) return null;
        const mtimeIso = (() => { try { return statSync(ref.path).mtime.toISOString(); } catch { return new Date().toISOString(); } })();
        return {
          meta: {
            path: ref.path,
            id: ref.sid,
            cwd: "",
            name: title,
            created: mtimeIso,
            modified: mtimeIso,
            messageCount: messages.length,
            firstMessage: firstMessage || "(no messages)",
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
