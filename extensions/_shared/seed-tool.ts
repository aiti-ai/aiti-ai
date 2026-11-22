/**
 * seed-tool — 索引工具行（session-manager `IndexedMessage.tool`）→ pi 原生工具条目的共享口径。
 *
 * ⚠ 权威源：本文件。zcode / opencode / qoder / codebuddy 四家的 `seedHistory` 曾各存一份
 *   coerce + 回放实现且策略互相漂移（D18：空结果丢/留、input 缺省、model/provider 写法），
 *   codex 更晚（2026-09-22）补上 tool 分支——现五家统一走此处，调用方只保留各自的 id 前缀
 *   与 model/provider 取值。新增/改名导出必须发布新版 ext-shared 并 reconcile，否则运行期
 *   拿到 undefined（同 task-list 教训）。
 *
 * 语义（与 claude-like / opencode-family adapter 的生产端不变量对齐）：
 *  - 带 tool 的行，text 只可能是 🛠 兜底行 → 结构化命中即整体接管该条（调用方 continue，不再出文本）；
 *  - output 缺席 = adapter 没见到 tool_result（轮中途中断/孤儿调用）→ 只回放调用卡，不凭空造结果；
 *  - output 空串 = 工具确实跑完但无文本 → 结果条目给占位文案（与直播路径同口径，卡片不裸奔）。
 */

/** 归一后的工具行（input 恒为对象；output 缺席与空串语义不同，见上）。 */
export interface SeedTool {
  callID?: string;
  name: string;
  input: Record<string, unknown>;
  output?: string;
  isError?: boolean;
}

/** 无文本结果占位（aiti-qoder-agent / aiti-zcode-agent 直播路径既有文案）。 */
export const EMPTY_TOOL_OUTPUT = "(工具执行完成，无文本输出)";
export const EMPTY_TOOL_ERROR = "(工具执行失败)";

/**
 * IndexedMessage.tool → 严格形状。非法（非对象/数组/缺 name）返回 null —— 调用方回退
 * 🛠 文本行展示（老索引、未知格式不丢内容）。
 */
export function normalizeSeedTool(v: unknown): SeedTool | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const t = v as Record<string, unknown>;
  if (typeof t.name !== "string" || !t.name) return null;
  const input = t.input && typeof t.input === "object" && !Array.isArray(t.input)
    ? { ...(t.input as Record<string, unknown>) }
    : {};
  return {
    ...(typeof t.callID === "string" && t.callID ? { callID: t.callID } : {}),
    name: t.name,
    input,
    ...(typeof t.output === "string" ? { output: t.output } : {}),
    ...(t.isError === true ? { isError: true } : {}),
  };
}

/** 工具结果条目的文本：空白结果按成败/失败给占位，避免宿主渲出无内容的空卡。 */
export function seedToolResultText(tool: SeedTool): string {
  const out = tool.output ?? "";
  return out.trim() ? out : (tool.isError ? EMPTY_TOOL_ERROR : EMPTY_TOOL_OUTPUT);
}

/**
 * 一次 `seedHistory` 的回放器（callID 缺席时按前缀合成配对 id，故计数须随调用周期新建）。
 * `entries()` 返回 null 表示该行不是结构化工具行，调用方自行走文本兜底。
 */
export function createSeedToolReplay(idPrefix: string): {
  entries(tool: unknown, opts?: { model?: string; provider?: string }): Array<Record<string, unknown>> | null;
} {
  let seq = 0;
  return {
    entries(tool: unknown, opts?: { model?: string; provider?: string }): Array<Record<string, unknown>> | null {
      const t = normalizeSeedTool(tool);
      if (!t) return null;
      const callId = t.callID || `${idPrefix}-${++seq}`;
      const items: Array<Record<string, unknown>> = [
        {
          role: "assistant",
          content: [{ type: "toolCall", toolCallId: callId, toolName: t.name, input: t.input }],
          ...(opts?.model !== undefined ? { model: opts.model } : {}),
          ...(opts?.provider !== undefined ? { provider: opts.provider } : {}),
        },
      ];
      if (t.output !== undefined) {
        items.push({
          role: "toolResult",
          toolCallId: callId,
          toolName: t.name,
          content: [{ type: "text", text: seedToolResultText(t) }],
          ...(t.isError ? { isError: true } : {}),
        });
      }
      return items;
    },
  };
}
