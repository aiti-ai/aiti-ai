/**
 * Tool-name predicates shared by the chat views.
 *
 * Pi's built-in names are plain `write` / `edit`, but MCP servers expose the
 * same operations under prefixed or namespaced names, so each predicate also
 * accepts the common decorated forms.
 */

export function isWriteToolName(toolName: string): boolean {
  // ⚠ 同 isEditToolName：attach/桥回放偶发 toolCall.toolName 缺失 → 直接 toLowerCase
  // 会抛 TypeError（页面错误边界「This page couldn’t load」，实机 2026-08-27 复现）
  const name = typeof toolName === "string" ? toolName.toLowerCase() : "";
  return name === "write" ||
    name.startsWith("write_") ||
    name.endsWith(".write") ||
    name.endsWith("_write");
}

export function isEditToolName(toolName: string): boolean {
  // ⚠ 防护：attach/历史消息偶发 toolCall.toolName 缺失（undefined）——此前直接
  // toLowerCase 会在消息渲染时抛 TypeError（生产页面整个会话区崩，ChatWindow 不挂载）。
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
