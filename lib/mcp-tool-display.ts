// Display names for MCP tools. pi registers them as `mcp__<server>__<tool>`,
// sanitized to `[A-Za-z0-9_-]` and shortened with a hash past 64 characters;
// pi's TUI labels them `server/tool` instead. A result carries the real names
// in its details (`{ server, tool }`), which win over parsing the tool name.

const MCP_TOOL_NAME = /^mcp__(.+?)__(.+)$/;
/** Larger results are shown as the server sent them. */
const PRETTY_JSON_MAX_CHARS = 200_000;

export interface McpToolLabel {
  server: string;
  tool: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The server and tool of an MCP tool call, or null for any other tool. */
export function mcpToolLabel(toolName: string, details?: unknown): McpToolLabel | null {
  const match = MCP_TOOL_NAME.exec(toolName);
  if (!match) return null;
  if (isRecord(details) && typeof details.server === "string" && typeof details.tool === "string") {
    return { server: details.server, tool: details.tool };
  }
  return { server: match[1], tool: match[2] };
}

/** `server/tool` for an MCP tool, the name itself for any other. */
export function toolDisplayName(toolName: string, details?: unknown): string {
  const label = mcpToolLabel(toolName, details);
  return label ? `${label.server}/${label.tool}` : toolName;
}

/**
 * MCP servers often answer with one JSON document as text, compacted. Show it
 * indented; anything else, including JSON surrounded by other text, as sent.
 */
export function prettyMcpResultText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length > PRETTY_JSON_MAX_CHARS || !/^[[{]/.test(trimmed)) return text;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}
