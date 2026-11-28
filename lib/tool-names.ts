/**
 * Tool-name predicates shared by the chat views.
 *
 * Pi's built-in names are plain `write` / `edit`, but MCP servers expose the
 * same operations under prefixed or namespaced names, so each predicate also
 * accepts the common decorated forms.
 */

export function isWriteToolName(toolName: string): boolean {
  // Same guard as isEditToolName: with attach/bridge replay, toolCall.toolName is
  // occasionally missing → calling toLowerCase directly would throw a TypeError
  // (page error boundary "This page couldn't load"; reproduced on a live machine
  // 2026-08-27)
  const name = typeof toolName === "string" ? toolName.toLowerCase() : "";
  return name === "write" ||
    name.startsWith("write_") ||
    name.endsWith(".write") ||
    name.endsWith("_write");
}

export function isEditToolName(toolName: string): boolean {
  // Guard: with attach/history messages, toolCall.toolName is occasionally
  // missing (undefined) — toLowerCase used to throw a TypeError during message
  // rendering (the whole session area of the production page crashed,
  // ChatWindow never mounted).
  const name = typeof toolName === "string" ? toolName.toLowerCase() : "";
  return name === "edit" ||
    name.startsWith("edit_") ||
    name.endsWith(".edit") ||
    name.endsWith("_edit") ||
    name.includes("str_replace") ||
    name.includes("replace_editor");
}

/** Codex-style patch tools (e.g. the pi-apply-patch extension). */
export function isApplyPatchToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "apply_patch" ||
    name.startsWith("apply_patch_") ||
    name.endsWith(".apply_patch") ||
    name.endsWith("_apply_patch");
}
