/**
 * session-manager — Claude-Code-family JSONL adapter (Claude Code + Qoder).
 *
 * Both tools store one .jsonl per session under `<root>/<cwd-encoded>/`:
 *   ~/.claude/projects/-home-wind-workspace-x/<uuid>.jsonl
 *   ~/.qoder/projects/-home-wind-workspace-x/<uuid>.jsonl
 *
 * Line shape (verified 2026-08 against real files of both tools):
 *   {type:"user"|"assistant"|"queue-operation"|..., message:{role,content},
 *    timestamp, cwd, sessionId, uuid, isSidechain?, isMeta?}
 * Content: string OR array of blocks ({type:"text",text}|{type:"tool_use",
 *   name,input}|{type:"tool_result",content}|{type:"thinking",...}|{type:"image"}).
 *
 * Tolerance rule (plan §7): unknown line types are skipped; a dirty line never
 * drops the whole session. Sidechain (subagent) lines are filtered from the
 * main timeline; isMeta injected caveats are skipped too.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { AgentAdapter, ExtSessionRef, ExtSourceProbe } from "./types.ts";
import { statFreshList } from "./fresh.ts";
import type { IndexedMessage } from "../session-file.ts";

const SID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

interface ParsedLine {
  type?: string;
  timestamp?: string;
  cwd?: string;
  sessionId?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  message?: { role?: string; content?: unknown; model?: unknown };
}

/** 工具结果进回放的上限（接管时整段历史一次性进 handle 内存，单条巨型输出会撑爆负载）。 */
const TOOL_RESULT_MAX = 4000;

/** tool_result.content：字符串或 text 块数组两种形态 → 纯文本。 */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (b && typeof b === "object" && (b as { type?: string }).type === "text"
      && typeof (b as { text?: unknown }).text === "string") parts.push((b as { text: string }).text);
  }
  return parts.join("\n");
}

/** tool_use.input：对象直取；JSON 字符串解析；其余 → null（结构化让位给 🛠 文本行）。 */
function toolInput(input: unknown): Record<string, unknown> | null {
  if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>;
  if (typeof input === "string" && input.trim()) {
    try {
      const parsed = JSON.parse(input) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* 非 JSON 入参 */ }
  }
  return null;
}

function blockText(content: unknown): { text: string; toolName?: string; tool?: IndexedMessage["tool"] } {
  if (typeof content === "string") return { text: content };
  if (!Array.isArray(content)) return { text: "" };
  const parts: string[] = [];
  let toolName: string | undefined;
  let tool: IndexedMessage["tool"] | undefined;
  let toolCount = 0;
  let hasText = false;
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    const blk = b as Record<string, unknown>;
    if (blk.type === "text" && typeof blk.text === "string") {
      parts.push(blk.text);
      hasText = true;
    } else if (blk.type === "tool_use" && typeof blk.name === "string") {
      toolCount++;
      toolName ??= blk.name;
      const args = typeof blk.input === "string" ? blk.input : blk.input ? JSON.stringify(blk.input) : "";
      parts.push(`🛠 ${blk.name}${args ? ` ${args.slice(0, 400)}` : ""}`);
      tool ??= {
        ...(typeof blk.id === "string" && blk.id ? { callID: blk.id } : {}),
        name: blk.name,
        input: toolInput(blk.input) ?? {},
      };
    }
    // tool_result/thinking/image blocks intentionally skipped on assistant rows;
    // user-side tool results are handled by the caller via role mapping.
  }
  // 单工具且该行无正文才带 tool：消费方（seedHistory）命中 tool 就跳过 text，混排行带上
  // 会把正文丢掉。CC 族实测从不混排（2026-09-21 抽样 40 个会话 2596 条工具行 0 例）。
  return { text: parts.join("\n"), ...(toolName ? { toolName } : {}), ...(toolCount === 1 && !hasText ? { tool } : {}) };
}

