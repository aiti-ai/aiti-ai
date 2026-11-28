/**
 * seed-tool — shared convention for converting an indexed tool row (session-manager
 * `IndexedMessage.tool`) into pi-native tool entries.
 *
 * ⚠ Authoritative source: this file. zcode / opencode / qoder / codebuddy each used to carry their
 *   own coerce + replay implementation with drifting policies (D18: empty results dropped/kept,
 *   default input, model/provider spellings); codex added its tool branch later (2026-09-22) — all
 *   five now go through this module; callers keep only their own id prefix and model/provider
 *   conventions. Adding/renaming exports requires publishing a new ext-shared version and
 *   reconciling, or the runtime gets undefined (same lesson as task-list).
 *
 * Semantics (aligned with the producer invariants of the claude-like / opencode-family adapters):
 *  - for rows carrying a tool, text can only be a 🛠 fallback line → a structured hit takes over the
 *    whole entry (the caller continues, no more text is emitted);
 *  - absent output = the adapter never saw the tool_result (mid-turn interruption/orphan call) →
 *    replay only the call card, never invent a result;
 *  - empty-string output = the tool really finished with no text → the result entry gets placeholder
 *    copy (same convention as the live path, so cards never render bare).
 */

/** Normalized tool row (input is always an object; absent output and empty-string output differ semantically, see above). */
export interface SeedTool {
  callID?: string;
  name: string;
  input: Record<string, unknown>;
  output?: string;
  isError?: boolean;
}

/** Placeholder for text-less results (existing copy of the aiti-qoder-agent / aiti-zcode-agent live paths). */
export const EMPTY_TOOL_OUTPUT = "(工具执行完成，无文本输出)";
export const EMPTY_TOOL_ERROR = "(工具执行失败)";

/**
 * IndexedMessage.tool -> strict shape. Returns null when invalid (non-object/array/missing name) —
 * the caller falls back to rendering the 🛠 text line (old indexes, unknown formats never lose content).
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

/** Text of a tool-result entry: blank results get a placeholder by success/failure so the host never renders an empty card. */
export function seedToolResultText(tool: SeedTool): string {
  const out = tool.output ?? "";
  return out.trim() ? out : (tool.isError ? EMPTY_TOOL_ERROR : EMPTY_TOOL_OUTPUT);
}

/**
 * A replayer for one `seedHistory` pass (when callID is absent a paired id is synthesized from the
 * prefix, so the counter must be created fresh per call cycle).
 * `entries()` returning null means the row is not a structured tool row; the caller handles its own
 * text fallback.
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
