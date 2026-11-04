/**
 * session-manager — convert an external agent session into a native pi session.
 *
 * Conversion = creating a NEW pi .jsonl file (the external artifact is never
 * touched). The imported session lands in the ORIGINAL project cwd so it shows
 * up in that project's sidebar naturally; the name gets an "[agent]" prefix;
 * a session_info line records provenance for idempotency (§4.5 of the plan).
 *
 * Tool calls degrade to `🛠 name(args)` text blocks on purpose: cross-agent
 * tool semantics don't map 1:1, and the goal is "hand over context, keep
 * chatting" — not lossless replay.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ParsedExtSession } from "./types.ts";

export interface ImportResult {
  sessionId: string;
  path: string;
}

/**
 * Encode cwd the way pi does: /home/w/x → --home-wind-x (leading + trailing dash).
 * 清洗正则对齐宿主 SDK（pi-coding-agent dist/core/session-manager.js:245，lessons §0.3）：
 * 剥一个前导 / 或 \，[/\: → -（盘符冒号一并清洗）——C:\Users\user → --C--Users-user--
 * （155 实证宿主即该形态；旧实现只 replace /，win 下产出含 :\ 的非法 slug）。
 */
export function encodeCwd(cwd: string): string {
  return "--" + cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--";
}

/** pi filename timestamp: 2026-08-17T00-27-14-727Z (dashes inside the time part). */
function fileNameTs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return new Date().toISOString().replace(/:/g, "-").replace(/\./g, "-");
  return d.toISOString().replace(/^(\d{4}-\d{2}-\d{2}T)(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/, "$1$2-$3-$4-$5Z");
}

function line(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

/**
 * Write the converted session file. Returns null when the target already
 * exists (shouldn't happen — we mint a fresh uuid) or cwd is missing.
 */
export function writePiSession(parsed: ParsedExtSession, opts: {
  homeDir: string;
  agentId: string;
  sourceSid: string;
  sourcePath?: string;
  /** Used when the source records no project path (e.g. Zed global threads). */
  fallbackCwd?: string;
}): ImportResult | null {
  const cwd = parsed.meta.cwd || opts.fallbackCwd || "";
  if (!cwd) return null;

  const dir = join(opts.homeDir, ".pi", "agent", "sessions", encodeCwd(cwd));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const sessionId = randomUUID();
  const createdIso = parsed.meta.created || new Date().toISOString();
  const path = join(dir, `${fileNameTs(createdIso)}_${sessionId}.jsonl`);

  const namePrefix = `[${opts.agentId}] `;
  const baseName = parsed.meta.name ?? parsed.meta.firstMessage.slice(0, 60) ?? "";
  const lines: string[] = [];

  lines.push(line({
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: createdIso,
    cwd,
  }));
  lines.push(line({
    type: "session_info",
    name: namePrefix + baseName.trim(),
    importedFrom: `${opts.agentId}:${opts.sourceSid}`,
    sourcePath: opts.sourcePath ?? parsed.meta.path,
    importedAt: new Date().toISOString(),
  }));

  let seq = 0;
  for (const m of parsed.messages) {
    seq++;
    const role = m.role === "toolResult" ? "toolResult" : m.role;
    // Tool results collapse into the assistant narration as pseudo-text too
    // (they usually follow a 🛠 line); keep user/assistant/toolResult roles only.
    if (role !== "user" && role !== "assistant") continue;
    lines.push(line({
      type: "message",
      id: randomUUID(),
      timestamp: m.ts ?? createdIso,
      message: {
        role,
        content: [{ type: "text", text: m.text }],
        ...(m.model ? { model: m.model } : {}),
      },
    }));
  }

  try {
    writeFileSync(path, lines.join(""), { flag: "wx" });
  } catch {
    return null; // exists or unwritable — treat as failure, never overwrite
  }
  void seq;
  return { sessionId, path };
}
