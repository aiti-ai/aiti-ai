/**
 * Client-side helpers for exporting session prompts (user messages) as
 * Markdown or JSON. Pure functions — mirror lib/queue-export.ts.
 */

export interface PromptExportEntry {
  id?: string;
  timestamp?: number;
  text: string;
}

export interface PromptExportMeta {
  sessionId?: string;
  compactionCount?: number;
  exportedAt?: string;
}

function formatTime(ts?: number): string {
  return ts ? new Date(ts).toLocaleString() : "";
}

/** Markdown export — human-readable, one section per prompt. */
export function promptsToMarkdown(prompts: PromptExportEntry[], meta: PromptExportMeta): string {
  const lines: string[] = [];
  lines.push("# User prompts export");
  if (meta.sessionId) lines.push(`- Session: ${meta.sessionId}`);
  lines.push(`- Prompts: ${prompts.length}`);
  if (meta.compactionCount) lines.push(`- Compactions: ${meta.compactionCount}`);
  lines.push(`- Exported: ${meta.exportedAt ?? new Date().toISOString()}`);
  lines.push("");
  if (prompts.length === 0) {
    lines.push("_No prompts._");
    return lines.join("\n");
  }
  prompts.forEach((prompt, index) => {
    const ts = formatTime(prompt.timestamp);
    lines.push(`## Prompt ${index + 1}${ts ? ` · ${ts}` : ""}`);
    lines.push("");
    lines.push(prompt.text);
    lines.push("");
  });
  return lines.join("\n").trimEnd() + "\n";
}

/** JSON export — structured, round-trippable. */
export function promptsToJson(prompts: PromptExportEntry[], meta: PromptExportMeta): string {
  return JSON.stringify(
    {
      format: "pi-web-prompts",
      sessionId: meta.sessionId,
      compactionCount: meta.compactionCount,
      exportedAt: meta.exportedAt ?? new Date().toISOString(),
      prompts,
    },
    null,
    2,
  );
}

/** Trigger a client-side download of `content` as `fileName`. */
export function downloadText(content: string, fileName: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
