/**
 * session-manager — Goose (Block), Amp (Sourcegraph), Factory droid adapters.
 *
 * All three are single-file-per-session stores with documented layouts:
 *   Goose:   ~/.config/goose/sessions/<sid>.jsonl  {role, content} lines
 *   Amp:     ~/.local/share/amp/threads/<tid>.json (+ VSCode globalStorage
 *            sourcegraph.amp/threads(3)/<tid>.json) — JSON thread document
 *   Factory: ~/.factory/sessions/<sid>.jsonl
 *
 * None installed locally at write time — parsing is defensive across the
 * documented shapes; verify on first real install.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, ExtSessionRef, ExtSourceProbe, ParsedExtSessionLike } from "./types.ts";
import { artifactPrimitives, artifactCapabilities } from "./archive-artifact.ts";
import { statFreshList } from "./fresh.ts";
import type { IndexedMessage } from "../session-file.ts";

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

function buildMeta(ref: ExtSessionRef, cwd: string, name: string | undefined, created: string | undefined, modifiedIso: string, messages: IndexedMessage[]): ParsedExtSessionLike | null {
  if (!messages.length) return null;
  return {
    meta: {
      path: ref.path,
      id: ref.sid,
      cwd,
      name,
      created: created ?? modifiedIso,
      modified: modifiedIso,
      messageCount: messages.length,
      firstMessage: messages.find((m) => m.role === "user")?.text.slice(0, 500) || "(no messages)",
      lastMessage: messages[messages.length - 1]?.text ?? "",
    },
    messages,
  };
}

/* ── Goose ── */
interface GooseLine { role?: string; content?: unknown; created?: number }

export function createGooseAdapter(): AgentAdapter {
  const dir = () => join(homedir(), ".config", "goose", "sessions");
  return {
    id: "goose",
    listFresh() { return statFreshList(this.list()); },
    label: "Goose",
    roots() { const d = dir(); return existsSync(d) ? [d] : []; },
    probe(): ExtSourceProbe {
      let count = 0, wm = 0;
      try {
        for (const f of readdirSync(dir())) {
          if (!f.endsWith(".jsonl")) continue;
          count++;
          wm = Math.max(wm, statSync(join(dir(), f)).mtimeMs);
        }
      } catch { /* unreadable */ }
      return { ok: count > 0, count, watermarkMs: wm };
    },
    list(): ExtSessionRef[] {
      const out: ExtSessionRef[] = [];
      try {
        for (const f of readdirSync(dir())) {
          if (f.endsWith(".jsonl")) out.push({ sid: f.replace(/\.jsonl$/, ""), path: join(dir(), f) });
        }
      } catch { /* unreadable */ }
      return out;
    },
    ...artifactPrimitives(),
    capabilities: artifactCapabilities(),
    parse(ref) {
      let raw = ""; try { raw = readFileSync(ref.path, "utf8"); } catch { return null; }
      const messages: IndexedMessage[] = [];
      let created: string | undefined;
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let e: GooseLine; try { e = JSON.parse(line) as GooseLine; } catch { continue; }
        const role = e.role === "assistant" ? "assistant" : "user";
        const text = textOf(e.content).trim();
        if (!text) continue;
        if (e.created && !created) created = new Date(e.created * 1000).toISOString();
        messages.push({ entryId: `${messages.length + 1}`, role, ts: e.created ? new Date(e.created * 1000).toISOString() : null, text });
      }
      const mtimeIso = (() => { try { return statSync(ref.path).mtime.toISOString(); } catch { return new Date().toISOString(); } })();
      return buildMeta(ref, "", undefined, created, mtimeIso, messages);
    },
  };
}

/* ── Amp ── */
interface AmpThread {
  title?: string;
  messages?: Array<{ role?: string; content?: unknown }>;
  created?: string;
  updated?: string;
}

