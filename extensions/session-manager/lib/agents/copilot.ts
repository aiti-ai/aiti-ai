/**
 * session-manager — GitHub Copilot CLI adapter.
 *
 * Storage: ~/.copilot/session-state/<sid>/
 *   events.jsonl  event stream: session.start {sessionId, context:{cwd}, startTime},
 *                 user.message {content}, assistant.message {model, content},
 *                 tool.execution_start {toolName, arguments}, tool.execution_complete,
 *                 system.message / turn markers / usage (skipped)
 * Auth via gh CLI; sessions created per `copilot -p` or interactive run.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, ExtSessionRef, ExtSourceProbe } from "./types.ts";
import { artifactPrimitives, artifactCapabilities } from "./archive-artifact.ts";
import { statFreshList } from "./fresh.ts";
import type { IndexedMessage } from "../session-file.ts";

const ROOT = () => join(homedir(), ".copilot", "session-state");

function textOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    return v
      .filter((c) => c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string")
      .map((c) => (c as { text: string }).text)
      .join("\n");
  }
  return "";
}

export function createCopilotAdapter(): AgentAdapter {
  return {
    id: "copilot",
    label: "Copilot CLI",
    roots() {
      const r = ROOT();
      return existsSync(r) ? [r] : [];
    },

    probe(): ExtSourceProbe {
      let count = 0;
      let watermarkMs = 0;
      const root = ROOT();
      if (!existsSync(root)) return { ok: false, count: 0, watermarkMs: 0 };
      try {
        for (const sid of readdirSync(root)) {
          const f = join(root, sid, "events.jsonl");
          if (!existsSync(f)) continue;
          count++;
          watermarkMs = Math.max(watermarkMs, statSync(f).mtimeMs);
        }
      } catch { /* unreadable */ }
      return { ok: count > 0, count, watermarkMs };
    },

    listFresh() { return statFreshList(this.list()); },
    list(): ExtSessionRef[] {
      const out: ExtSessionRef[] = [];
      const root = ROOT();
      if (!existsSync(root)) return out;
      try {
        for (const sid of readdirSync(root)) {
          const f = join(root, sid, "events.jsonl");
          if (existsSync(f)) out.push({ sid, path: f });
        }
      } catch { /* unreadable */ }
      return out;
    },

    ...artifactPrimitives(),
    capabilities: artifactCapabilities(),
    parse(ref) {
      let raw = "";
      try { raw = readFileSync(ref.path, "utf8"); } catch { return null; }

      let cwd = "", startTime = "", firstMessage = "", lastMessage = "";
      const messages: IndexedMessage[] = [];
      let seq = 0;

      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let e: { type?: string; timestamp?: string; data?: Record<string, unknown> };
        try { e = JSON.parse(line); } catch { continue; }
        const t = e.type ?? "";
        const d = e.data ?? {};

        if (t === "session.start") {
          const ctx = d.context as Record<string, unknown> | undefined;
          if (ctx && typeof ctx.cwd === "string") cwd = ctx.cwd;
          if (typeof d.startTime === "string") startTime = d.startTime;
          continue;
        }
        if (t === "user.message") {
          let text = typeof d.content === "string" ? d.content : textOf(d.content);
          // strip injected wrappers (<current_datetime>… etc.) conservatively
          text = text.replace(/<current_datetime>[\s\S]*?<\/current_datetime>/g, "").trim();
          if (!text) continue;
          seq++;
          if (!firstMessage) firstMessage = text.slice(0, 500);
          lastMessage = text;
          messages.push({ entryId: `${seq}`, role: "user", ts: e.timestamp ?? null, text });
          continue;
        }
        if (t === "assistant.message") {
          const text = (typeof d.content === "string" ? d.content : "").trim();
          if (!text) continue;
          seq++;
          lastMessage = text;
          messages.push({
            entryId: `${seq}`, role: "assistant",
            ts: e.timestamp ?? null,
            model: typeof d.model === "string" ? d.model : undefined,
            text,
          });
          continue;
        }
        if (t === "tool.execution_start") {
          const toolName = typeof d.toolName === "string" ? d.toolName : "tool";
          const args = JSON.stringify(d.arguments ?? {});
          seq++;
          messages.push({
            entryId: `${seq}`, role: "assistant", toolName,
            ts: e.timestamp ?? null,
            text: `🛠 ${toolName} ${args.slice(0, 300)}`,
          });
          continue;
        }
        if (t === "tool.execution_complete") {
          const text = textOf(d.result ?? d.content).trim();
          if (!text) continue;
          seq++;
          messages.push({ entryId: `${seq}`, role: "toolResult", ts: e.timestamp ?? null, text: text.slice(0, 2000) });
          continue;
        }
      }

      if (!messages.length) return null;
      const mtimeIso = (() => { try { return statSync(ref.path).mtime.toISOString(); } catch { return new Date().toISOString(); } })();
      return {
        meta: {
          path: ref.path,
          id: ref.sid,
          cwd,
          created: startTime || mtimeIso,
          modified: mtimeIso,
          messageCount: messages.length,
          firstMessage: firstMessage || "(no messages)",
          lastMessage,
        },
        messages,
      };
    },
  };
}
