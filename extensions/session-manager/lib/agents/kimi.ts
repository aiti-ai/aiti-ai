/**
 * session-manager — Kimi CLI / Kimi Code CLI adapter.
 *
 * Session layout (per cc-connect agent/kimi semantics):
 *   ~/.kimi/sessions/<project>/<sid>/          (legacy kimi-cli)
 *   ~/.kimi-code/sessions/<project>/<sid>/     (Kimi Code CLI)
 * Per-session dir:
 *   state.json        legacy {custom_title,archived} | new {title,workDir,updatedAt}
 *   context.jsonl     legacy transcript {role, content} lines
 *   agents/main/wire.jsonl  Kimi Code transcript {type, message:{role,content}, origin}
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, ExtSessionRef, ExtSourceProbe } from "./types.ts";
import { artifactPrimitives, artifactCapabilities } from "./archive-artifact.ts";
import { statFreshList } from "./fresh.ts";
import type { IndexedMessage } from "../session-file.ts";

const BASES = () => [join(homedir(), ".kimi", "sessions"), join(homedir(), ".kimi-code", "sessions")];

function* sessionDirs(): Generator<{ dir: string; sid: string }> {
  for (const base of BASES()) {
    if (!existsSync(base)) continue;
    let projects: string[] = [];
    try { projects = readdirSync(base); } catch { continue; }
    for (const proj of projects) {
      const pd = join(base, proj);
      try { if (!statSync(pd).isDirectory()) continue; } catch { continue; }
      let sids: string[] = [];
      try { sids = readdirSync(pd); } catch { continue; }
      for (const sid of sids) {
        const sd = join(pd, sid);
        try { if (statSync(sd).isDirectory()) yield { dir: sd, sid }; } catch { /* raced */ }
      }
    }
  }
}

interface KimiState {
  custom_title?: string;
  title?: string;
  archived?: boolean;
  workDir?: string;
  updatedAt?: string | number;
}

interface TranscriptEntry {
  role?: string;
  content?: unknown;
  message?: { role?: string; content?: unknown };
  type?: string;
}

function entryText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && typeof c === "object" && c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("\n");
  }
  return "";
}

export function createKimiAdapter(): AgentAdapter {
  return {
    id: "kimi",
    label: "Kimi",
    roots() {
      return BASES().filter((b) => existsSync(b));
    },

    probe(): ExtSourceProbe {
      let count = 0;
      let watermarkMs = 0;
      for (const { dir } of sessionDirs()) {
        count++;
        // dir mtime misses in-place transcript updates — stat state.json too
        for (const f of [dir, join(dir, "state.json"), join(dir, "context.jsonl")]) {
          try { watermarkMs = Math.max(watermarkMs, statSync(f).mtimeMs); } catch { /* absent */ }
        }
      }
      const anyBase = BASES().some((b) => existsSync(b));
      return { ok: anyBase, count, watermarkMs };
    },

    listFresh() { return statFreshList(this.list()); },
    list(): ExtSessionRef[] {
      return [...sessionDirs()].map(({ dir, sid }) => ({ sid, path: dir }));
    },

    ...artifactPrimitives(),
    capabilities: artifactCapabilities(),
    parse(ref) {
      let state: KimiState = {};
      const statePath = join(ref.path, "state.json");
      if (existsSync(statePath)) {
        try { state = JSON.parse(readFileSync(statePath, "utf8")) as KimiState; } catch { state = {}; }
      }
      if (state.archived) return null;

      // transcript: legacy context.jsonl preferred, then agents/main/wire.jsonl
      const candidates = [join(ref.path, "context.jsonl"), join(ref.path, "agents", "main", "wire.jsonl")];
      let raw = "";
      for (const c of candidates) {
        if (existsSync(c)) { raw = readFileSync(c, "utf8"); break; }
      }
      if (!raw.trim()) return null;

      let firstMessage = "", lastMessage = "";
      const messages: IndexedMessage[] = [];
      let seq = 0;
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let e: TranscriptEntry;
        try { e = JSON.parse(line) as TranscriptEntry; } catch { continue; }
        const role = (e.message?.role ?? e.role) === "assistant" ? "assistant" : "user";
        let text = entryText(e.message?.content ?? e.content).trim();
        if (!text) continue;
        if (role === "user") {
          text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
          if (!text) continue;
        }
        seq++;
        if (!firstMessage && role === "user") firstMessage = text.slice(0, 500);
        lastMessage = text;
        messages.push({ entryId: `${seq}`, role, ts: null, text });
      }

      if (!messages.length) return null;
      const mtime = (() => { try { return statSync(ref.path).mtimeMs; } catch { return Date.now(); } })();
      const updatedIso = state.updatedAt
        ? new Date(typeof state.updatedAt === "number" ? state.updatedAt : String(state.updatedAt)).toISOString()
        : new Date(mtime).toISOString();
      return {
        meta: {
          path: ref.path,
          id: ref.sid,
          cwd: state.workDir ?? "",
          name: state.custom_title || state.title || undefined,
          created: updatedIso,
          modified: updatedIso,
          messageCount: messages.length,
          firstMessage: firstMessage || "(no messages)",
          lastMessage,
        },
        messages,
      };
    },
  };
}
