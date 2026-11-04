/**
 * session-manager — DSH (DeepSeek Harness) adapter.
 *
 * Storage: ~/.dsh/sessions/<--cwd-encoded-->/session-<uuid>/session.jsonl.zstd
 * (subagents live under the same session dir's subagents/ — main log only).
 *
 * The artifact is DSH's event-sourced session log: concatenated self-contained
 * zstd frames (one per append batch). Node's zstd APIs stop at the first frame,
 * so frames are split at the zstd magic (28 B5 2F FD) and decompressed
 * individually. Event schema is authoritative in deepseek-harness
 * packages/core/session/src/types.ts (SessionEventMap):
 *   header  {type:"session", id, createdAt, cwd, agentPreset}
 *   user/message      data.content[{type:"text",text}]
 *   assistant/message data.message.content[{type:"reasoning"|"text"|"tool-call",...}], data.usage?
 *   tool/call         data {callId, name, arguments}
 *   tool/result       data.message.content[{type:"tool-result",content:[{type:"text",text}]}]
 *   session/title     data.title
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import type { AgentAdapter, ExtSessionRef, ExtSourceProbe } from "./types.ts";
import { artifactPrimitives, artifactCapabilities } from "./archive-artifact.ts";
import { statFreshList } from "./fresh.ts";
import type { IndexedMessage } from "../session-file.ts";

const ROOT = () => join(homedir(), ".dsh", "sessions");
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** Decompress a concatenation of self-contained zstd frames. */
function decompressFrames(buf: Buffer): string {
  const starts: number[] = [0];
  for (let i = 1; i <= buf.length - 4; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) {
      starts.push(i);
    }
  }
  const parts: Buffer[] = [];
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try { parts.push(zstdDecompressSync(buf.subarray(starts[k], end))); } catch { /* torn frame */ }
  }
  return Buffer.concat(parts).toString("utf8");
}

interface DshEvent {
  type?: string;
  time?: number;
  data?: Record<string, unknown>;
}

function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c && typeof c === "object" && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

