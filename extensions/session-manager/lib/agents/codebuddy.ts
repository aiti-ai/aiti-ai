/**
 * session-manager — CodeBuddy Code（腾讯 cbc）adapter。
 *
 * 存储：~/.codebuddy/projects/<cwd-encoded>/<sid>.jsonl（官方 codebuddy-dir.md + 2.148.0
 * 实测样本钉死）。⚠ 行形状与 claude 家族**不同构**（2026-09-10 实测），不能走
 * createClaudeLikeAdapter 一行注册——差别三处：
 *   1. 会话行 type:"message"，role/content 在**行顶层**（非 message 内层）；
 *      content 块为 OpenAI Responses 风格：input_text/output_text（text 兼容）、tool_use。
 *   2. timestamp 是**数字 epoch 毫秒**（非 ISO 字符串）。
 *   3. 项目目录编码**无前导 "-"**（/tmp/workbuddy-probe → tmp-workbuddy-probe；claude 是
 *      -tmp-workbuddy-probe）。uuid/isSidechain/isMeta 字段位存在但恒 null——行内有 id/parentId。
 * 其余行型（file-history-snapshot / status 等）跳过；会话行自带 cwd（路径解码仅兜底）。
 *
 * 注意区分：cbc 的 **stream-json 输出**（live 驱动，aiti-codebuddy-agent 消费）与 CC 完全同形，
 * 与本存储格式无关——两套形状由 cbc 内部互转，实测见 docs/aiti-codebuddy-agent-plan.md §1。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, ExtSessionRef, ExtSourceProbe } from "./types.ts";
import { statFreshList } from "./fresh.ts";
import type { IndexedMessage } from "../session-file.ts";

const SID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

interface CbcBlock {
  type?: string;
  text?: unknown;
  name?: unknown;
  input?: unknown;
  filename?: unknown;
  mime?: unknown;
}

interface CbcLine {
  type?: string;
  role?: string;
  model?: unknown;
  content?: unknown;
  timestamp?: unknown;
  cwd?: string;
  sessionId?: string;
  status?: string;
  // function_call / function_call_result 行（实测 01a08c20 会话，Bash 工具轮）
  callId?: unknown;
  name?: unknown;
  arguments?: unknown;
  output?: { type?: unknown; text?: unknown } | unknown;
  providerData?: { model?: unknown; modelId?: unknown; error?: { message?: unknown } };
  message?: { role?: unknown; content?: unknown; model?: unknown };
}

/** 数字毫秒 / ISO 字符串双吃 → ISO（解析失败返回 null，调用方跳过该时间戳）。 */
function toIso(ts: unknown): string | null {
  if (typeof ts === "number" && Number.isFinite(ts) && ts > 0) {
    return new Date(ts).toISOString();
  }
  if (typeof ts === "string" && ts) {
    const ms = Date.parse(ts);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return null;
}

/**
 * cbc 块数组 → 展示文本 + 结构化工具行。input_text/output_text/text 合并；
 * tool_use 摘要为 🛠 行（对齐 claude-like 的 blockText 语义）。
 */
function blockText(content: unknown): { text: string; toolName?: string } {
  if (typeof content === "string") return { text: content };
  if (!Array.isArray(content)) return { text: "" };
  const parts: string[] = [];
  let toolName: string | undefined;
  for (const b of content as CbcBlock[]) {
    if (!b || typeof b !== "object") continue;
    if ((b.type === "input_text" || b.type === "output_text" || b.type === "text") && typeof b.text === "string") {
      parts.push(b.text);
    } else if (b.type === "tool_use" && typeof b.name === "string") {
      toolName ??= b.name;
      const args = typeof b.input === "string" ? b.input : b.input ? JSON.stringify(b.input) : "";
      parts.push(`🛠 ${b.name}${args ? ` ${args.slice(0, 400)}` : ""}`);
    } else if (b.type === "input_file" || b.type === "image") {
      const fname = typeof b.filename === "string" ? b.filename : "";
      parts.push(`📎 ${fname || String(b.mime ?? "附件")}`);
    }
    // tool_result/thinking 块不在主时间线展示（与 claude-like 同语义）
  }
  return { text: parts.join("\n"), toolName };
}

/** 行内模型：顶层 model → message.model → providerData.model/modelId（实测顶层字段位存在；
 *  reasoning/function_call 行的 model 在 providerData——2026-09-11 工具会话实测）。 */
function rowModel(e: CbcLine): string {
  for (const v of [e.model, e.message?.model, e.providerData?.model, e.providerData?.modelId]) {
    if (typeof v === "string" && v) return v;
  }
  return "";
}

/** function_call 行的 arguments（JSON 字符串）→ 对象；解析失败原样包 input string。 */
function parseCallArguments(args: unknown): Record<string, unknown> {
  if (args && typeof args === "object" && !Array.isArray(args)) return args as Record<string, unknown>;
  if (typeof args === "string" && args.trim()) {
    try {
      const v = JSON.parse(args) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch { /* 非 JSON → 字符串兜底 */ }
  }
  return { raw: args };
}

export function createCodebuddyAdapter(): AgentAdapter {
  // AITI_CODEBUDDY_HOME：测试隔离口（对齐 zcode adapter 的 AITI_ZCODE_HOME 先例）
  const root = () => process.env.AITI_CODEBUDDY_HOME
    ? join(process.env.AITI_CODEBUDDY_HOME, "projects")
    : join(homedir(), ".codebuddy", "projects");
  return {
    id: "codebuddy",
    label: "CodeBuddy Code",
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
      let cwd = ""; // 行内 cwd 权威；路径解码有损（目录名含字面 "-" 即失真），仅兜底
      let firstMessage = "";
      let lastMessage = "";
      let model = "";
      let messageCount = 0;
      const messages: IndexedMessage[] = [];
      // function_call.callId → 该行（function_call_result 折叠 output 用）
      const pendingToolOutput = new Map<string, IndexedMessage>();

      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let e: CbcLine;
        try { e = JSON.parse(line) as CbcLine; } catch { continue; }
        const ts = toIso(e.timestamp);
        if (ts) {
          if (!created) created = ts;
          if (ts > modified) modified = ts;
        }
        if (e.cwd && !cwd) cwd = e.cwd; // 行内 cwd 权威（路径解码仅兜底）

        // 工具调用（OpenAI Responses 风格独立行，2026-09-11 工具会话实测）：
        // function_call → assistant 🛠 行（tool 结构化）；function_call_result 折叠进
        // 同 callId 的 tool.output（孤儿 → 独立 toolResult 行）；reasoning → 仅取 model。
        if (e.type === "function_call") {
          const name = typeof e.name === "string" ? e.name : "";
          if (!name) continue;
          const m = rowModel(e);
          if (m) model = m;
          const callId = typeof e.callId === "string" ? e.callId : "";
          messageCount++;
          const args = parseCallArguments(e.arguments);
          const argsStr = typeof e.arguments === "string" ? e.arguments : JSON.stringify(e.arguments ?? "");
          messages.push({
            entryId: `${messageCount}`,
            role: "assistant",
            ts,
            ...(m ? { model: m } : {}),
            toolName: name,
            text: `🛠 ${name}${argsStr ? ` ${argsStr.slice(0, 400)}` : ""}`,
            tool: { ...(callId ? { callID: callId } : {}), name, input: args },
          });
          if (callId) pendingToolOutput.set(callId, messages[messages.length - 1]);
          continue;
        }
        if (e.type === "function_call_result") {
          const name = typeof e.name === "string" ? e.name : "";
          const outText = e.output && typeof e.output === "object" && typeof (e.output as { text?: unknown }).text === "string"
            ? (e.output as { text: string }).text
            : typeof e.output === "string" ? e.output : "";
          const callId = typeof e.callId === "string" ? e.callId : "";
          const owner = callId ? pendingToolOutput.get(callId) : undefined;
          if (owner?.tool) {
            owner.tool.output = outText.slice(0, 4000); // 折叠进 tool 行（面板/回放按原生工具卡渲染）
            if (e.status === "failed") owner.tool.isError = true;
            continue;
          }
          // 孤儿结果行：独立 toolResult（copilot/trae 同款，text 截 2000）
          messageCount++;
          messages.push({
            entryId: `${messageCount}`,
            role: "toolResult",
            ts,
            ...(name ? { toolName: name } : {}),
            text: outText.slice(0, 2000),
          });
          continue;
        }
        if (e.type === "reasoning") {
          const m = rowModel(e);
          if (m) model = m; // 思维行不进时间线，但携带真实模型
          continue;
        }
        if (e.type !== "message") continue; // file-history-snapshot / status 等跳过
        const role = e.role === "assistant" ? "assistant" : "user";
        if (e.cwd && !cwd) cwd = e.cwd;
        const m = rowModel(e);
        if (role === "assistant" && m) model = m;

        const { text, toolName } = blockText(e.content);
        if (!text.trim() && !toolName) continue;
        messageCount++;
        if (!firstMessage && role === "user") firstMessage = text.slice(0, 500);
        if (text) lastMessage = text;
        messages.push({
          entryId: `${messageCount}`,
          role,
          ts,
          ...(role === "assistant" && m ? { model: m } : {}),
          ...(toolName ? { toolName } : {}),
          text,
        });
      }

      if (!messages.length) return null;
      const nowIso = new Date().toISOString();
      return {
        meta: {
          path: ref.path,
          id: ref.sid,
          cwd: cwd || decodeCwdFromPath(ref.path),
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

/** `tmp-workbuddy-probe` → `/tmp/workbuddy/probe`（best effort；cbc 编码无前导 "-"，
 *  与 claude 的 `-home-...` 不同——含字面 "-" 的目录名会失真，行内 cwd 字段兜底）。 */
function decodeCwdFromPath(path: string): string {
  const m = path.match(/projects[/\\]([^/\\]+)[/\\]/);
  if (!m) return "";
  return "/" + m[1].replace(/-/g, "/");
}
