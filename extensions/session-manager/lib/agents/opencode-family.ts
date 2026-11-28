/**
 * opencode-family —— opencode 系 agent 的 part 归纳器（共享实现）。
 *
 * 适用范围（2026-09 实测对比）：
 *   - opencode legacy storage（目录 JSON：message/<sid>/ + part/<mid>/）
 *   - zcode（~/.zcode/cli/db/db.sqlite 的 message/part 分表，opencode 早期形态的 SQLite 化）
 * 两者 message data 平铺 role/modelID/providerID/time，part 语义同构：
 *   text / reasoning / step-start / step-finish / tool{state{input,output}}。
 * 差异由钩子吸收：zcode 的 file part（zcode-artifact:// 附件）经 onFilePart 注入。
 *
 * 归纳语义（与 session-manager 导入一致：交棒上下文，非无损回放）：
 *   - text 多段合并（\n 连接）
 *   - 工具行独立（🛠 name input → output，toolName 单列）
 *   - reasoning 跳过（保持 viewer 干净）；step-start/step-finish/timeline/patch/compaction 忽略
 *   - 图片经 onFilePart 聚合为 images（data URL），随文本 entry 下发
 */
import type { IndexedMessage } from "../session-file.ts";

export interface OpencodeFamilyImage {
  mime: string;
  filename?: string;
  dataUrl: string;
}

/** 结构化工具调用（回放成 pi 形状 toolCall/toolResult 用；text 行仍是兜底展示）。 */
export interface OpencodeFamilyToolCall {
  /** callID（有则 seedHistory 作 toolCallId，前端按 id 配对工具结果）。 */
  callID?: string;
  name: string;
  input: Record<string, unknown> | null;
  output?: string;
  isError?: boolean;
}

/** 结构化 output 回放上限（state.output 可能极大；超限截断并标注，防 get_messages 整包传输膨胀）。 */
export const TOOL_OUTPUT_SEED_LIMIT = 20_000;

/** 工具 part → 结构化信息（opencode 系 tool part：{callID, tool, state{status,input,output}}）。 */
function structuredTool(p: Record<string, unknown>, name: string): OpencodeFamilyToolCall {
  const state = (p.state ?? {}) as Record<string, unknown>;
  const input = state.input && typeof state.input === "object" && !Array.isArray(state.input)
    ? state.input as Record<string, unknown>
    : null;
  const rawOut = typeof state.output === "string" ? state.output : "";
  const output = rawOut.length > TOOL_OUTPUT_SEED_LIMIT
    ? rawOut.slice(0, TOOL_OUTPUT_SEED_LIMIT) + `\n…（回放截断，原始输出共 ${rawOut.length} 字符）`
    : rawOut;
  return {
    ...(typeof p.callID === "string" && p.callID ? { callID: p.callID } : {}),
    name,
    input,
    ...(output ? { output } : {}),
    ...(state.status === "error" ? { isError: true } : {}),
  };
}

export interface OpencodeFamilyHooks {
  /**
   * file part 钩子（zcode 附件等）。返回 image → 聚合进 images；返回 placeholder
   * 文本 → 并入正文；返回 null → part 忽略。缺省（opencode 无 file part）忽略。
   */
  onFilePart?(part: Record<string, unknown>): { image?: OpencodeFamilyImage; placeholder?: string } | null;
}

export interface FoldedMessageParts {
  /** 工具调用行（每行一个独立 entry，toolName 供徽标/过滤；tool 为结构化信息，回放成 pi 形状用）。 */
  toolLines: Array<{ text: string; toolName: string; tool?: OpencodeFamilyToolCall }>;
  /** 正文文本（多 text part 已合并）。 */
  textAll: string;
  /** 消息内嵌图片。 */
  images: OpencodeFamilyImage[];
  /** 是否存在任何可展示内容（文本/工具行/图片）。 */
  hasContent: boolean;
}

export function foldOpencodeFamilyParts(
  parts: Array<Record<string, unknown>>,
  hooks?: OpencodeFamilyHooks,
): FoldedMessageParts {
  const toolLines: FoldedMessageParts["toolLines"] = [];
  let textAll = "";
  const images: OpencodeFamilyImage[] = [];
  const appendText = (t: string) => {
    textAll += (textAll ? "\n" : "") + t;
  };

  for (const p of parts) {
    const t = p.type as string;
    if (t === "text" && typeof p.text === "string") {
      appendText(p.text);
    } else if (t === "reasoning") {
      continue; // 保持 viewer 干净（opencode 同款）
    } else if (t === "tool" && (typeof p.tool === "string" || typeof (p.state as Record<string, unknown> | undefined)?.title === "string")) {
      const toolName = typeof p.tool === "string" ? p.tool : String((p.state as Record<string, unknown>).title);
      const state = p.state as Record<string, unknown> | undefined;
      const input = state?.input ? JSON.stringify(state.input) : "";
      const output = state?.output;
      const outText = typeof output === "string" ? ` → ${output.slice(0, 200)}` : "";
      toolLines.push({ text: `🛠 ${toolName}${input ? ` ${input.slice(0, 300)}` : ""}${outText}`, toolName, tool: structuredTool(p, toolName) });
    } else if (t === "file" && hooks?.onFilePart) {
      const hit = hooks.onFilePart(p);
      if (hit?.image) images.push(hit.image);
      else if (hit?.placeholder) appendText(hit.placeholder);
    }
    // step-start/step-finish/timeline/patch/compaction 等忽略
  }

  return {
    toolLines,
    textAll,
    images,
    hasContent: toolLines.length > 0 || textAll.trim().length > 0 || images.length > 0,
  };
}

/** 归纳结果 → IndexedMessage[]（工具行独立 entry；图片挂到文本 entry；全空消息产出单个图片 entry）。 */
export function foldedPartsToMessages(
  folded: FoldedMessageParts,
  base: { role: "user" | "assistant"; ts: string | null; model?: string; provider?: string; seqStart: number },
): { messages: IndexedMessage[]; nextSeq: number } {
  const messages: IndexedMessage[] = [];
  let seq = base.seqStart;
  const push = (text: string, toolName?: string, tool?: OpencodeFamilyToolCall) => {
    seq++;
    messages.push({
      entryId: `${seq}`,
      role: base.role,
      ts: base.ts,
      ...(base.model ? { model: base.model } : {}),
      ...(base.provider ? { provider: base.provider } : {}),
      ...(toolName ? { toolName } : {}),
      ...(tool ? { tool } : {}),
      text,
      ...(toolName || folded.images.length === 0 ? {} : { images: [...folded.images] }),
    });
  };
  for (const line of folded.toolLines) push(line.text, line.toolName, line.tool);
  if (folded.textAll.trim() || (!folded.toolLines.length && folded.images.length > 0)) {
    push(folded.textAll);
  }
  return { messages, nextSeq: seq };
}