export function createClaudeLikeAdapter(id: string, label: string, homeSubpath: string, projectsDir: string): AgentAdapter {
  const root = () => join(homedir(), homeSubpath, projectsDir);
  return {
    id,
    label,
    roots() {
      const r = root();
      return existsSync(r) ? [r] : [];
    },

    probe(): ExtSourceProbe {
      const r = root();
      if (!existsSync(r)) return { ok: false, count: 0, watermarkMs: 0 };
      let count = 0;
      let watermarkMs = 0;
      try {
        for (const dir of readdirSync(r)) {
          const d = join(r, dir);
          let st;
          try { st = statSync(d); } catch { continue; }
          if (!st.isDirectory()) continue;
          watermarkMs = Math.max(watermarkMs, st.mtimeMs);
          try {
            for (const f of readdirSync(d)) {
              if (!f.endsWith(".jsonl")) continue;
              count++;
              try { watermarkMs = Math.max(watermarkMs, statSync(join(d, f)).mtimeMs); } catch { /* raced */ }
            }
          } catch { /* unreadable project dir */ }
        }
      } catch { /* unreadable root */ }
      return { ok: true, count, watermarkMs };
    },

    listFresh() { return statFreshList(this.list()); },

    // ── A03 真归档原语（文件型 artifact 粒度）：快照原始字节 → unlink → 原路径写回。
    //  核查点（§4 表）：claude-like 家族无 __store.db 类 sidecar 索引——删文件即从源消失。──
    capabilities: { remove: true, putBack: true, granularity: "artifact" },
    snapshot(ref) {
      try { return { bytes: readFileSync(ref.path), layout: ref.path }; } catch { return null; }
    },
    removeSession(ref) {
      rmSync(ref.path, { force: true }); // 幂等：不存在=成功
    },
    putBack(_sid, snap) {
      mkdirSync(dirname(snap.layout), { recursive: true });
      writeFileSync(snap.layout, snap.bytes);
    },
    list(): ExtSessionRef[] {
      const out: ExtSessionRef[] = [];
      const r = root();
      if (!existsSync(r)) return out;
      for (const dir of readdirSync(r)) {
        const d = join(r, dir);
        try {
          if (!statSync(d).isDirectory()) continue;
        } catch { continue; }
        for (const f of readdirSync(d)) {
          const m = SID_RE.exec(f);
          if (m) out.push({ sid: m[1], path: join(d, f) });
        }
      }
      return out;
    },

    parse(ref): ReturnType<AgentAdapter["parse"]> {
      let raw: string;
      try { raw = readFileSync(ref.path, "utf8"); } catch { return null; }
      if (!raw) return null;
      let created = "";
      let modified = "";
      let cwd = decodeCwdFromPath(ref.path);
      // jsonl 行内 cwd 是权威（目录名含 - 时路径解码有损：dl-carbon-expert-all →
      // dl/carbon/expert/all，2026-09-16 实测咬人——冷恢复/resume 工作区对齐用它）。
      let recordCwd = "";
      let firstMessage = "";
      let lastMessage = "";
      let model = "";
      let messageCount = 0;
      const messages: IndexedMessage[] = [];
      // callID → 已发出的结构化工具行（tool_result 落在其后的 user 行，回填 output/isError）。
      const openTools = new Map<string, IndexedMessage["tool"]>();

      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let e: ParsedLine;
        try { e = JSON.parse(line) as ParsedLine; } catch { continue; }
        // Only user/assistant conversation lines carry a message payload.
        if ((e.type !== "user" && e.type !== "assistant") || !e.message || typeof e.message.role !== "string") continue;
        if (e.isSidechain) continue; // subagent side-chain — not the main timeline
        if (e.timestamp) {
          if (!created) created = e.timestamp;
          if (e.timestamp > modified) modified = e.timestamp;
        }
        if (e.cwd && !recordCwd) recordCwd = e.cwd;

        // 工具结果先配对再走正文（这类 user 行正文为空，下面会被跳过）。
        if (Array.isArray(e.message.content)) {
          for (const b of e.message.content as Array<Record<string, unknown>>) {
            if (!b || b.type !== "tool_result") continue;
            const open = openTools.get(String(b.tool_use_id ?? ""));
            if (!open) continue;
            openTools.delete(String(b.tool_use_id ?? ""));
            const out = toolResultText(b.content).trim();
            if (!out) continue;
            open.output = out.slice(0, TOOL_RESULT_MAX);
            if (b.is_error === true) open.isError = true;
          }
        }

        if (e.isMeta) continue; // injected caveats/command echoes — noise in the viewer
        const role = e.message.role === "assistant" ? "assistant" : "user";
        // 会话真实模型：最近一条 assistant 行的 message.model（CC jsonl 实测带，如 "glm-5.2"）
        if (role === "assistant" && typeof e.message.model === "string" && e.message.model) model = e.message.model;
        const { text, toolName, tool } = blockText(e.message.content);
        if (!text.trim()) continue;
        messageCount++;
        if (!firstMessage && role === "user") firstMessage = text.slice(0, 500);
        if (text) lastMessage = text;
        messages.push({
          entryId: `${messageCount}`,
          role,
          ts: e.timestamp ?? null,
          text,
          ...(toolName ? { toolName } : {}),
          ...(tool ? { tool } : {}),
        });
        if (tool?.callID) openTools.set(tool.callID, tool);
      }

      if (!messages.length) return null;
      const nowIso = new Date().toISOString();
      return {
        meta: {
          path: ref.path,
          id: ref.sid,
          cwd: recordCwd || cwd || "",
          created: created || nowIso,
          modified: modified || created || nowIso,
          messageCount,
          firstMessage: firstMessage || "(no messages)",
          lastMessage,
          ...(model ? { model } : {}),
        },
        messages,
      };
    },
  };
}

/** `-home-wind-workspace-x` → `/home/pi/workspace/x` (best effort). */
function decodeCwdFromPath(path: string): string {
  const m = path.match(/projects[/\\](-[^/\\]+)[/\\]/);
  if (!m) return "";
  return "/" + m[1].replace(/^-/, "").replace(/-/g, "/");
}
