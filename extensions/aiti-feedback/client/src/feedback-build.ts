/**
 * feedback-build — pure functions for composing the feedback report.
 *
 * Pipeline: form + env info → sanitize (best-effort redact) → markdown body →
 * prefilled GitHub issue URL (query params). No tokens, no server: the user logs
 * into GitHub themselves and the content is already in the input boxes.
 *
 * Safety model: the preview in the dialog IS the final content (user-confirmed
 * before the redirect), so redaction here is best-effort — the rules below catch
 * internal domains/IPs/repo names/paths and common token shapes.
 */

/** GitHub truncates oversized query payloads; stay comfortably under (~8KB). */
export const BODY_SAFE = 6000;
export const REPO_NEW_ISSUE = "https://github.com/aiti-ai/aiti-ai/issues/new";

export type FeedbackKind = "bug" | "suggestion" | "other";

export interface FeedbackForm {
  kind: FeedbackKind;
  title: string;
  desc: string;
  steps: string;
  contact: string;
  /** Optional pasted session context (never auto-read from the session). */
  context: string;
  includeEnv: boolean;
}

/** Environment section lines (URL query is stripped — session ids stay local). */
export function envInfo(nav?: { userAgent?: string; platform?: string; language?: string }, href?: string): Record<string, string> {
  const n = nav ?? (typeof navigator !== "undefined" ? navigator : ({} as { userAgent?: string; platform?: string; language?: string }));
  let page = "";
  if (href ?? (typeof location !== "undefined" ? location.href : "")) {
    try { const u = new URL((href ?? (typeof location !== "undefined" ? location.href : "")) as string); page = u.origin + u.pathname; } catch { page = ""; }
  }
  const out: Record<string, string> = {};
  if (n.userAgent) out["UA"] = n.userAgent;
  if (n.platform) out["Platform"] = n.platform;
  if (n.language) out["Language"] = n.language;
  if (page) out["pi-web path"] = page;
  return out;
}

// Site-specific internal hostnames are injected, never hardcoded here:
//   build time — VITE_FEEDBACK_INTERNAL_HOSTS="host1,host2"
//   runtime    — globalThis.__AITI_FEEDBACK_INTERNAL_HOSTS (array or comma list)
function injectedHosts(): string[] {
  const env = (import.meta as unknown as { env?: Record<string, string> })?.env ?? {};
  const runtime = (globalThis as Record<string, unknown>).__AITI_FEEDBACK_INTERNAL_HOSTS;
  const raw = [env.VITE_FEEDBACK_INTERNAL_HOSTS, ...(Array.isArray(runtime) ? runtime : [runtime])];
  const hosts = raw
    .flatMap((v) => String(v ?? "").split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(hosts)];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Order matters: specific shapes first, generic long-secrets last.
const REDACT_RULES: Array<[RegExp, string]> = [
  // Self-hosted / private-network DNS suffixes (RFC 8375 .home.arpa included).
  [/\b(?:[a-z0-9-]+\.)+(?:internal|intranet|lan|local|corp|home\.arpa)(?::\d+)?/gi, "<redacted-domain>"],
  [/\b192\.168\.\d{1,3}\.\d{1,3}\b/g, "<redacted-ip>"],
  [/\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "<redacted-ip>"],
  [/\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/g, "<redacted-ip>"],
  // Home directories: drop the user segment, keep the rest readable.
  [/\/home\/[^/\s]+/g, "/home/<redacted>"],
  [/\/Users\/[^/\s]+/g, "/Users/<redacted>"],
  [/\b[A-Za-z]:\\Users\\[^\\\s]+/g, "<redacted-path>"],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "<redacted-key>"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "<redacted-token>"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "<redacted-token>"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "<redacted-aws-key>"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "<redacted-token>"],
  [/\b[0-9a-f]{32,}\b/gi, "<redacted-hex>"],
  [/\b[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/])/g, "<redacted-b64>"],
];

/** Best-effort sanitize: internal names/addresses and common secret shapes → placeholders. */
export function redact(text: string): string {
  const rules: Array<[RegExp, string]> = [
    ...injectedHosts().map((host): [RegExp, string] => [
      new RegExp(`[\\w.-]*${escapeRe(host)}(?::\\d+)?`, "gi"),
      "<redacted-domain>",
    ]),
    ...REDACT_RULES,
  ];
  return rules.reduce((s, [re, sub]) => s.replace(re, sub), text);
}

const KIND_LABEL: Record<FeedbackKind, string> = { bug: "bug", suggestion: "suggestion", other: "other" };

function section(title: string, content: string): string {
  const c = content.trim();
  return c ? `### ${title}\n${c}\n` : "";
}

/** Compose the issue body (each section emitted only when non-empty; redacted). */
export function buildMarkdown(f: FeedbackForm, env?: Record<string, string>): string {
  const lines: string[] = [];
  lines.push(`### Type\n${KIND_LABEL[f.kind] || f.kind}\n`);
  const desc = redact(f.desc).trim();
  lines.push(`### Description\n${desc || "(empty)"}\n`);
  lines.push(section("Steps to reproduce", redact(f.steps)));
  if (f.includeEnv && env && Object.keys(env).length) {
    lines.push(`### Environment\n${Object.entries(env).map(([k, v]) => `- ${k}: ${redact(String(v))}`).join("\n")}\n`);
  }
  lines.push(section("Session context (pasted by the reporter)", redact(f.context)));
  lines.push(section("Contact", redact(f.contact)));
  return lines.join("\n").trim() + "\n";
}

export interface IssueUrlResult {
  url: string;
  /** true when body exceeded BODY_SAFE and was cut (full text goes to clipboard). */
  truncated: boolean;
  fullBody: string;
}

/** Prefilled new-issue URL; body over the safe budget is cut with a pointer note. */
export function buildIssueUrl(title: string, fullBody: string): IssueUrlResult {
  const t = (title || "feedback").trim().slice(0, 160) || "feedback";
  let body = fullBody;
  let truncated = false;
  if (body.length > BODY_SAFE) {
    truncated = true;
    body = body.slice(0, BODY_SAFE).replace(/\n[\s\S]*$/, "") + "\n\n(truncated — full text in clipboard, paste as a follow-up comment)";
  }
  const url = `${REPO_NEW_ISSUE}?title=${encodeURIComponent(t)}&body=${encodeURIComponent(body)}`;
  return { url, truncated, fullBody };
}
