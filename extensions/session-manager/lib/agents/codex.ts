/**
 * session-manager — OpenAI Codex CLI adapter.
 *
 * Sessions: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<sid>.jsonl (not
 * installed locally — parsed defensively from the known rollout format):
 *   {type:"session_meta", payload:{id, cwd, ...}}
 *   {type:"response_item", payload:{type:"message", role, content:[{type:"input_text"|"output_text", text}]}}
 *   {type:"event_msg",    payload:{type:"user_message"|"agent_message", message}}
 *   {type:"turn_context", payload:{model, approval_policy, sandbox_policy, ...}} → 取 model 作 meta.model
 *     （会话真实模型源：接管恢复/详情展示消费；行序即时序，最后一个 turn_context 胜出）
 *   {type:"response_item", payload:{type:"function_call", name, arguments:"<JSON 串>", call_id}}
 *   {type:"response_item", payload:{type:"function_call_output", call_id, output:"<串|块数组>"}}
 *     （工具调用与结果各占一行，按 payload.call_id 配对；custom_tool_call(_output) 同构，
 *     入参字段是 input 纯文本——apply_patch 类补丁。2026-09-22 真机取证：隔离 CODEX_HOME
 *     跑 codex_exec 0.149.1 一次带 shell 调用的会话，fixture 见 codex.test.mjs）
 *   ⚠ event_msg/payload={type:"item_completed", item:{type:"CommandExecution", id:<同 call_id>,
 *     aggregated_output, exit_code, ...}} 是同一次调用的**另一份** serde（ThreadItem 用
 *     CamelCase；stdout/exit_code 更干净但语义重复）→ 不入账，避免双卡。
 *     reasoning / web_search_call / image_generation_call 亦跳过：非用户可见对话。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, ExtSessionRef, ExtSourceProbe } from "./types.ts";
import { artifactPrimitives, artifactCapabilities } from "./archive-artifact.ts";
import { statFreshList } from "./fresh.ts";
import type { IndexedMessage } from "../session-file.ts";

const SID_RE = /rollout-[^/]*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function* rolloutFiles(root: string): Generator<string> {
  if (!existsSync(root)) return;
  for (const y of readdirSync(root)) {
    const yp = join(root, y);
    if (!isDir(yp)) continue;
    for (const m of readdirSync(yp)) {
      const mp = join(yp, m);
      if (!isDir(mp)) continue;
      for (const d of readdirSync(mp)) {
        const dp = join(mp, d);
        if (!isDir(dp)) continue;
        for (const f of readdirSync(dp)) {
          if (f.startsWith("rollout-") && f.endsWith(".jsonl")) yield join(dp, f);
        }
      }
    }
  }
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

interface RolloutLine {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    const blk = b as Record<string, unknown>;
    if (typeof blk.text === "string") parts.push(blk.text);
    else if (blk.type === "tool_use" || blk.type === "local_shell_call" || blk.type === "custom_tool_call") {
      parts.push(`🛠 ${String(blk.type)}`);
    }
  }
  return parts.join("\n");
}

/** 工具结果进回放的上限（同 claude-like：接管时整段历史一次性进 handle 内存）。 */
const TOOL_RESULT_MAX = 4000;

/** function_call_output.output：字符串或 content 块数组（FunctionCallOutputBody）→ 纯文本。 */
function toolOutputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return "";
  const parts: string[] = [];
  for (const b of output) {
    if (!b || typeof b !== "object") continue;
    const blk = b as Record<string, unknown>;
    if (typeof blk.text === "string") parts.push(blk.text);
  }
  return parts.join("\n");
}

/** 工具入参：JSON 串（function_call.arguments）解析成对象；补丁类纯文本（custom_tool_call.input）包一层。 */
function toolInput(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return {};
  try {
    const parsed = JSON.parse(s) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* 非 JSON 入参 */ }
  return { input: s };
}

