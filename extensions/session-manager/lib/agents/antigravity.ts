/**
 * session-manager — Google Antigravity adapter.
 *
 * Verified against a real install (2026-08-24): conversations persist under
 *   ~/.gemini/antigravity/brain/<convId>/.system_generated/logs/transcript.jsonl
 * with lines {step_index, source, type:"USER_INPUT"|"PLANNER_RESPONSE"|"CHECKPOINT",
 * status, created_at, content}. USER_INPUT content is wrapped in
 * <USER_REQUEST>…</USER_REQUEST> plus metadata blocks — only the request body is
 * shown. CHECKPOINT/system steps are skipped.
 * Older builds also write ~/.gemini/tmp/<slug>/chats/*.jsonl (cc-connect reads
 * those); both layouts are scanned.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, ExtSessionRef, ExtSourceProbe } from "./types.ts";
import { statFreshList } from "./fresh.ts";
import type { IndexedMessage } from "../session-file.ts";

const BRAIN = () => join(homedir(), ".gemini", "antigravity", "brain");

interface TranscriptLine {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  created_at?: string;
  content?: string;
}

function cleanUserInput(content: string): string {
  const m = /<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/.exec(content);
  return (m ? m[1] : content).trim();
}

function* brainTranscripts(): Generator<{ sid: string; path: string }> {
  const root = BRAIN();
  if (!existsSync(root)) return;
  let convs: string[] = [];
  try { convs = readdirSync(root); } catch { return; }
  for (const conv of convs) {
    const f = join(root, conv, ".system_generated", "logs", "transcript.jsonl");
    if (existsSync(f)) yield { sid: conv, path: f };
  }
}

/** legacy/alternate layout: ~/.gemini/tmp/<slug>/chats/*.jsonl */
function* tmpChats(): Generator<{ sid: string; path: string }> {
  const root = join(homedir(), ".gemini", "tmp");
  if (!existsSync(root)) return;
  let slugs: string[] = [];
  try { slugs = readdirSync(root); } catch { return; }
  for (const slug of slugs) {
    const dir = join(root, slug, "chats");
    if (!existsSync(dir)) continue;
    let files: string[] = [];
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) {
      // gemini-cli's own sessions are session-*.json; antigravity writes .jsonl
      if (f.endsWith(".jsonl")) yield { sid: `${slug}-${f.replace(/\.jsonl$/, "")}`, path: join(dir, f) };
    }
  }
}

export function createAntigravityAdapter(): AgentAdapter {
  return {
    id: "antigravity",
    label: "Antigravity",
    roots() {
      const root = join(homedir(), ".gemini");
      return existsSync(root) ? [root] : [];
    },

    probe(): ExtSourceProbe {
      let count = 0;
      let watermarkMs = 0;
      for (const { path } of [...brainTranscripts(), ...tmpChats()]) {
        count++;
        try { watermarkMs = Math.max(watermarkMs, statSync(path).mtimeMs); } catch { /* raced */ }
      }
      return { ok: existsSync(BRAIN()) || count > 0, count, watermarkMs };
    },

    listFresh() { return statFreshList(this.list()); },
    list(): ExtSessionRef[] {
      return [
        ...[...brainTranscripts()].map(({ sid, path }) => ({ sid, path })),
        ...[...tmpChats()],
      ];
    },

    parse(ref) {
      let raw = "";
      try { raw = readFileSync(ref.path, "utf8"); } catch { return null; }

      let firstMessage = "", lastMessage = "";
      let createdIso = "", modifiedIso = "";
      const messages: IndexedMessage[] = [];
      let seq = 0;

      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let e: TranscriptLine;
        try { e = JSON.parse(line) as TranscriptLine; } catch { continue; }
        if (e.type === "USER_INPUT") {
          const text = cleanUserInput(e.content ?? "");
          if (!text) continue;
          seq++;
          if (!firstMessage) firstMessage = text.slice(0, 500);
          lastMessage = text;
          messages.push({ entryId: `${seq}`, role: "user", ts: e.created_at ?? null, text });
          if (!createdIso && e.created_at) createdIso = e.created_at;
          if (e.created_at) modifiedIso = e.created_at;
        } else if (e.type === "PLANNER_RESPONSE") {
          const text = (e.content ?? "").trim();
          if (!text) continue;
          seq++;
          lastMessage = text;
          messages.push({ entryId: `${seq}`, role: "assistant", ts: e.created_at ?? null, text });
          if (e.created_at) modifiedIso = e.created_at;
        }
        // CHECKPOINT / system / tool steps skipped
      }

      if (!messages.length) return null;
      const mtimeIso = (() => { try { return statSync(ref.path).mtime.toISOString(); } catch { return new Date().toISOString(); } })();
      return {
        meta: {
          path: ref.path,
          id: ref.sid,
          cwd: "",
          created: createdIso || mtimeIso,
          modified: modifiedIso || mtimeIso,
          messageCount: messages.length,
          firstMessage: firstMessage || "(no messages)",
          lastMessage,
        },
        messages,
      };
    },
  };
}
