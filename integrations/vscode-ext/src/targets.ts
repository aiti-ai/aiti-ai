/**
 * Target URL normalization (pure functions extracted from extension.ts, unit-tested).
 * 2026-11-14 fix: scheme-less input (localhost:5199) parses via new URL with protocol
 * "localhost:" and origin string "null" -> next new URL("null") throws "Invalid URL"
 * -> proxy startup fails. Normalize at every entry: auto-prefix http:// when missing.
 */

/** Auto-prefix http:// for scheme-less localhost/IP/:port/bare-port forms; pass through when a scheme is present */
export function normalizeTargetInput(input: string): string {
  const s = input.trim();
  if (!s) return s;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s; // scheme://
  if (s.startsWith(":")) return `http://localhost${s}`;
  if (/^\d+$/.test(s)) return `http://localhost:${s}`;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[\da-f:.]+\])(:\d+)?([/?#]|$)/i.test(s)) return `http://${s}`;
  return s;
}

/** Resolve origin (with normalization); falls back to the trailing-slash-stripped input on parse failure (caller validates) */
export function originOf(url: string): string {
  const s = normalizeTargetInput(url);
  try {
    const u = new URL(s);
    if (u.origin && u.origin !== "null") return u.origin;
  } catch {
    /* fallthrough */
  }
  return s.replace(/\/+$/, "");
}

/** Whether this is a proxyable http(s) origin (pre-check for enrollProxy, human-readable error) */
export function isProxyableOrigin(url: string): boolean {
  return /^https?:\/\/[^/\s]+/i.test(originOf(url));
}