function ampThreadFiles(): string[] {
  const out: string[] = [];
  const central = join(homedir(), ".local", "share", "amp", "threads");
  if (existsSync(central)) {
    for (const f of readdirSync(central)) {
      if (f.endsWith(".json")) out.push(join(central, f));
    }
  }
  // vscode-family globalStorage migration targets
  for (const host of ["Code", "Code - Insiders", "VSCodium", "Cursor"]) {
    const t3 = join(homedir(), ".config", host, "User", "globalStorage", "sourcegraph.amp", "threads3");
    if (existsSync(t3)) {
      for (const f of readdirSync(t3)) {
        if (f.endsWith(".json")) out.push(join(t3, f));
      }
    }
  }
  return out;
}

export function createAmpAdapter(): AgentAdapter {
  return {
    id: "amp",
    listFresh() { return statFreshList(this.list()); },
    label: "Amp",
    roots() {
      const r = join(homedir(), ".local", "share", "amp");
      return existsSync(r) ? [r] : [];
    },
    probe(): ExtSourceProbe {
      let count = 0, wm = 0;
      for (const f of ampThreadFiles()) {
        count++;
        try { wm = Math.max(wm, statSync(f).mtimeMs); } catch { /* raced */ }
      }
      return { ok: count > 0, count, watermarkMs: wm };
    },
    list(): ExtSessionRef[] {
      return ampThreadFiles().map((p) => ({ sid: p.split("/").pop()!.replace(/\.json$/, ""), path: p }));
    },
    ...artifactPrimitives(),
    capabilities: artifactCapabilities(),
    parse(ref) {
      let doc: AmpThread;
      try { doc = JSON.parse(readFileSync(ref.path, "utf8")) as AmpThread; } catch { return null; }
      const messages: IndexedMessage[] = [];
      for (const m of doc.messages ?? []) {
        const role = m.role === "assistant" ? "assistant" : m.role === "user" ? "user" : null;
        if (!role) continue;
        const text = textOf(m.content).trim();
        if (!text) continue;
        messages.push({ entryId: `${messages.length + 1}`, role, ts: null, text });
      }
      const mtimeIso = (() => { try { return statSync(ref.path).mtime.toISOString(); } catch { return new Date().toISOString(); } })();
      return buildMeta(ref, "", doc.title || undefined, doc.created, doc.updated ?? mtimeIso, messages);
    },
  };
}

/* ── Factory droid ── */
interface FactoryLine { role?: string; content?: unknown; timestamp?: string }

export function createFactoryAdapter(): AgentAdapter {
  const dir = () => join(homedir(), ".factory", "sessions");
  return {
    id: "factory",
    listFresh() { return statFreshList(this.list()); },
    label: "Factory",
    roots() { const d = dir(); return existsSync(d) ? [d] : []; },
    probe(): ExtSourceProbe {
      let count = 0, wm = 0;
      try {
        for (const f of readdirSync(dir())) {
          if (!f.endsWith(".jsonl")) continue;
          count++;
          wm = Math.max(wm, statSync(join(dir(), f)).mtimeMs);
        }
      } catch { /* unreadable */ }
      return { ok: count > 0, count, watermarkMs: wm };
    },
    list(): ExtSessionRef[] {
      const out: ExtSessionRef[] = [];
      try {
        for (const f of readdirSync(dir())) {
          if (f.endsWith(".jsonl")) out.push({ sid: f.replace(/\.jsonl$/, ""), path: join(dir(), f) });
        }
      } catch { /* unreadable */ }
      return out;
    },
    ...artifactPrimitives(),
    capabilities: artifactCapabilities(),
    parse(ref) {
      let raw = ""; try { raw = readFileSync(ref.path, "utf8"); } catch { return null; }
      const messages: IndexedMessage[] = [];
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let e: FactoryLine; try { e = JSON.parse(line) as FactoryLine; } catch { continue; }
        const role = e.role === "assistant" ? "assistant" : "user";
        const text = textOf(e.content).trim();
        if (!text) continue;
        messages.push({ entryId: `${messages.length + 1}`, role, ts: e.timestamp ?? null, text });
      }
      const mtimeIso = (() => { try { return statSync(ref.path).mtime.toISOString(); } catch { return new Date().toISOString(); } })();
      return buildMeta(ref, "", undefined, mtimeIso, mtimeIso, messages);
    },
  };
}
