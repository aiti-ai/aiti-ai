/**
 * session-manager — Gemini CLI adapter.
 *
 * Sessions: ~/.gemini/tmp/<project-hash>/chats/session-<id>.json — one JSON
 * document per session (not installed locally; parsed defensively):
 *   {sessionId, projectHash?, startTime?, lastUpdated?,
 *    messages:[{type:"user"|"gemini", content:string, timestamp?}]}
 * Newer builds may nest text under chunks[] — handled best-effort.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, ExtSessionRef, ExtSourceProbe } from "./types.ts";
import { artifactPrimitives, artifactCapabilities } from "./archive-artifact.ts";
import { statFreshList } from "./fresh.ts";
import type { IndexedMessage } from "../session-file.ts";

const SID_RE = /^session-(.+)\.json$/i;

interface GeminiMessage {
  type?: string;
  content?: unknown;
  timestamp?: string;
  chunks?: Array<{ content?: unknown }>;
}

interface GeminiDoc {
  sessionId?: string;
  startTime?: string;
  lastUpdated?: string;
  messages?: GeminiMessage[];
}

function msgText(m: GeminiMessage): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.chunks)) {
    return m.chunks.map((c) => (typeof c?.content === "string" ? c.content : "")).join("\n");
  }
  return "";
}

export function createGeminiAdapter(): AgentAdapter {
  const root = () => join(homedir(), ".gemini", "tmp");
  return {
    id: "gemini",
    label: "Gemini CLI",
    roots() {
      const r = root();
      return existsSync(r) ? [r] : [];
    },

    probe(): ExtSourceProbe {
      let count = 0;
      let watermarkMs = 0;
      try {
        for (const h of readdirSync(root())) {
          const chats = join(root(), h, "chats");
          if (!existsSync(chats)) continue;
          watermarkMs = Math.max(watermarkMs, statSync(chats).mtimeMs);
          for (const f of readdirSync(chats)) {
            if (!SID_RE.test(f)) continue;
            count++;
            try { watermarkMs = Math.max(watermarkMs, statSync(join(chats, f)).mtimeMs); } catch { /* raced */ }
          }
        }
      } catch { /* unreadable */ }
      return { ok: existsSync(root()), count, watermarkMs };
    },

    listFresh() { return statFreshList(this.list()); },
    list(): ExtSessionRef[] {
      const out: ExtSessionRef[] = [];
      try {
        for (const h of readdirSync(root())) {
          const chats = join(root(), h, "chats");
          if (!existsSync(chats)) continue;
          for (const f of readdirSync(chats)) {
            const m = SID_RE.exec(f);
            if (m) out.push({ sid: m[1], path: join(chats, f) });
          }
        }
      } catch { /* unreadable */ }
      return out;
    },

    ...artifactPrimitives(),
    capabilities: artifactCapabilities(),
    parse(ref) {
      let doc: GeminiDoc;
      try { doc = JSON.parse(readFileSync(ref.path, "utf8")) as GeminiDoc; } catch { return null; }
      const msgs = Array.isArray(doc.messages) ? doc.messages : [];
      let firstMessage = "", lastMessage = "";
      let created = doc.startTime ?? "";
      const modified = doc.lastUpdated ?? created;
      const messages: IndexedMessage[] = [];
      let messageCount = 0;

      for (const m of msgs) {
        const role = m.type === "user" ? "user" : "assistant";
        const text = msgText(m);
        if (!text.trim()) continue;
        messageCount++;
        if (!firstMessage && role === "user") firstMessage = text.slice(0, 500);
        lastMessage = text;
        messages.push({ entryId: `${messageCount}`, role, ts: m.timestamp ?? null, text });
      }

      if (!messages.length) return null;
      const nowIso = new Date().toISOString();
      return {
        meta: {
          path: ref.path,
          id: doc.sessionId ?? ref.sid,
          cwd: "", // hash dirs are opaque — no cwd recoverable
          created: created || nowIso,
          modified: modified || created || nowIso,
          messageCount,
          firstMessage: firstMessage || "(no messages)",
          lastMessage,
        },
        messages,
      };
    },
  };
}
