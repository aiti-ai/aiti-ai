/**
 * Block-aware plain text for paragraph clicks (quote / copy).
 *
 * `element.textContent` glues every descendant text run together: a list item with a
 * nested list becomes one endless "sentence", so the quote popover cannot split it into
 * lines and the user gets an unreadable blob. This helper walks the rendered DOM and
 * starts a new line at every block boundary (p/li/ul/ol/pre/headings/br …).
 */

/** Tags that start a new text line. Boundaries are deferred until the next run of text,
 *  so adjacent blocks never produce blank lines (inner blank lines of code keep). */
const BLOCK_TAGS = new Set([
  "P", "DIV", "LI", "UL", "OL", "PRE", "BLOCKQUOTE", "TABLE", "THEAD", "TBODY", "TR", "TD", "TH",
  "H1", "H2", "H3", "H4", "H5", "H6", "HR", "SECTION", "ARTICLE", "HEADER", "FOOTER", "FIGURE", "FIGCAPTION",
]);

interface WalkState {
  /** A block boundary was seen; the next text must start a fresh line. */
  lineBreak: boolean;
  /** Anything emitted yet (suppresses the leading newline). */
  started: boolean;
}

function appendBlockText(node: Node, out: string[], state: WalkState): void {
  if (node.nodeType === 3 /* text */) {
    const value = node.nodeValue ?? "";
    if (!value) return;
    if (state.lineBreak && state.started) out.push("\n");
    state.lineBreak = false;
    state.started = true;
    out.push(value);
    return;
  }
  if (node.nodeType !== 1 /* element */) return;
  const el = node as HTMLElement;
  const tag = (el.tagName || "").toUpperCase();
  if (tag === "BR") {
    state.lineBreak = true;
    return;
  }
  const block = BLOCK_TAGS.has(tag);
  if (block) state.lineBreak = true;
  const children = el.childNodes;
  for (let i = 0; i < children.length; i++) appendBlockText(children[i], out, state);
  if (block) state.lineBreak = true;
}

/**
 * Rendered block → plain text with one line per block.
 * Lines keep their leading indentation (code inside a list item) but trailing whitespace
 * is trimmed and leading/trailing blank lines dropped; inner blank lines are preserved.
 */
export function blockPlainText(el: HTMLElement): string {
  const out: string[] = [];
  appendBlockText(el, out, { lineBreak: false, started: false });
  const lines = out.join("").split("\n").map((line) => line.replace(/\s+$/, ""));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join("\n");
}
