/**
 * Pure helper for the commit-message header insertion (no imports, so
 * node --test can load it without the vite alias chain).
 */

/** Prepend the header to the message; idempotent when the message already
 * starts with it. `sep` separates header from the existing text ("\n\n" for
 * the commit textarea, " " for the single-line plan input). */
export function prependHeader(header: string, message: string, sep: "\n\n" | " "): string {
  const cur = String(message || "");
  if (cur.trimStart().startsWith(header)) return cur;
  const rest = cur.trimStart();
  return rest ? header + sep + rest : header;
}
