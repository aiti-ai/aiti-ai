/**
 * Weak-value discovery: structured extraction (L1), sensitive-file policy
 * helpers (L2), and weak-password candidates (L3).
 *
 * The output-side pipeline already redacts *registered* values reliably.
 * The gap this module closes is **discovery**: a value like `123abc` or
 * `qwerty` is not shaped like a machine credential, so the entropy/length
 * rules miss it. Here we use three context signals instead:
 *
 *   L1  key names      `DB_PASSWORD=…`, `"password": "…"`, `Authorization: …`
 *   L2  file names     `.env`, `id_rsa`, `secret.txt`, `credentials.json`
 *   L3  weak passwords  a small dictionary + strong keyword/copula context
 *
 * Everything is deterministic, offline, and only runs on text the host
 * explicitly hands over (tool output / written content / user prompts).
 */

import { entropy } from "./detect.ts";
import { MIN_REDACT_LENGTH, type Registry, type RegistryEntry } from "./mask.ts";

// ---------------------------------------------------------------------------
// L1: sensitive key names and structured extraction
// ---------------------------------------------------------------------------

export type ExtractFormat = "env" | "yaml" | "json" | "header" | "url" | "netrc";

export interface ExtractedSecret {
  key: string;
  value: string;
  format: ExtractFormat;
}

export const EXTRACT_MIN_LENGTH = MIN_REDACT_LENGTH;
/** Tool-output extraction is capped to keep hooks cheap on huge outputs. */
export const EXTRACT_MAX_BYTES = 256 * 1024;

const SENSITIVE_SEGMENT = /(?:^|[._-])(?:pass(?:word|wd|phrase)?|pwd|secret|token|credentials?|bearer|dsn)(?:$|[._-])/i;
const SENSITIVE_KEY_PREFIX = /(?:^|[._-])(?:api|access|private|secret|client)[_-]?key(?:$|[._-])/i;
const SENSITIVE_CONNECTION = /^(?:connection|conn)[_-]?(?:string|str)$/i;
const SENSITIVE_AUTH_TOKEN = /(?:^|[._-])auth[_-]?token(?:$|[._-])/i;

/** True when a key name conventionally carries a secret (not every `*key*`). */
export function isSensitiveKey(key: string): boolean {
  const k = key.trim();
  if (!k) return false;
  if (/^authorization$/i.test(k)) return true;
  if (k.replace(/^[_-]+/, "") === "authToken") return true;
  return (
    SENSITIVE_SEGMENT.test(k) ||
    SENSITIVE_KEY_PREFIX.test(k) ||
    SENSITIVE_CONNECTION.test(k) ||
    SENSITIVE_AUTH_TOKEN.test(k) ||
    /^_?authToken$/i.test(k)
  );
}

const STOP_VALUES = new Set(
  [
    "true", "false", "null", "none", "nil", "undefined", "yes", "no", "on", "off",
    "required", "optional", "default", "changeme", "example", "placeholder", "redacted",
    "dummy", "sample", "insert", "enabled", "disabled", "invalid", "expired", "configured",
    "incorrect", "forgotten", "encrypted", "protected", "mismatch", "rejected", "verified",
    "unknown", "hidden", "empty", "todo", "tbd", "string", "number", "boolean", "hash",
    "stored", "used", "set", "changed", "shown", "provided", "supplied", "managed", "rotated",
    "generated", "sent", "passed", "given", "needed", "accepted", "defined", "specified",
    "documented", "discussed", "reset", "updated", "saved", "checked", "validated",
  ],
);

