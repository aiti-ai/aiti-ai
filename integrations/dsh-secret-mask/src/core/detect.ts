/**
 * Secret detection rules for pi-secret-mask.
 *
 * Deterministic regex + checksum rules (no model calls, no network). Rule
 * shapes, entropy thresholds and false-positive guards follow the public
 * gitleaks/GitHub secret-shape corpus as implemented by the MIT-licensed
 * claude-code-redact project (karanb192/claude-code-redact); this file is an
 * independent TypeScript implementation for the pi extension ecosystem.
 *
 * scan() returns non-overlapping hits sorted by position. Already-redacted
 * placeholder spans are protected so re-scanning redacted text is a no-op.
 */

export type RuleKind = "secret";

export interface Rule {
  id: string;
  label: string;
  kind: RuleKind;
  pattern: RegExp;
  /** Capture group index holding the secret value (default 0 = whole match). */
  group?: number;
  /** Extra value check; reject when it returns false. */
  verify?: (value: string) => boolean;
  /** Check on the full match start offset within the scanned text. */
  before?: (text: string, at: number) => boolean;
  source: string;
}

export interface Hit {
  id: string;
  label: string;
  kind: RuleKind;
  start: number;
  end: number;
  value: string;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Shannon entropy in bits per character. */
export function entropy(v: string): number {
  if (!v) return 0;
  const counts = new Map<string, number>();
  for (const ch of v) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / v.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function base64urlDecode(s: string): string | null {
  let acc = 0;
  let bits = 0;
  let out = "";
  for (const ch of s.replace(/=+$/, "")) {
    let v = B64URL.indexOf(ch);
    if (ch === "+") v = 62;
    else if (ch === "/") v = 63;
    if (v < 0) return null;
    acc = ((acc << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((acc >> bits) & 0xff);
    }
  }
  return out;
}

function jwtHeaderHasAlg(token: string): boolean {
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const decoded = base64urlDecode(token.slice(0, dot));
  if (decoded === null) return false;
  try {
    const header = JSON.parse(decoded);
    return header !== null && typeof header === "object" && typeof header.alg === "string";
  } catch {
    return false;
  }
}

const NOT_SECRETS = new Set([
  "true", "false", "null", "none", "nil", "undefined", "changeme", "password", "passw0rd",
  "secret", "token", "placeholder", "redacted", "example", "default", "required", "optional",
]);

/** Obvious non-secrets: template slots, paths, URLs, env references, filler. */
export function plausibleSecret(v: string): boolean {
  const lower = v.toLowerCase();
  if (NOT_SECRETS.has(lower)) return false;
  if (/^\$\{[^}]*\}$|^\$\(?[A-Za-z_]\w*\)?$|^%[A-Za-z_]\w*%$|^\{\{.*\}\}$|^<.*>$/.test(v)) return false;
  if (v.includes("${") || v.includes("{{")) return false;
  if (/^(?:\/|\.{1,2}\/|~\/|[A-Za-z]:\\|\.\w)/.test(v)) return false;
  if (/^(?:https?|file):\/\//i.test(lower)) return false;
  if (/^(?:process\.env|os\.environ|env\.|import\.meta\.env)/.test(v)) return false;
  if (/^(.)\1*$/.test(v)) return false;
  if (/x{4,}|\*{3,}|\.{3}|your[_-]?|example|placeholder|changeme|redacted|dummy|sample|insert[_-]?/i.test(v)) return false;
  return true;
}

/** Template and build-time slots: {{secret}}, <token>, __API_KEY__, %s, and a bare `Name=` cut off before its value. */
export function placeholderShaped(v: string): boolean {
  return /^(?:\{\{|<|__|%)|(?:\}\}|>|__)$|^[A-Za-z_]+=$/.test(v);
}

function notFiller(v: string): boolean {
  return entropy(v) >= 2.5 && !/x{6,}|X{6,}|0{8,}|EXAMPLE/.test(v);
}

function quotedSecret(v: string): boolean {
  // lowercase words joined by - _ . with no digit read as enum values ('same-origin', 'github_webhook')
  return plausibleSecret(v) && !placeholderShaped(v) && entropy(v) >= 2.0 && !/^[a-z]+(?:[-_.][a-z]*)+$/.test(v);
}

function codeIdentifier(v: string): boolean {
  const digits = v.replace(/\D/g, "").length;
  const upper = v.replace(/[^A-Z]/g, "").length;
  const letters = v.replace(/[^A-Za-z]/g, "").length;
  // word humps (Uint8Array, ToStringUtf8) keep capitals sparse; random strings are about half capitals
  return /^[A-Za-z][A-Za-z0-9]*$/.test(v) && digits <= 2 && upper > 0 && upper * 3 <= letters;
}

function codeExpression(v: string): boolean {
  if (v.includes("?.") || codeIdentifier(v)) return true;
  // a member chain (jose.base64url.decode, result.Payload.Data.ToStringUtf8) whose parts read as names, not
  // a dotted token whose parts are digit-heavy
  const parts = v.split(".");
  return parts.length > 1 && parts.every((p) => /^[A-Za-z_$][\w$]*$/.test(p) && p.replace(/\D/g, "").length <= 2);
}

function bareSecret(v: string): boolean {
  if (!plausibleSecret(v) || placeholderShaped(v) || entropy(v) < 3.0) return false;
  // a code identifier or member chain with no digit (getToken, process.env.KEY, my-secret-name) is not a value
  if (!/\d/.test(v) && /^[A-Za-z_$][\w$]*(?:[.\-][A-Za-z_$][\w$]*)*$/.test(v)) return false;
  return !codeExpression(v);
}

function keywordStart(text: string, at: number): boolean {
  if (at === 0) return true;
  const prev = text.charAt(at - 1);
  if (prev === ":") return false;
  // CJK has no intra-word humps: a CJK neighbour or a CJK keyword (数据库密码, API密钥, 我的令牌)
  // is always a fresh keyword start
  if (/[\u4e00-\u9fff]/.test(prev) || /[\u4e00-\u9fff]/.test(text.charAt(at))) return true;
  if (!/[A-Za-z0-9]/.test(prev) || /\\[nrt]$/.test(text.slice(Math.max(0, at - 2), at))) return true;
  // inside a word only a camelCase hump counts (dbPassword, clientSecret), never the auth of OAuth
  return /^[A-Z][a-z]/.test(text.slice(at, at + 2)) && !(/o/i.test(prev) && /^auth/i.test(text.slice(at, at + 4)));
}

function dbUrlHasRealPassword(url: string): boolean {
  const password = /^[^:]+:\/\/[^:@/]*:([^@/]*)@/.exec(url)?.[1] ?? "";
  return (
    password.length > 0 &&
    plausibleSecret(password) &&
    !/^(?:pass|pwd|secret|password|%[sd]|\{\{.*\}\}|<.*>)$/i.test(password)
  );
}

function notTemplated(text: string, at: number): boolean {
  return text.slice(Math.max(0, at - 2), at) !== "{{";
}

// ---------------------------------------------------------------------------
// rules (secret kind; PII rules are planned as an opt-in follow-up)
// ---------------------------------------------------------------------------

const GITLEAKS = "https://github.com/gitleaks/gitleaks";
const GITHUB_PATTERNS = "https://docs.github.com/code-security/secret-scanning";

export const RULES: readonly Rule[] = [
  {
    id: "aws-access-key",
    label: "AWS_KEY",
    kind: "secret",
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b/g,
    verify: notFiller,
    source: GITLEAKS,
  },
  {
    id: "aws-secret-key",
    label: "AWS_SECRET",
    kind: "secret",
    pattern: /(?:aws[_.-]?secret[_.-]?(?:access[_.-]?)?key|secret[_.-]?access[_.-]?key)["'`]?[ \t]{0,5}(?::=|=>|[=:]|：)[ \t]{0,5}["'`]?([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+=])/gi,
    group: 1,
    verify: (v) => entropy(v) >= 3.5 && !/EXAMPLE/.test(v),
    source: "https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html",
  },
  {
    id: "github-token",
    label: "GITHUB_TOKEN",
    kind: "secret",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{82,255})\b/g,
    verify: notFiller,
    source: GITLEAKS,
  },
  {
    id: "gitlab-pat",
    label: "GITLAB_TOKEN",
    kind: "secret",
    pattern: /\bglpat-[A-Za-z0-9_-]{20,128}(?:\.[A-Za-z0-9_-]{2,128}){0,3}(?![\w-])/g,
    verify: notFiller,
    source: GITLEAKS,
  },
  {
    id: "slack-token",
    label: "SLACK_TOKEN",
    kind: "secret",
    pattern: /\bxox[abprs]-[0-9]{8,14}-[A-Za-z0-9-]{10,250}(?![\w-])/g,
    verify: notFiller,
    source: GITLEAKS,
  },
  {
    id: "slack-webhook",
    label: "SLACK_WEBHOOK",
    kind: "secret",
    pattern: /(?:https?:\/\/)?hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9+/]{43,56}(?![A-Za-z0-9+/])/g,
    verify: notFiller,
    source: GITLEAKS,
  },
  {
    id: "stripe-live-key",
    label: "STRIPE_KEY",
    kind: "secret",
    pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,247}\b/g,
    verify: notFiller,
    source: GITLEAKS,
  },
  {
    id: "sendgrid-key",
    label: "SENDGRID_KEY",
    kind: "secret",
    pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![\w-])/g,
    verify: notFiller,
    source: GITLEAKS,
  },
  {
    id: "twilio-key",
    label: "TWILIO_KEY",
    kind: "secret",
    pattern: /\bSK[0-9a-fA-F]{32}\b/g,
    verify: notFiller,
    source: GITLEAKS,
  },
  {
    id: "google-api-key",
    label: "GOOGLE_API_KEY",
    kind: "secret",
    pattern: /\bAIza[0-9A-Za-z_-]{35}(?![\w-])/g,
    verify: notFiller,
    source: GITLEAKS,
  },
  {
    id: "google-oauth-secret",
    label: "GOOGLE_OAUTH_SECRET",
    kind: "secret",
    pattern: /\bGOCSPX-[A-Za-z0-9_-]{28}(?![\w-])/g,
    verify: notFiller,
    source: GITHUB_PATTERNS,
  },
  {
    id: "anthropic-key",
    label: "ANTHROPIC_KEY",
    kind: "secret",
    pattern: /\bsk-ant-[a-z]{3,8}\d{2}-[A-Za-z0-9_-]{32,200}(?![\w-])/g,
    verify: notFiller,
    source: GITLEAKS,
  },
  {
    id: "openai-key",
    label: "OPENAI_KEY",
    kind: "secret",
    pattern: /\bsk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,250}|[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}|[A-Za-z0-9]{48})(?![\w-])/g,
    verify: notFiller,
    source: GITLEAKS,
  },
  {
    id: "huggingface-token",
    label: "HF_TOKEN",
    kind: "secret",
    pattern: /\bhf_[A-Za-z]{34}\b/g,
    verify: notFiller,
    source: GITLEAKS,
  },
  {
    id: "npm-token",
    label: "NPM_TOKEN",
    kind: "secret",
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/g,
    verify: notFiller,
    source: GITLEAKS,
  },
  {
    id: "pypi-token",
    label: "PYPI_TOKEN",
    kind: "secret",
    pattern: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,1000}(?![\w-])/g,
    source: GITLEAKS,
  },
  {
    id: "azure-storage-key",
    label: "AZURE_STORAGE_KEY",
    kind: "secret",
    pattern: /(?:AccountKey|azure[_.-]?storage[_.-]?(?:account[_.-]?)?key|storage[_.-]?account[_.-]?key)["'`]?[ \t]{0,5}[=:][ \t]{0,5}["'`]?([A-Za-z0-9+]{86}==)/gi,
    group: 1,
    verify: notFiller,
    source: "https://learn.microsoft.com/en-us/azure/storage/common/storage-configure-connection-string",
  },
  {
    id: "jwt",
    label: "JWT",
    kind: "secret",
    pattern: /\beyJ[A-Za-z0-9_-]{10,4096}\.ey[A-Za-z0-9_-]{10,16384}\.[A-Za-z0-9_-]{0,4096}(?![\w-])/g,
    verify: jwtHeaderHasAlg,
    source: "https://datatracker.ietf.org/doc/html/rfc7519",
  },
  {
    id: "private-key",
    label: "PRIVATE_KEY",
    kind: "secret",
    // the body never holds five dashes, so a BEGIN without an END stops at the next marker instead of scanning 16 KB
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----(?:[^-]|-{1,4}(?!-)){16,65536}?-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/g,
    source: GITLEAKS,
  },
  {
    id: "private-key-truncated",
    label: "PRIVATE_KEY",
    kind: "secret",
    // a key cut off before its END line; separators may be real or JSON-escaped newlines, lines may be indented.
    // The base64 class has no newline, backslash or space, so each line can split only one way.
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----[ \t]{0,16}(?:(?:\r?\n|\\r\\n|\\n)[ \t]{0,16}[A-Za-z][A-Za-z0-9-]{0,63}:[ \t][^\r\n\\]{0,256}){0,8}(?:(?:\r?\n|\\r\\n|\\n)[ \t]{0,16}(?=\r?\n|\\r\\n|\\n))?(?:(?:\r?\n|\\r\\n|\\n)[ \t]{0,16}[A-Za-z0-9+/=]{16,128}){2,2048}(?![A-Za-z0-9+/=])/g,
    source: "https://www.rfc-editor.org/rfc/rfc7468",
  },
  {
    id: "db-connection-url",
    label: "DB_URL",
    kind: "secret",
    pattern: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^\s:@/'"`<>]{0,128}:[^\s@/'"`<>]{1,256}@[^\s/'"`<>?#@(){}[\],;]{1,256}(?:[/?#][^\s'"`<>(){}[\],;]{0,1024})?/gi,
    verify: dbUrlHasRealPassword,
    before: notTemplated,
    source: GITHUB_PATTERNS,
  },
  {
    id: "auth-header",
    label: "AUTH_HEADER",
    kind: "secret",
    pattern: /\bAuthorization["']?[ \t]{0,5}[:=：][ \t]{0,5}["']?(?:Bearer|Basic|Token)[ \t]{1,5}([A-Za-z0-9._~+/=-]{8,4096})/gi,
    group: 1,
    // template slots (`Bearer {{token}}` in docs), keyword+digit filler (`token123`) and
    // short dictionary-ish strings are not credentials
    verify: (v) =>
      plausibleSecret(v) &&
      !placeholderShaped(v) &&
      entropy(v) >= 2.8 &&
      !/^(?:token|secret|key|password|passwd|bearer|basic|auth|credential)[_-]?\d{0,8}$/i.test(v),
    source: "https://www.rfc-editor.org/rfc/rfc9110#name-authorization",
  },
  {
    id: "generic-secret-quoted",
    label: "SECRET",
    kind: "secret",
    pattern: /(?:api[_-]?key|secret(?:[_-]?key)?|token|password|passwd|pwd|auth|credential|密码|密钥|秘钥|口令|令牌|授权码|授权密钥|访问令牌|访问密钥|凭证|凭据|私钥)s?["'`]?[ \t]{0,5}(?::=|=>|[=:]|：)[ \t]{0,5}["'`]([^\s"'`]{8,256})["'`]/gi,
    group: 1,
    verify: quotedSecret,
    before: keywordStart,
    source: GITLEAKS,
  },
  {
    id: "generic-secret",
    label: "SECRET",
    kind: "secret",
    // a literal \n, \r or \t (backslash and letter) ends the value, as in a dotenv string inside source code
    pattern: /(?:api[_-]?key|secret(?:[_-]?key)?|token|password|passwd|pwd|auth|credential|密码|密钥|秘钥|口令|令牌|授权码|授权密钥|访问令牌|访问密钥|凭证|凭据|私钥)s?["'`]?[ \t]{0,5}(?::=|=>|[=:]|：)[ \t]{0,5}((?:[^\s"'`;,(){}<>[\]\\]|\\(?![nrt])){8,256})(?!(?!\\[nrt])[^\s"'`;,(){}<>[\]])/gi,
    group: 1,
    verify: bareSecret,
    before: keywordStart,
    source: GITLEAKS,
  },
];

// ---------------------------------------------------------------------------
// base64-wrapped detection (a run whose decoded text trips a prefix rule)
// ---------------------------------------------------------------------------

const WRAPPABLE = new Set([
  "aws-access-key", "github-token", "gitlab-pat", "slack-token", "slack-webhook", "stripe-live-key", "sendgrid-key",
  "twilio-key", "google-api-key", "google-oauth-secret", "anthropic-key", "openai-key", "huggingface-token",
  "npm-token", "pypi-token", "private-key", "private-key-truncated", "db-connection-url", "jwt",
]);
const B64_MIN = 24;
const B64_MAX = 8192;
const B64_RUNS = 200;

const B64_VALUE = new Int8Array(128).fill(-1);
for (let i = 0; i < 64; i++) B64_VALUE[B64URL.charCodeAt(i)] = i;
B64_VALUE[43] = 62; // +
B64_VALUE[47] = 63; // /

function b64Value(code: number): number {
  return code < 128 ? B64_VALUE[code]! : -1;
}

// Maximal runs of the base64 alphabet (standard or url-safe, never mixed) with optional padding.
function base64Runs(text: string): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let i = 0;
  while (i < text.length && runs.length < B64_RUNS) {
    if (b64Value(text.charCodeAt(i)) < 0) {
      i++;
      continue;
    }
    let j = i;
    let std = false;
    let url = false;
    for (; j < text.length; j++) {
      const c = text.charCodeAt(j);
      if (b64Value(c) < 0) break;
      if (c === 43 || c === 47) std = true;
      else if (c === 45 || c === 95) url = true;
    }
    let k = j;
    while (k < text.length && k - j < 2 && text.charCodeAt(k) === 61) k++;
    const body = j - i;
    const total = k - i;
    const shaped = k > j ? total % 4 === 0 : body % 4 === 0 || (!std && body % 4 !== 1);
    if (total >= B64_MIN && total <= B64_MAX && !(std && url) && shaped) runs.push([i, k]);
    i = k;
  }
  return runs;
}

function decodePrintable(text: string, start: number, end: number): string | null {
  let stop = end;
  while (stop > start && text.charCodeAt(stop - 1) === 61) stop--;
  const maxBad = Math.floor(((stop - start) * 3) / 40);
  let bad = 0;
  let acc = 0;
  let bits = 0;
  let out = "";
  for (let i = start; i < stop; i++) {
    acc = ((acc << 6) | b64Value(text.charCodeAt(i))) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      const byte = (acc >> bits) & 0xff;
      if (!(byte >= 0x20 && byte <= 0x7e) && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && ++bad > maxBad) return null;
      out += String.fromCharCode(byte);
    }
  }
  return out;
}

function firstWrappedRule(decoded: string): number {
  for (let order = 0; order < RULES.length; order++) {
    const rule = RULES[order]!;
    if (!WRAPPABLE.has(rule.id)) continue;
    const re = compile(rule.pattern).re;
    const g = rule.group ?? 0;
    re.lastIndex = 0;
    for (let m = re.exec(decoded); m !== null; m = re.exec(decoded)) {
      const raw = m[g];
      if (raw && (!rule.before || rule.before(decoded, m.index)) && (!rule.verify || rule.verify(raw))) {
        re.lastIndex = 0;
        return order;
      }
      re.lastIndex = m.index + 1;
    }
    re.lastIndex = 0;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------

export interface ScanOptions {
  /** Disable rules by id (also accepts `${id}-base64`). */
  off?: ReadonlySet<string>;
  /** Cap scanning to the first N bytes of text (performance guard). */
  maxBytes?: number;
}

interface Compiled {
  re: RegExp;
  indexed: boolean;
}
const compiledCache = new Map<RegExp, Compiled>();

function compile(pattern: RegExp): Compiled {
  let c = compiledCache.get(pattern);
  if (c) return c;
  let flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g";
  try {
    if (!flags.includes("d")) flags = flags + "d";
    c = { re: new RegExp(pattern.source, flags), indexed: true };
  } catch {
    c = { re: new RegExp(pattern.source, pattern.flags), indexed: false };
  }
  compiledCache.set(pattern, c);
  return c;
}

/** Matches our own placeholders (`[REDACTED:name]` / `[REDACTED:LABEL#ab12cd34]`). */
export const PLACEHOLDER_RE = /\[REDACTED:[A-Za-z0-9_-]{1,64}(?:#[0-9a-fA-F]{1,16})?\]/g;

/**
 * Scan text for secret-shaped values. Returns non-overlapping hits in
 * positional order; placeholder spans already present in the text are
 * protected from matching.
 */
export function scan(text: string, opts: ScanOptions = {}): Hit[] {
  const head = opts.maxBytes && text.length > opts.maxBytes ? text.slice(0, opts.maxBytes) : text;
  const spans: Array<[number, number]> = [];
  PLACEHOLDER_RE.lastIndex = 0;
  let masked = head;
  for (let m = PLACEHOLDER_RE.exec(head); m !== null; m = PLACEHOLDER_RE.exec(head)) {
    spans.push([m.index, m.index + m[0].length]);
  }
  if (spans.length > 0) {
    // spaces keep every offset stable while no rule can match through a placeholder
    let out = "";
    let at = 0;
    for (const [s, e] of spans) {
      out += head.slice(at, s) + " ".repeat(e - s);
      at = e;
    }
    masked = out + head.slice(at);
  }

  type Ranked = Hit & { order: number };
  const found: Ranked[] = [];
  RULES.forEach((rule, order) => {
    if (opts.off?.has(rule.id)) return;
    const { re, indexed } = compile(rule.pattern);
    const g = rule.group ?? 0;
    re.lastIndex = 0;
    for (let m = re.exec(masked); m !== null; m = re.exec(masked)) {
      if (m[0] === "") {
        re.lastIndex++;
        continue;
      }
      const raw = m[g];
      if (raw === undefined || raw === "") continue;
      const start = indexed ? (m.indices?.[g]?.[0] ?? -1) : m.index + m[0].lastIndexOf(raw);
      if (start < 0) continue;
      const end = start + raw.length;
      const value = head.slice(start, end);
      const inPlaceholder = spans.some(([s, e]) => start < e && end > s);
      if (inPlaceholder || (rule.before && !rule.before(masked, m.index)) || (rule.verify && !rule.verify(value))) {
        re.lastIndex = m.index + 1;
        continue;
      }
      found.push({ id: rule.id, label: rule.label, kind: rule.kind, start, end, value, order });
      re.lastIndex = m.index + raw.length - 1 + 1;
    }
    re.lastIndex = 0;
  });

  // one bounded decode pass: a base64 run whose decoded text trips a prefix rule is redacted whole
  for (const [start, end] of base64Runs(masked)) {
    const decoded = decodePrintable(masked, start, end);
    if (decoded === null) continue;
    const order = firstWrappedRule(decoded);
    if (order < 0) continue;
    const rule = RULES[order]!;
    found.push({ id: `${rule.id}-base64`, label: rule.label, kind: rule.kind, start, end, value: head.slice(start, end), order });
  }

  found.sort((a, b) => a.start - b.start || b.end - a.end || a.order - b.order);
  const hits: Hit[] = [];
  let lastEnd = -1;
  for (const h of found) {
    if (h.start < lastEnd) continue;
    hits.push({ id: h.id, label: h.label, kind: h.kind, start: h.start, end: h.end, value: h.value });
    lastEnd = h.end;
  }
  return hits;
}