export function createCodexAdapter(): AgentAdapter {
  // 会话根可覆盖（AITI_CODEX_HOME=<codex home>，同 codebuddy/opencode/zcode 惯例；
  //  真机 fixture 测试与自定义 CODEX_HOME 的用户都靠它）。
  const root = () => process.env.AITI_CODEX_HOME
    ? join(process.env.AITI_CODEX_HOME, "sessions")
    : join(homedir(), ".codex", "sessions");
  return {
    id: "codex",
    label: "Codex CLI",
    roots() {
      const r = root();
      return existsSync(r) ? [r] : [];
    },

    probe(): ExtSourceProbe {
      let count = 0;
      let watermarkMs = 0;
      for (const f of rolloutFiles(root())) {
        count++;
        try { watermarkMs = Math.max(watermarkMs, statSync(f).mtimeMs); } catch { /* raced */ }
      }
      return { ok: existsSync(root()), count, watermarkMs };
    },

    listFresh() { return statFreshList(this.list()); },
    list(): ExtSessionRef[] {
      const out: ExtSessionRef[] = [];
      for (const f of rolloutFiles(root())) {
        const m = SID_RE.exec(f.replace(/\\/g, "/"));
        // filename fallback: rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl
        if (m) out.push({ sid: m[1], path: f });
        else {
          const base = f.split("/").pop() ?? "";
          // 文件名词干含时间戳，天然唯一（此分支 = SID_RE 未命中的非标命名）
          const stem = base.replace(/^rollout-/, "").replace(/\.jsonl$/, "");
          if (stem) out.push({ sid: `rollout-${stem}`, path: f });
        }
      }
      return out;
    },

    ...artifactPrimitives(),
    capabilities: artifactCapabilities(),
    parse(ref) {
      let raw: string;
      try { raw = readFileSync(ref.path, "utf8"); } catch { return null; }
      let created = "", modified = "", cwd = "", firstMessage = "", lastMessage = "";
      let model = "";
      let messageCount = 0;
      const messages: IndexedMessage[] = [];
      // call_id → 已发出的结构化工具行（结果行在其后，回填 output；同 claude-like 账本）。
      const openTools = new Map<string, NonNullable<IndexedMessage["tool"]>>();

      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let e: RolloutLine;
        try { e = JSON.parse(line) as RolloutLine; } catch { continue; }
        if (e.timestamp) {
          if (!created) created = e.timestamp;
          if (e.timestamp > modified) modified = e.timestamp;
        }
        if (e.type === "session_meta" && e.payload && typeof e.payload.cwd === "string" && !cwd) {
          cwd = e.payload.cwd;
          continue;
        }
        // 会话真实模型：最后一个 turn_context 的 payload.model（rollout 无 init 帧，这是唯一模型源）
        if (e.type === "turn_context" && e.payload && typeof e.payload.model === "string" && e.payload.model) {
          model = e.payload.model;
        }
        // 工具调用/结果（response_item = 模型可见记录）：调用行自成一条 assistant 消息，
        // 结果行按 call_id 回填到那条的 tool.output —— 消费方（seedHistory）据此回放原生工具卡。
        if (e.type === "response_item" && e.payload) {
          const pt = e.payload.type;
          if (pt === "function_call" || pt === "custom_tool_call") {
            const name = typeof e.payload.name === "string" && e.payload.name ? e.payload.name : String(pt);
            const rawArgs = pt === "custom_tool_call" ? e.payload.input : e.payload.arguments;
            const argsStr = typeof rawArgs === "string" ? rawArgs : rawArgs ? JSON.stringify(rawArgs) : "";
            const callId = typeof e.payload.call_id === "string" ? e.payload.call_id : "";
            const tool: NonNullable<IndexedMessage["tool"]> = {
              ...(callId ? { callID: callId } : {}),
              name,
              input: toolInput(rawArgs),
            };
            messageCount++;
            lastMessage = `🛠 ${name}${argsStr ? ` ${argsStr.slice(0, 400)}` : ""}`;
            messages.push({
              entryId: `${messageCount}`, role: "assistant", ts: e.timestamp ?? null,
              text: lastMessage, toolName: name, tool,
            });
            if (callId) openTools.set(callId, tool);
            continue;
          }
          if (pt === "function_call_output" || pt === "custom_tool_call_output") {
            const key = String(e.payload.call_id ?? "");
            const open = openTools.get(key);
            if (open) {
              openTools.delete(key);
              const out = toolOutputText(e.payload.output).trim();
              if (out) open.output = out.slice(0, TOOL_RESULT_MAX);
            }
            continue;
          }
        }
        let role = "", text = "";
        if (e.type === "response_item" && e.payload && e.payload.type === "message") {
          const plRole = e.payload.role as string;
          if (plRole === "developer") continue; // skills/system instructions — not conversation
          role = plRole === "assistant" ? "assistant" : "user";
          text = extractText(e.payload.content);
          if (role === "user" && text.startsWith("<environment_context>")) continue; // injected cwd block
        } else if (e.type === "event_msg" && e.payload) {
          if (e.payload.type === "user_message") { role = "user"; text = String(e.payload.message ?? ""); }
          else if (e.payload.type === "agent_message") { role = "assistant"; text = String(e.payload.message ?? ""); }
        }
        if (!role || !text.trim()) continue;
        messageCount++;
        if (!firstMessage && role === "user") firstMessage = text.slice(0, 500);
        lastMessage = text;
        messages.push({ entryId: `${messageCount}`, role, ts: e.timestamp ?? null, text });
      }

      if (!messages.length) return null;
      const nowIso = new Date().toISOString();
      return {
        meta: {
          path: ref.path,
          id: ref.sid,
          cwd,
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