function isPlaceholderish(v: string): boolean {
  // v2 tokens are intentionally NOT rejected here: a real password may
  // coincidentally match the `rsec_` + 8 hex shape. Callers skip tokens that
  // are actually mounted placeholders (registry-aware).
  if (/^\[REDACTED:/.test(v)) return true;
  if (/^(?:\$\{.*\}|\$\(?[A-Za-z_]\w*\)?|%[A-Za-z_]\w*%|\{\{.*\}\}|<.*>|__.*__)$/.test(v)) return true;
  if (/^(?:process\.env|os\.environ|env\.|import\.meta\.env|vault:\/\/|file:\/\/|secret:\/\/)/i.test(v)) return true;
  if (/^[x*.]+$/i.test(v) || /^(?:x{4,}|\*{3,}|\.{3,})/.test(v)) return true;
  if (/\$\{|\{\{|process\.env\./.test(v)) return true;
  return false;
}

/** Strip quotes and inline comments; reject placeholders/stop words. */
function cleanValue(raw: string, minLength: number): string | undefined {
  let v = raw.trim();
  if (!v) return undefined;
  const quoted = /^(['"`])([\s\S]*)\1$/.exec(v);
  if (quoted) {
    v = quoted[2];
  } else {
    const comment = v.search(/\s+#/);
    if (comment > 0) v = v.slice(0, comment).trim();
  }
  if (v.length < minLength || v.length > 4096) return undefined;
  if (isPlaceholderish(v)) return undefined;
  if (STOP_VALUES.has(v.toLowerCase())) return undefined;
  return v;
}

function pushHit(out: ExtractedSecret[], seen: Set<string>, key: string, raw: string, format: ExtractFormat, minLength: number): void {
  if (!isSensitiveKey(key)) return;
  // `Authorization: …` is handled by the dedicated header parser (keeps the
  // Bearer/Basic prefix out of the registered value).
  if (/^authorization$/i.test(key) && format !== "header") return;
  const value = cleanValue(raw, minLength);
  if (!value) return;
  const dedupe = `${key.toLowerCase()}\u0000${value}`;
  if (seen.has(dedupe)) return;
  seen.add(dedupe);
  out.push({ key, value, format });
}

function extractJsonTree(value: unknown, out: ExtractedSecret[], seen: Set<string>, minLength: number): void {
  if (Array.isArray(value)) {
    for (const item of value) extractJsonTree(item, out, seen, minLength);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (typeof child === "string") pushHit(out, seen, key, child, "json", minLength);
    else extractJsonTree(child, out, seen, minLength);
  }
}

function tryJson(text: string, out: ExtractedSecret[], seen: Set<string>, minLength: number): boolean {
  const trimmed = text.trim();
  const start = Math.min(...["{", "["].map((c) => (trimmed.indexOf(c) < 0 ? Number.MAX_SAFE_INTEGER : trimmed.indexOf(c))));
  if (!Number.isFinite(start) || start === Number.MAX_SAFE_INTEGER) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start));
  } catch {
    return false;
  }
  extractJsonTree(parsed, out, seen, minLength);
  return true;
}

/** Extract every key/value pair whose key looks like a credential. */
export function extractStructuredSecrets(text: string, opts: { minLength?: number } = {}): ExtractedSecret[] {
  const minLength = opts.minLength ?? 3;
  const out: ExtractedSecret[] = [];
  const seen = new Set<string>();
  if (!text) return out;

  // JSON (whole document) first; line parsers would also see `"password": "x"`.
  tryJson(text, out, seen, minLength);
  // JSON fragments embedded in logs/tool output.
  for (const m of text.matchAll(/"([A-Za-z_][\w.-]*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
    let value = m[2]!;
    try {
      value = JSON.parse(`"${m[2]}"`) as string;
    } catch {
      // keep the raw text if it is not a valid JSON string body
    }
    pushHit(out, seen, m[1]!, value, "json", minLength);
  }

  // env / INI / TOML: KEY=value, export KEY=value
  for (const line of text.split(/\r?\n/)) {
    const eq = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=\s*(.+?)\s*$/.exec(line);
    if (eq) pushHit(out, seen, eq[1]!, eq[2]!, "env", minLength);
  }

  // YAML/conf: key: value  (skip `http://`-like lines by requiring a word key)
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(?:#|\/\/|--)/.test(line)) continue;
    const kv = /^\s*([A-Za-z_][\w.-]*)\s*:\s*(.+?)\s*$/.exec(line);
    if (kv) pushHit(out, seen, kv[1]!, kv[2]!, "yaml", minLength);
  }

  // Authorization headers
  for (const m of text.matchAll(/\bAuthorization\s*:\s*(?:Bearer|Basic|Token|Digest)\s+([^\s,;]+)/gi)) {
    pushHit(out, seen, "authorization", m[1]!, "header", minLength);
  }

  // URL userinfo: scheme://user:password@host
  for (const m of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/([^/\s:@]+):([^/\s@]+)@/gi)) {
    pushHit(out, seen, "url-password", m[2]!, "url", minLength);
  }

  // netrc: machine x login y password z
  for (const m of text.matchAll(/^\s*(?:machine|default)\b.*?\bpassword\s+([^\s]+)/gim)) {
    pushHit(out, seen, "password", m[1]!, "netrc", minLength);
  }

  return out;
}

function labelFor(key: string): string {
  return key.toUpperCase().replace(/[^A-Z0-9_.-]/g, "_").slice(0, 48) || "EXTRACTED";
}

/** Register every extracted value (>= MIN_REDACT_LENGTH) in the session registry. */
export function registerExtractedSecrets(
  text: string,
  registry: Registry,
  salt: string,
  opts: { minLength?: number } = {},
): { count: number; keys: string[]; entries: RegistryEntry[] } {
  if (!text || text.length > EXTRACT_MAX_BYTES) return { count: 0, keys: [], entries: [] };
  const minLength = opts.minLength ?? EXTRACT_MIN_LENGTH;
  const keys: string[] = [];
  const entries: RegistryEntry[] = [];
  for (const hit of extractStructuredSecrets(text, { minLength: 2 })) {
    if (hit.value.length < minLength) continue;
    if (registry.hasValue(hit.value) || registry.isMounted(hit.value)) continue;
    const label = labelFor(hit.key);
    const res = registry.registerAuto(hit.value, `extract:${hit.key}`, label, salt, { minLength });
    if (res) {
      entries.push(res.entry);
      keys.push(label);
    }
  }
  return { count: entries.length, keys: [...new Set(keys)], entries };
}

// ---------------------------------------------------------------------------
// L2: sensitive paths and tool targets
// ---------------------------------------------------------------------------

export interface SensitivePathInfo {
  sensitive: boolean;
  /** The whole file is one secret (no structured key/value view). */
  dedicated: boolean;
  category?: string;
}

const PRIVATE_KEY_FILE = /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i;
const KEY_FILE_EXT = /\.(?:key|p12|pfx|jks|keystore)$/i;
const CONFIG_EXT = new Set(["", ".txt", ".env", ".conf", ".ini", ".properties", ".cfg", ".yml", ".yaml", ".json", ".toml", ".xml"]);
const SECRET_STEM = /(?:^|[._-])(?:secret|secrets|password|passwd|pwd|credential|credentials|token|apikey|api-key|private-key|db-password)(?:$|[._-])/i;

/** Classify a file path for the sensitive-file policy. */
export function inspectSensitivePath(input: string): SensitivePathInfo {
  const path = String(input ?? "").trim().replace(/\\/g, "/");
  if (!path) return { sensitive: false, dedicated: false };
  const base = path.split("/").pop() ?? path;
  const lower = base.toLowerCase();
  const extMatch = /\.[a-z0-9]+$/i.exec(lower);
  const ext = extMatch ? extMatch[0] : "";
  const stem = ext ? lower.slice(0, -ext.length) : lower;

  if (PRIVATE_KEY_FILE.test(path) && !/\.pub$/i.test(lower)) return { sensitive: true, dedicated: true, category: "ssh-key" };
  if (/(?:^|\/)\.ssh\/id_[^/]+$/.test(path) && !/\.pub$/i.test(lower)) return { sensitive: true, dedicated: true, category: "ssh-key" };
  if (/\/\.aws\/credentials$/.test(path)) return { sensitive: true, dedicated: false, category: "aws" };
  if (/\/\.kube\/config$/.test(path) || /(?:^|\/)kubeconfig$/i.test(lower)) return { sensitive: true, dedicated: false, category: "kube" };
  if (/\/\.docker\/config\.json$/.test(path)) return { sensitive: true, dedicated: false, category: "docker" };
  if (/\/\.config\/(?:gcloud|gh)\//.test(path) || /\/\.azure\//.test(path)) return { sensitive: true, dedicated: false, category: "cloud" };
  if (lower === ".netrc") return { sensitive: true, dedicated: true, category: "netrc" };
  if (lower === ".pgpass") return { sensitive: true, dedicated: true, category: "pgpass" };
  if (lower === ".my.cnf" || lower === ".npmrc" || lower === ".git-credentials") {
    return { sensitive: true, dedicated: false, category: "dotfile" };
  }
  if (/^\.env(?:\.|$)/.test(lower)) return { sensitive: true, dedicated: false, category: "dotenv" };
  if (KEY_FILE_EXT.test(lower)) {
    // Public certificates (.pem/.crt) are not secrets; PEM private-key blocks
    // are still caught by the private-key rule if they appear in output.
    return { sensitive: true, dedicated: true, category: "key-file" };
  }
  const configLike = CONFIG_EXT.has(ext) || ext === "";
  if (configLike && (SECRET_STEM.test(stem) || /^(?:secret|secrets|password|passwd|pwd|credential|credentials|token)$/i.test(stem))) {
    const dedicated = ext === "" || ext === ".txt" || ext === ".conf" || ext === ".cfg";
    return { sensitive: true, dedicated, category: "secret-file" };
  }
  return { sensitive: false, dedicated: false };
}

export interface ToolTargets {
  reads: string[];
  writes: string[];
  /** Text that should be mined for structured secrets (write/edit/bash input). */
  contents: string[];
}

const READ_COMMANDS = new Set([
  "cat", "head", "tail", "less", "more", "strings", "xxd", "od", "base64", "grep", "egrep", "fgrep",
  "rg", "ag", "sed", "awk", "cut", "sort", "uniq", "source", ".", "type", "Get-Content", "gc", "get-content",
]);
/** Commands whose first non-flag argument is a pattern/script, not a path. */
const PATTERN_FIRST = new Set(["grep", "egrep", "fgrep", "rg", "ag", "sed", "awk"]);
const BARE_SENSITIVE = new Set([
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "kubeconfig", "credentials", "secret", "secrets",
  "password", "passwd", "pwd", "token", "apikey", "api-key", "private-key", ".netrc", ".pgpass",
  ".npmrc", ".git-credentials",
]);
const WRITE_COMMANDS = new Set(["tee", "Set-Content", "set-content", "Out-File", "out-file", "Add-Content", "add-content"]);

function dequote(token: string): string {
  const t = token.trim();
  if (/^(['"]).*\1$/.test(t)) return t.slice(1, -1);
  return t;
}

function looksLikePath(token: string): boolean {
  const t = dequote(token);
  if (!t || t.startsWith("-") || t.startsWith("$") || t.includes("=")) return false;
  return /[/\\]/.test(t) || /^\.[^.]/.test(t) || /\.[a-z0-9]{1,8}$/i.test(t) || BARE_SENSITIVE.has(t.toLowerCase());
}

function shellTokens(segment: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(segment); m; m = re.exec(segment)) tokens.push(m[1] ?? m[2] ?? m[3] ?? "");
  return tokens.filter(Boolean);
}

function bashTargets(command: string): ToolTargets {
  const reads: string[] = [];
  const writes: string[] = [];
  for (const rawSegment of command.split(/&&|\|\||[;|\n]/)) {
    const segment = rawSegment.trim();
    if (!segment) continue;
    for (const m of segment.matchAll(/(?:^|\s)(?:>>?)\s*([^\s;|&]+)/g)) writes.push(dequote(m[1]!));
    for (const m of segment.matchAll(/(?:^|\s)<\s*([^\s;|&]+)/g)) reads.push(dequote(m[1]!));
    const tokens = shellTokens(segment);
    if (tokens.length === 0) continue;
    const name = (tokens[0]!.split(/[/\\]/).pop() ?? "").toLowerCase();
    if (READ_COMMANDS.has(name) || READ_COMMANDS.has(tokens[0]!)) {
      let start = 1;
      while (start < tokens.length && tokens[start]!.startsWith("-")) start++;
      if (PATTERN_FIRST.has(name) || PATTERN_FIRST.has(tokens[0]!)) start++;
      for (const token of tokens.slice(start)) if (looksLikePath(token)) reads.push(dequote(token));
    } else if (WRITE_COMMANDS.has(name)) {
      for (const token of tokens.slice(1)) if (!token.startsWith("-") && looksLikePath(token)) writes.push(dequote(token));
    }
  }
  return { reads, writes, contents: [command] };
}

/** Parse a tool call into read paths, write paths and mineable content. */
export function inspectToolTargets(toolName: string, input: unknown): ToolTargets {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const reads: string[] = [];
  const writes: string[] = [];
  const contents: string[] = [];
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const path = str(i.path) ?? str(i.file_path) ?? str(i.filePath) ?? str(i.filename);
  const name = String(toolName ?? "").toLowerCase();

  if (name === "read" && path) reads.push(path);
  if ((name === "write" || name === "edit" || name === "apply_patch") && path) writes.push(path);
  for (const key of ["content", "text", "newText", "new_string", "newString", "patch"]) {
    const v = str(i[key]);
    if (v) contents.push(v);
  }
  const edits = i.edits;
  if (Array.isArray(edits)) {
    for (const e of edits) {
      const obj = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
      for (const key of ["newText", "new_string", "content"]) {
        const v = str(obj[key]);
        if (v) contents.push(v);
      }
    }
  }
  const command = str(i.command) ?? str(i.script) ?? str(i.code);
  if (command && (name === "bash" || name === "powershell" || name === "shell" || name === "exec")) {
    const t = bashTargets(command);
    reads.push(...t.reads);
    writes.push(...t.writes);
    contents.push(command);
  } else if (command) {
    contents.push(command);
  }
  // Unknown/MCP file tools: a path argument on a non-write tool is a read
  // candidate (so `.env` readers are covered by the sensitive-file policy).
  if (path && name !== "bash" && name !== "powershell" && name !== "shell" && name !== "exec" && !/write|edit|create|patch|append/i.test(name)) {
    reads.push(path);
  }
  return { reads: [...new Set(reads)], writes: [...new Set(writes)], contents };
}

/**
 * Register structured values from every string leaf of a value (tool-result
 * `details` / `structuredContent`). Nested text such as `details.stdout`
 * still contains `KEY=value` lines, so we mine the leaves, not the JSON.
 */
export function registerValueSecrets(
  value: unknown,
  registry: Registry,
  salt: string,
  opts: { minLength?: number } = {},
): { count: number; keys: string[] } {
  let count = 0;
  const keys: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      const r = registerExtractedSecrets(node, registry, salt, opts);
      count += r.count;
      keys.push(...r.keys);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node && typeof node === "object") {
      for (const item of Object.values(node as Record<string, unknown>)) walk(item);
    }
  };
  walk(value);
  return { count, keys: [...new Set(keys)] };
}

/**
 * Mine an assistant message's tool calls (write/edit content, bash commands)
 * before it is persisted. Returns the number of newly registered values.
 */
export function registerMessageToolSecrets(
  message: unknown,
  registry: Registry,
  salt: string,
  opts: { minLength?: number } = {},
): { count: number; keys: string[] } {
  const msg = message as { role?: string; content?: unknown } | null;
  if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) return { count: 0, keys: [] };
  let count = 0;
  const keys: string[] = [];
  for (const block of msg.content) {
    const b = block as { type?: string; name?: string; arguments?: unknown } | null;
    if (!b || b.type !== "toolCall" || typeof b.name !== "string") continue;
    const targets = inspectToolTargets(b.name, b.arguments);
    for (const content of targets.contents) {
      const r = registerExtractedSecrets(content, registry, salt, opts);
      count += r.count;
      keys.push(...r.keys);
    }
  }
  return { count, keys: [...new Set(keys)] };
}

/** Read targets among a tool call, only when they match a sensitive path. */
export function sensitiveReadTargets(toolName: string, input: unknown): Array<{ path: string; info: SensitivePathInfo }> {
  return inspectToolTargets(toolName, input)
    .reads.map((path) => ({ path, info: inspectSensitivePath(path) }))
    .filter((x) => x.info.sensitive);
}

// ---------------------------------------------------------------------------
// L3: weak passwords and strong-context candidates
// ---------------------------------------------------------------------------

/** Small dictionary of common weak passwords (lowercase). */
export const WEAK_PASSWORDS: ReadonlySet<string> = new Set([
  "password", "passw0rd", "password1", "password12", "password123", "p@ssw0rd", "passw0rd1",
  "123456", "1234567", "12345678", "123456789", "1234567890", "0123456789", "9876543210",
  "123456a", "a123456", "a12345678", "rsec_035c2182", "abc123", "abc12345", "abcd1234", "abc123!",
  "qwerty", "qwertyui", "qwertyuiop", "qwerty12", "qwerty123", "qwe123", "qweasd", "qweasdzxc",
  "asdfgh", "asdfghjkl", "asdf1234", "zxcvbnm", "zxcvbnm123", "poiuytrewq", "1qaz2wsx", "1qazxsw2",
  "1qaz2wsx3edc", "1qaz@wsx", "1q2w3e4r", "1q2w3e4r5t", "q1w2e3r4", "zaq12wsx", "qazwsx", "qazwsxedc",
  "abcdef", "abcdefg", "abcdefgh", "iloveyou", "iloveu", "loveme", "loveyou", "mylove", "forever",
  "admin", "admin123", "admin888", "administrator", "root", "root123", "toor", "guest", "guest123",
  "user", "user123", "user1234", "test", "test123", "test1234", "demo", "demo123", "temp123", "temp1234",
  "letmein", "letmein123", "welcome", "welcome1", "welcome123", "changeme", "secret", "secret123",
  "monkey", "monkey123", "dragon", "dragon123", "master", "sunshine", "sunshine1", "princess", "princess1",
  "football", "football1", "baseball", "baseball1", "shadow", "shadow1", "superman", "superman1",
  "michael", "michael1", "jennifer", "jennifer1", "trustno1", "whatever", "nothing", "trustme",
  "woaini", "woaini1314", "woaini520", "5201314", "5201314520", "1314520", "1314521", "7758521",
  "7758258", "888888", "88888888", "666666", "66666666", "111111", "11111111", "000000", "00000000",
  "999999", "555555", "777777", "123123", "112233", "11223344", "121212", "159753", "147258369",
  "123321", "654321", "987654321", "123654", "159357", "159951", "1234554321", "25252525",
  "mysql", "postgres", "postgresql", "oracle", "sybase", "sa123456", "system", "manager", "company",
  "computer", "internet", "service", "server", "backup", "default", "oracle123", "mysql123",
  "fuckyou", "fuckyou1", "fuckoff", "asshole", "bitch", "suckit", "biteme", "killer", "access",
  "flower", "hello", "hello123", "freedom", "whatever1", "starwars", "pokemon", "naruto", "batman",
  "matrix", "mustang", "mercedes", "ferrari", "corvette", "porsche", "yamaha", "hunter", "ranger",
  "buster", "soccer", "hockey", "tennis", "golfer", "cookie", "orange", "banana", "purple", "silver",
  "golden", "diamond", "pepper", "ginger", "summer", "winter", "spring", "autumn", "january", "february",
]);

export type WeakReason = "dictionary" | "short" | "digits-only" | "lowercase-only" | "low-entropy" | "sequence";

export interface PasswordStrength {
  weak: boolean;
  reasons: WeakReason[];
}

/**
 * Heuristic strength check for values that are about to be stored long-term
 * (the vault warns, the mask may only notify). Deliberately simple: dictionary
 * hits, short values, single-character-class values and obvious patterns.
 */
export function assessPasswordStrength(value: string): PasswordStrength {
  const v = value.trim();
  const lower = v.toLowerCase();
  const reasons: WeakReason[] = [];
  if (WEAK_PASSWORDS.has(lower)) reasons.push("dictionary");
  if (v.length < 8) reasons.push("short");
  if (/^\d+$/.test(v) && v.length < 12) reasons.push("digits-only");
  if (/^[a-z]+$/.test(v) && v.length < 12) reasons.push("lowercase-only");
  if (v.length >= 8 && !WEAK_PASSWORDS.has(lower) && entropy(v) < 2.5) reasons.push("low-entropy");
  if (/^(.)\1+$/.test(v) || /(0123|1234|2345|3456|4567|5678|6789|abcd|bcde|qwer|asdf|zxcv|password|admin)/i.test(v)) reasons.push("sequence");
  return { weak: reasons.length > 0, reasons };
}

/** Human-readable details for a weak-password warning (no value). */
export function describePasswordWeakness(strength: PasswordStrength): string {
  const labels: Record<WeakReason, string> = {
    dictionary: "common weak password",
    short: "shorter than 8 characters",
    "digits-only": "digits only",
    "lowercase-only": "lowercase letters only",
    "low-entropy": "low entropy",
    sequence: "sequential pattern",
  };
  return strength.reasons.map((r) => labels[r]).join(", ");
}

export interface WeakCandidate {
  key: string;
  value: string;
  /** Value is in the common weak-password dictionary. */
  dictionary: boolean;
  /** Registered automatically (dictionary hit or auto mode). */
  registered?: boolean;
}

const WEAK_CONTEXT =
  /(password|passwd|pwd|passphrase|密码|口令|令牌|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credential)s?["'`]?[ \t]{0,5}(?::=|=>|[=:]|：|(?:[ \t]+is\b)|是|(?:[ \t]+to\b)|改为|改到|改成|修改为|设置为|设置成|设为|设成|置为|配置为|配置成|换成|换为|变成|重置为|更改为|更新为)[ \t:：]{0,5}["'`]?([^\s"'`;,(){}<>[\]\\，。、；：！？“”‘’（）]{3,64})/gi;

/** Weak-shaped values found after a strong keyword/operator context. */
export function weakPasswordCandidates(text: string): WeakCandidate[] {
  const out: WeakCandidate[] = [];
  const seen = new Set<string>();
  if (!text || text.length > EXTRACT_MAX_BYTES) return out;
  WEAK_CONTEXT.lastIndex = 0;
  for (let m = WEAK_CONTEXT.exec(text); m; m = WEAK_CONTEXT.exec(text)) {
    const key = m[1]!;
    const raw = m[2]!;
    if (raw.length < 3 || isPlaceholderish(raw)) continue;
    const lower = raw.toLowerCase();
    const normalized = lower.replace(/[.,;:!?]+$/, "");
    const dictionary = WEAK_PASSWORDS.has(lower) || WEAK_PASSWORDS.has(normalized);
    const weakShape = raw.length < 8 || !/[A-Z0-9]/.test(raw) || entropy(raw) < 2.5;
    if (!dictionary && !weakShape) continue;
    if (!dictionary && STOP_VALUES.has(normalized)) continue;
    const dedupe = lower;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({ key: key || "password", value: raw, dictionary });
  }
  return out;
}

/** Register dictionary hits / auto-mode candidates; otherwise report them. */
export function registerWeakCandidates(
  text: string,
  registry: Registry,
  salt: string,
  opts: { auto?: boolean; onCandidate?: (candidate: WeakCandidate) => void; minLength?: number } = {},
): WeakCandidate[] {
  const minLength = opts.minLength ?? EXTRACT_MIN_LENGTH;
  const out: WeakCandidate[] = [];
  for (const candidate of weakPasswordCandidates(text)) {
    if (registry.hasValue(candidate.value) || registry.isMounted(candidate.value)) {
      out.push({ ...candidate, registered: false });
      continue;
    }
    const wantRegister = (candidate.dictionary || opts.auto === true) && candidate.value.length >= minLength;
    if (wantRegister) {
      const label = candidate.key.toUpperCase().replace(/[^A-Z0-9_.-]/g, "_").slice(0, 48) || "WEAK";
      const res = registry.registerAuto(candidate.value, `weak:${candidate.key}`, label, salt, { minLength });
      const registered = Boolean(res);
      try {
        opts.onCandidate?.({ ...candidate, registered });
      } catch {
        // candidate notification is best effort
      }
      out.push({ ...candidate, registered });
    } else {
      try {
        opts.onCandidate?.(candidate);
      } catch {
        // candidate notification is best effort
      }
      out.push({ ...candidate, registered: false });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// learn / whole-file helpers
// ---------------------------------------------------------------------------

export interface LearnResult {
  count: number;
  keys: string[];
  wholeRegistered?: boolean;
  entries: RegistryEntry[];
}

/**
 * Register structured values from arbitrary text; when `whole` is set and no
 * structured value was found, register the trimmed content as one secret
 * (dedicated password files).
 */
export function learnFromText(
  text: string,
  registry: Registry,
  salt: string,
  opts: { whole?: boolean; label?: string; minLength?: number } = {},
): LearnResult {
  const minLength = opts.minLength ?? EXTRACT_MIN_LENGTH;
  const extracted = registerExtractedSecrets(text, registry, salt, { minLength });
  if (extracted.count > 0 || !opts.whole) {
    return { count: extracted.count, keys: extracted.keys, entries: extracted.entries };
  }
  const trimmed = text.trim();
  if (trimmed.length < minLength || trimmed.length > 1_048_576) return { count: 0, keys: [], entries: [] };
  if (registry.hasValue(trimmed) || registry.isMounted(trimmed)) return { count: 0, keys: [], entries: [] };
  const label = (opts.label ?? "FILE").toUpperCase().replace(/[^A-Z0-9_.-]/g, "_").slice(0, 48) || "FILE";
  const res = registry.registerAuto(trimmed, "learn:whole", label, salt, { minLength });
  return res
    ? { count: 1, keys: [label], wholeRegistered: true, entries: [res.entry] }
    : { count: 0, keys: [], entries: [] };
}
