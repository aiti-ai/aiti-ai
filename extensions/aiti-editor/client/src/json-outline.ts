/**
 * aiti-editor · JSON outline extraction (pure, no Monaco/window deps).
 *
 * Extracted from registry.ts where the old implementation called
 * `text.split("\n")` twice per loop iteration — O(n²). A real 2.1MB session
 * export (16,222 lines) did not finish within 25s; this version runs in ~17ms.
 *
 * Also caps the symbol list: a session export has ~12k keys, which is
 * meaningless in the outline/sticky-scroll UI and expensive to hand to Monaco.
 */

export interface JsonOutlineSymbol {
  name: string;
  /** 1-based line number. */
  line: number;
}

const KEY_RE = /^"([^"]+)"\s*:/;

export function outlineJson(text: string, maxSymbols = 2000): JsonOutlineSymbol[] {
  const out: JsonOutlineSymbol[] = [];
  if (!text || maxSymbols <= 0) return out;
  const lines = text.split("\n"); // single split for the whole document
  for (let i = 0; i < lines.length; i++) {
    if (out.length >= maxSymbols) break;
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed === "{" || trimmed === "[" || trimmed === "}" || trimmed === "]") continue;
    const m = KEY_RE.exec(trimmed);
    if (m) out.push({ name: m[1], line: i + 1 });
  }
  return out;
}

/** Cheap line counter (single split; callers should memoize per content). */
export function countTextLines(text: string): number {
  if (!text) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) n++;
  }
  return n;
}
