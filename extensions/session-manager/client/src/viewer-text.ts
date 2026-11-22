/**
 * session-manager · 查看器消息区纯函数（无 JSX / 无宿主依赖，可在 node 单测）。
 * 被 viewer-messages.tsx 消费；规则见 docs/session-manager-viewer-chat-plan.md §3.3。
 */

export type ViewerRole = "user" | "assistant" | "toolResult";

export interface ViewerMsgLike {
  role: string;
  ts?: string | null;
  model?: string;
  text?: string;
  tool?: { name: string; input: Record<string, unknown> | null; output?: string; isError?: boolean } | null;
}

/** 正文折叠阈值：超过任一即折叠 */
export const CLAMP_CHARS = 1500;
export const CLAMP_LINES = 24;
/** 工具卡展开态最多渲染的行数 */
export const TOOL_MAX_LINES = 400;
/** 工具卡折叠态首行预览截断 */
export const TOOL_PREVIEW_CHARS = 120;

export function roleOf(m: ViewerMsgLike): ViewerRole {
  if (m.role === "user") return "user";
  if (m.role === "toolResult") return "toolResult";
  return "assistant";
}

/** 工具卡：toolResult 行，或 opencode 系 adapter 带结构化 tool 的 assistant 行 */
export function isToolCard(m: ViewerMsgLike): boolean {
  return roleOf(m) === "toolResult" || !!m.tool;
}

/** 过滤/统计用的桶：工具卡一律归 toolResult */
export function bucketOf(m: ViewerMsgLike): ViewerRole {
  return isToolCard(m) ? "toolResult" : roleOf(m);
}

export function parseTs(ts?: string | null): Date | null {
  if (!ts) return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 本地日期键 YYYY-MM-DD（日期分隔线用）；无效/缺失 → "" */
export function dayKey(ts?: string | null): string {
  const d = parseTs(ts);
  if (!d) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 本地 HH:mm；无效/缺失 → "" */
export function fmtTime(ts?: string | null): string {
  const d = parseTs(ts);
  if (!d) return "";
  try { return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }); }
  catch { return d.toISOString().slice(11, 16); }
}

/** "bigmodel/GLM-5.3" → "GLM-5.3"；无 "/" 原样 */
export function shortModel(model?: string): string {
  if (!model) return "";
  const i = model.lastIndexOf("/");
  return i >= 0 ? model.slice(i + 1) : model;
}

export function countLines(s: string): number {
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

export function firstLine(s: string): string {
  const i = s.indexOf("\n");
  return (i === -1 ? s : s.slice(0, i)).trim();
}

export function isLong(text: string): boolean {
  return text.length > CLAMP_CHARS || countLines(text) > CLAMP_LINES;
}

/** 折叠预览：先按行截，再按字符截，末尾加 … */
export function clampText(text: string): string {
  let out = text;
  const lines = out.split("\n");
  if (lines.length > CLAMP_LINES) out = lines.slice(0, CLAMP_LINES).join("\n");
  if (out.length > CLAMP_CHARS) out = out.slice(0, CLAMP_CHARS);
  return out + "…";
}

/** 把正文按「🛠 调用行」/「普通段落」分段（相邻同类行合并为一块） */
export function splitToolLines(text: string): Array<{ tool: boolean; text: string }> {
  const out: Array<{ tool: boolean; text: string }> = [];
  for (const line of text.split("\n")) {
    const tool = line.startsWith("🛠 ");
    const last = out[out.length - 1];
    if (last && last.tool === tool) last.text += "\n" + line;
    else out.push({ tool, text: line });
  }
  return out;
}

export function safeJson(v: unknown): string {
  try { return JSON.stringify(v, null, 2) ?? ""; } catch { return String(v); }
}

/** 工具卡的文本视图：结构化 tool → 输入/输出两段；toolResult → text */
export function toolCardText(m: ViewerMsgLike): { inText: string; outText: string; full: string } {
  const inText = m.tool?.input ? safeJson(m.tool.input) : "";
  const outText = m.tool ? (m.tool.output ?? "") : String(m.text ?? "");
  const full = m.tool ? [inText, outText].filter(Boolean).join("\n") : outText;
  return { inText, outText, full };
}

/** 搜索匹配的文本面（结构化 tool 把名字/输入/输出都算进去） */
export function searchHaystack(m: ViewerMsgLike): string {
  return m.tool
    ? `${m.tool.name}\n${safeJson(m.tool.input)}\n${m.tool.output ?? ""}\n${m.text ?? ""}`
    : String(m.text ?? "");
}
