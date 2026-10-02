// Who owns `/mcp`, decided the same way on the server and in the browser.
//
// The SDK loads pi's built-in MCP extension under the extension path
// `builtin:mcp`, and every command and tool it registers carries that path as
// its `sourceInfo.path`; `get_commands` hands the same field to the browser. A
// third-party extension that registers `/mcp` replaces the built-in one
// outright (the SDK drops a replaceable built-in that shares a command name),
// so the two never appear side by side. When several extensions register
// `/mcp`, pi names them `mcp:1`, `mcp:2`, … and none answers `/mcp` any more:
// pi looks a command up by that exact name, so a bare `/mcp` then runs no
// handler and reaches the model as text.
//
// The MCP host (`lib/mcp-host.ts`) stays inactive unless `/mcp` is the built-in
// one, the read-only policy (`lib/mcp-read-only-policy.ts`) recognises the
// built-in's tools by the path, and the composer opens Settings › MCP for a
// bare `/mcp` (ADR 0006). This module has no imports, so the browser can load it.

/** The `sourceInfo.path` of everything pi's built-in MCP extension registers. */
export const MCP_EXTENSION_PATH = "builtin:mcp";

export const MCP_COMMAND_NAME = "mcp";

/** The fields of a command entry (`pi.getCommands()`, `get_commands`) this module reads. */
export interface McpCommandCandidate {
  name: string;
  source?: string;
  sourceInfo?: { path?: string };
}

/** Whether a command is the built-in MCP extension's `/mcp`. */
export function isBuiltinMcpCommand(command: McpCommandCandidate): boolean {
  return command.name === MCP_COMMAND_NAME && command.sourceInfo?.path === MCP_EXTENSION_PATH;
}

/**
 * Whether an extension registered `/mcp`: the one command named `mcp`, or one
 * of several that pi renamed `mcp:<n>`. Any of them means the built-in MCP
 * extension was dropped, so the MCP host reports the first one's path as the
 * owner. Prompt templates are not extension commands, though `get_commands`
 * and `pi.getCommands()` list them too (`source: "prompt"`); skills are listed
 * as `skill:<name>` and never match.
 */
export function isMcpExtensionCommand(command: McpCommandCandidate): boolean {
  if (command.source === "prompt") return false;
  return command.name === MCP_COMMAND_NAME || /^mcp:\d+$/.test(command.name);
}

/** Whether a composer message is `/mcp` alone, with no subcommand. */
export function isBareMcpCommand(message: string): boolean {
  return message.trim() === `/${MCP_COMMAND_NAME}`;
}

/**
 * Whether a bare `/mcp` opens Settings › MCP instead of being sent, given the
 * session's command list: when its `/mcp` is the built-in one, or when nothing
 * answers to `/mcp` at all (MCP turned off, `-builtin:mcp`, a Chat-only
 * session, or several extensions' `mcp:1`, `mcp:2`, which pi never runs for a
 * bare `/mcp`). Another extension's `/mcp`, and a prompt template named `mcp`
 * (pi expands it when no extension command has the name), keep the message,
 * which is sent as before. Subcommands are never asked about: `/mcp login`,
 * `logout` and `reconnect` act on the session's own connections.
 */
export function bareMcpOpensSettings(commands: readonly McpCommandCandidate[]): boolean {
  if (commands.some(isBuiltinMcpCommand)) return true;
  return !commands.some((command) => command.name === MCP_COMMAND_NAME);
}