export function createDshAdapter(): AgentAdapter {
  return {
    id: "dsh",
    label: "DSH",
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
        for (const bucket of readdirSync(root)) {
          const b = join(root, bucket);
          try { if (!statSync(b).isDirectory()) continue; } catch { continue; }
          for (const s of readdirSync(b)) {
            const f = join(b, s, "session.jsonl.zstd");
            if (!existsSync(f)) continue;
            count++;
            try { watermarkMs = Math.max(watermarkMs, statSync(f).mtimeMs); } catch { /* raced */ }
          }
        }
      } catch { /* unreadable */ }
      return { ok: count > 0, count, watermarkMs };
    },

    listFresh() { return statFreshList(this.list()); },
    list(): ExtSessionRef[] {
      const out: ExtSessionRef[] = [];
      const root = ROOT();
      if (!existsSync(root)) return out;
      for (const bucket of readdirSync(root)) {
        const b = join(root, bucket);
        try { if (!statSync(b).isDirectory()) continue; } catch { continue; }
        for (const s of readdirSync(b)) {
          // dir name: session-<uuid> — sid must match to keep composite ids stable
          if (!s.startsWith("session-")) continue;
          const f = join(b, s, "session.jsonl.zstd");
          if (existsSync(f)) out.push({ sid: s.slice("session-".length), path: f });
        }
      }
      return out;
    },

    ...artifactPrimitives(),
    capabilities: artifactCapabilities(),
    parse(ref) {
      let text: string;
      try { text = decompressFrames(readFileSync(ref.path)); } catch { return null; }

      const events: DshEvent[] = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try { events.push(JSON.parse(line) as DshEvent); } catch { continue; }
      }

      let cwd = "", title: string | undefined, createdIso = "", modifiedMs = 0;
      interface Pending { name: string; args: string }
      const calls = new Map<string, Pending>();
      let firstMessage = "", lastMessage = "";
      const messages: IndexedMessage[] = [];
      let seq = 0;

      for (const e of events) {
        const t = e.type ?? "";
        if (t === "session") {
          const d = e.data as Record<string, unknown> | undefined;
          if (d && typeof d.cwd === "string") cwd = d.cwd;
          if (d && typeof d.createdAt === "number") createdIso = new Date(d.createdAt).toISOString();
          continue;
        }
        if (typeof e.time === "number") modifiedMs = Math.max(modifiedMs, e.time);
        if (t === "session/title") {
          const title2 = (e.data as Record<string, unknown> | undefined)?.title;
          if (typeof title2 === "string") title = title2;
          continue;
        }
        if (t === "user/message") {
          const d = e.data as Record<string, unknown> | undefined;
          const text = textOfContent(d?.content).trim();
          if (!text) continue;
          if (text.includes("<system-reminder>") || text.startsWith("<system-reminder>")) {
            // strip injected reminders but keep any real user text after them
            const cleaned = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
            if (!cleaned) continue;
            seq++;
            if (!firstMessage) firstMessage = cleaned.slice(0, 500);
            lastMessage = cleaned;
            messages.push({ entryId: `${seq}`, role: "user", ts: e.time ? new Date(e.time).toISOString() : null, text: cleaned });
            continue;
          }
          seq++;
          if (!firstMessage) firstMessage = text.slice(0, 500);
          lastMessage = text;
          messages.push({ entryId: `${seq}`, role: "user", ts: e.time ? new Date(e.time).toISOString() : null, text });
          continue;
        }
        if (t === "assistant/message") {
          const d = e.data as Record<string, unknown> | undefined;
          const msg = d?.message as Record<string, unknown> | undefined;
          const content = Array.isArray(msg?.content) ? msg!.content as Array<Record<string, unknown>> : [];
          const texts: string[] = [];
          for (const c of content) {
            if (c.type === "text" && typeof c.text === "string" && c.text.trim()) texts.push(c.text);
            // reasoning blocks kept out of the timeline (viewer noise)
          }
          const text = texts.join("\n").trim();
          if (!text) continue;
          seq++;
          lastMessage = text;
          messages.push({
            entryId: `${seq}`, role: "assistant",
            ts: e.time ? new Date(e.time).toISOString() : null,
            model: typeof msg?.model === "string" ? msg.model : undefined,
            text,
          });
          continue;
        }
        if (t === "tool/call") {
          const d = e.data as Record<string, unknown> | undefined;
          const callId = typeof d?.callId === "string" ? d.callId : "";
          const name = typeof d?.name === "string" ? d.name : "tool";
          const args = typeof d?.arguments === "string" ? d.arguments : "";
          if (callId) calls.set(callId, { name, args });
          seq++;
          messages.push({
            entryId: `${seq}`, role: "assistant", toolName: name,
            ts: e.time ? new Date(e.time).toISOString() : null,
            text: `🛠 ${name}${args ? ` ${args.slice(0, 300)}` : ""}`,
          });
          continue;
        }
        if (t === "tool/result") {
          const d = e.data as Record<string, unknown> | undefined;
          const msg = d?.message as Record<string, unknown> | undefined;
          const source = msg?.source as Record<string, unknown> | undefined;
          const callId = typeof source?.callId === "string" ? source.callId : "";
          const pending = calls.get(callId);
          let text = "";
          const content = msg?.content;
          if (Array.isArray(content)) {
            for (const c of content) {
              if (c && typeof c === "object" && c.type === "tool-result" && Array.isArray(c.content)) {
                for (const inner of c.content as Array<Record<string, unknown>>) {
                  if (inner.type === "text" && typeof inner.text === "string") text += inner.text;
                }
              }
            }
          }
          if (!text.trim()) continue;
          seq++;
          messages.push({
            entryId: `${seq}`, role: "toolResult", toolName: pending?.name,
            ts: e.time ? new Date(e.time).toISOString() : null,
            text: text.slice(0, 2000),
          });
          continue;
        }
      }

      if (!messages.length) return null;
      const nowIso = new Date().toISOString();
      void modifiedMs;
      return {
        meta: {
          path: ref.path,
          id: ref.sid,
          cwd,
          name: title || undefined,
          created: createdIso || nowIso,
          modified: modifiedMs ? new Date(modifiedMs).toISOString() : createdIso || nowIso,
          messageCount: messages.length,
          firstMessage: firstMessage || "(no messages)",
          lastMessage,
        },
        messages,
      };
    },
  };
}
