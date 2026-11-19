/**
 * aiti-msg-share · server-side core (pure JS, unit-testable without the host).
 *
 * Owns: persisted targets (0600), share history (state layer), redaction via
 * @aiti-ai/secret-mask-core, provider dispatch via @aiti-ai/content-share.
 * No UI / DOM / host API in here.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";

const HISTORY_MAX = 200;

/** Files above this size are rejected before reading (provider limits are checked later). */
export const MAX_SHARE_FILE_BYTES = 200 * 1024 * 1024;

const IMAGE_MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml", ico: "image/x-icon", avif: "image/avif",
};
const TEXT_EXT = new Set([
  "txt", "md", "markdown", "json", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java",
  "c", "h", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh", "yml", "yaml", "toml", "ini", "cfg", "conf",
  "csv", "tsv", "log", "html", "htm", "css", "scss", "xml", "sql", "env", "properties", "gradle", "vim",
  "dockerfile", "makefile", "gitignore", "license",
]);

/**
 * Classify a shared file: image (binary, image/* mime), text (decoded as utf8),
 * or binary (byte-exact buffer, application/octet-stream). Mirrors the client's
 * kind filter so both ends agree on what the content is.
 */
export function classifyFile(filename) {
  const ext = String(filename || "").split(".").pop()?.toLowerCase() || "";
  if (IMAGE_MIME[ext]) return { kind: "image", mime: IMAGE_MIME[ext] };
  if (TEXT_EXT.has(ext)) return { kind: "text", mime: "text/plain" };
  // Executables/scripts without extension sometimes carry a shebang — still treat
  // unknown types as binary: byte-exact upload never corrupts, utf8 decode can.
  return { kind: "binary", mime: "application/octet-stream" };
}

/** Mask a secret for display: keep first 2 / last 4 chars only. */
export function maskSecret(value) {
  if (!value || typeof value !== "string") return "";
  if (value.length <= 6) return "****";
  return value.slice(0, 2) + "*".repeat(Math.min(18, value.length - 6)) + value.slice(-4);
}

/** Sanitize a target for API responses (never echo raw secrets). */
export function publicTarget(target, provider) {
  const secretKeys = new Set((provider?.metaFields || [])
    .filter((f) => f.type === "password" || /key|token|secret|password|hash/i.test(f.key))
    .map((f) => f.key));
  return {
    ...target,
    values: Object.fromEntries(Object.entries(target.values || {}).map(([k, v]) =>
      [k, secretKeys.has(k) && v ? maskSecret(v) : v])),
    secretKeys: [...secretKeys],
  };
}

/** Redact secrets in text using secret-mask-core's deterministic rules. */
export function makeRedactor(engine) {
  const { scan, fnv1a } = engine;
  return (text) => {
    const hits = scan(text, { maxBytes: 4 * 1024 * 1024 });
    if (!hits.length) return { text, hits: [] };
    let out = "";
    let cursor = 0;
    const counts = new Map();
    for (const hit of hits) {
      out += text.slice(cursor, hit.start);
      const label = String(hit.label || hit.id).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
      const token = `[REDACTED:${label}#${fnv1a(hit.value).slice(0, 8)}]`;
      out += token;
      cursor = hit.end;
      counts.set(label, (counts.get(label) || 0) + 1);
    }
    out += text.slice(cursor);
    return { text: out, hits: [...counts].map(([rule, count]) => ({ rule, count })) };
  };
}

export class ShareStore {
  constructor(configDir, stateDir) {
    this.targetsFile = join(configDir, "targets.json");
    this.historyFile = join(stateDir, "shares.json");
  }

  readTargets() {
    try { return JSON.parse(readFileSync(this.targetsFile, "utf8")); }
    catch { return []; }
  }

  writeTargets(targets) {
    mkdirSync(dirname(this.targetsFile), { recursive: true });
    writeFileSync(this.targetsFile, JSON.stringify(targets, null, 2));
    chmodSync(this.targetsFile, 0o600);
  }

  upsertTarget(target) {
    const all = this.readTargets();
    const i = all.findIndex((t) => t.id === target.id);
    if (i < 0) all.push(target); else all[i] = target;
    this.writeTargets(all);
    return target;
  }

  deleteTarget(id) {
    this.writeTargets(this.readTargets().filter((t) => t.id !== id));
  }

  readHistory() {
    try { return JSON.parse(readFileSync(this.historyFile, "utf8")); }
    catch { return []; }
  }

  appendHistory(record) {
    const all = this.readHistory();
    all.unshift(record);
    mkdirSync(dirname(this.historyFile), { recursive: true });
    writeFileSync(this.historyFile, JSON.stringify(all.slice(0, HISTORY_MAX), null, 2));
    return record;
  }
}

/** Export a session's messages to markdown (tool output folded by default). */
export function exportSessionMarkdown(session, opts = {}) {
  const { full = false, title = "", tags = [] } = opts;
  const lines = [];
  if (title || tags.length) {
    lines.push("---", ...(title ? [`title: ${title}`] : []), ...(tags.length ? [`tags: [${tags.join(", ")}]`] : []), "---", "");
  }
  for (const m of session?.messages || []) {
    const role = m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : m.role;
    lines.push(`## ${role}`, "");
    const content = typeof m.content === "string" ? m.content
      : Array.isArray(m.content) ? m.content.map((b) => b?.text || b?.content || "").join("\n") : String(m.content ?? "");
    if (!full && content.length > 2000) lines.push(content.slice(0, 1000), `\n_… ${content.length - 2000} chars folded (full export available)_`, content.slice(-1000));
    else lines.push(content);
    lines.push("");
  }
  return lines.join("\n");
}

