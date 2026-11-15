/* @aiti-ai/dsh-secret-mask · host bundle (core inlined, @deepseek-ai/* external) · do not edit */

// src/index.ts
import z from "@deepseek-ai/schemastery";

// src/state.ts
import { randomBytes } from "node:crypto";

// src/core/detect.ts
function entropy(v) {
  if (!v) return 0;
  const counts = /* @__PURE__ */ new Map();
  for (const ch of v) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / v.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}
function fnv1a(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
var B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function base64urlDecode(s) {
  let acc = 0;
  let bits = 0;
  let out = "";
  for (const ch of s.replace(/=+$/, "")) {
    let v = B64URL.indexOf(ch);
    if (ch === "+") v = 62;
    else if (ch === "/") v = 63;
    if (v < 0) return null;
    acc = (acc << 6 | v) & 16777215;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode(acc >> bits & 255);
    }
  }
  return out;
}
function jwtHeaderHasAlg(token) {
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
var NOT_SECRETS = /* @__PURE__ */ new Set([
  "true",
  "false",
  "null",
  "none",
  "nil",
  "undefined",
  "changeme",
  "password",
  "passw0rd",
  "secret",
  "token",
  "placeholder",
  "redacted",
  "example",
  "default",
  "required",
  "optional"
]);
function plausibleSecret(v) {
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
function placeholderShaped(v) {
  return /^(?:\{\{|<|__|%)|(?:\}\}|>|__)$|^[A-Za-z_]+=$/.test(v);
}
function notFiller(v) {
  return entropy(v) >= 2.5 && !/x{6,}|X{6,}|0{8,}|EXAMPLE/.test(v);
}
function quotedSecret(v) {
  return plausibleSecret(v) && !placeholderShaped(v) && entropy(v) >= 2 && !/^[a-z]+(?:[-_.][a-z]*)+$/.test(v);
}
function codeIdentifier(v) {
  const digits = v.replace(/\D/g, "").length;
  const upper = v.replace(/[^A-Z]/g, "").length;
  const letters = v.replace(/[^A-Za-z]/g, "").length;
  return /^[A-Za-z][A-Za-z0-9]*$/.test(v) && digits <= 2 && upper > 0 && upper * 3 <= letters;
}
function codeExpression(v) {
  if (v.includes("?.") || codeIdentifier(v)) return true;
  const parts = v.split(".");
  return parts.length > 1 && parts.every((p) => /^[A-Za-z_$][\w$]*$/.test(p) && p.replace(/\D/g, "").length <= 2);
}
function bareSecret(v) {
  if (!plausibleSecret(v) || placeholderShaped(v) || entropy(v) < 3) return false;
  if (!/\d/.test(v) && /^[A-Za-z_$][\w$]*(?:[.\-][A-Za-z_$][\w$]*)*$/.test(v)) return false;
  return !codeExpression(v);
}
function keywordStart(text, at) {
  if (at === 0) return true;
  const prev = text.charAt(at - 1);
  if (prev === ":") return false;
  if (/[\u4e00-\u9fff]/.test(prev) || /[\u4e00-\u9fff]/.test(text.charAt(at))) return true;
  if (!/[A-Za-z0-9]/.test(prev) || /\\[nrt]$/.test(text.slice(Math.max(0, at - 2), at))) return true;
  return /^[A-Z][a-z]/.test(text.slice(at, at + 2)) && !(/o/i.test(prev) && /^auth/i.test(text.slice(at, at + 4)));
}
function dbUrlHasRealPassword(url) {
  const password = /^[^:]+:\/\/[^:@/]*:([^@/]*)@/.exec(url)?.[1] ?? "";
  return password.length > 0 && plausibleSecret(password) && !/^(?:pass|pwd|secret|password|%[sd]|\{\{.*\}\}|<.*>)$/i.test(password);
}
function notTemplated(text, at) {
  return text.slice(Math.max(0, at - 2), at) !== "{{";
}
var GITLEAKS = "https://github.com/gitleaks/gitleaks";
var GITHUB_PATTERNS = "https://docs.github.com/code-security/secret-scanning";
var RULES = [
  {
    id: "aws-access-key",
    label: "AWS_KEY",
    kind: "secret",
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b/g,
    verify: notFiller,
    source: GITLEAKS
  },
  {
    id: "aws-secret-key",
    label: "AWS_SECRET",
    kind: "secret",
    pattern: /(?:aws[_.-]?secret[_.-]?(?:access[_.-]?)?key|secret[_.-]?access[_.-]?key)["'`]?[ \t]{0,5}(?::=|=>|[=:]|：)[ \t]{0,5}["'`]?([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+=])/gi,
    group: 1,
    verify: (v) => entropy(v) >= 3.5 && !/EXAMPLE/.test(v),
    source: "https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html"
  },
  {
    id: "github-token",
    label: "GITHUB_TOKEN",
    kind: "secret",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{82,255})\b/g,
    verify: notFiller,
    source: GITLEAKS
  },
  {
    id: "gitlab-pat",
    label: "GITLAB_TOKEN",
    kind: "secret",
    pattern: /\bglpat-[A-Za-z0-9_-]{20,128}(?:\.[A-Za-z0-9_-]{2,128}){0,3}(?![\w-])/g,
    verify: notFiller,
    source: GITLEAKS
  },
  {
    id: "slack-token",
    label: "SLACK_TOKEN",
    kind: "secret",
    pattern: /\bxox[abprs]-[0-9]{8,14}-[A-Za-z0-9-]{10,250}(?![\w-])/g,
    verify: notFiller,
    source: GITLEAKS
  },
  {
    id: "slack-webhook",
    label: "SLACK_WEBHOOK",
    kind: "secret",
    pattern: /(?:https?:\/\/)?hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9+/]{43,56}(?![A-Za-z0-9+/])/g,
    verify: notFiller,
    source: GITLEAKS
  },
  {
    id: "stripe-live-key",
    label: "STRIPE_KEY",
    kind: "secret",
    pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,247}\b/g,
    verify: notFiller,
    source: GITLEAKS
  },
  {
    id: "sendgrid-key",
    label: "SENDGRID_KEY",
    kind: "secret",
    pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![\w-])/g,
    verify: notFiller,
    source: GITLEAKS
  },
  {
    id: "twilio-key",
    label: "TWILIO_KEY",
    kind: "secret",
    pattern: /\bSK[0-9a-fA-F]{32}\b/g,
    verify: notFiller,
    source: GITLEAKS
  },
  {
    id: "google-api-key",
    label: "GOOGLE_API_KEY",
    kind: "secret",
    pattern: /\bAIza[0-9A-Za-z_-]{35}(?![\w-])/g,
    verify: notFiller,
    source: GITLEAKS
  },
  {
    id: "google-oauth-secret",
    label: "GOOGLE_OAUTH_SECRET",
    kind: "secret",
    pattern: /\bGOCSPX-[A-Za-z0-9_-]{28}(?![\w-])/g,
    verify: notFiller,
    source: GITHUB_PATTERNS
  },
  {
    id: "anthropic-key",
    label: "ANTHROPIC_KEY",
    kind: "secret",
    pattern: /\bsk-ant-[a-z]{3,8}\d{2}-[A-Za-z0-9_-]{32,200}(?![\w-])/g,
    verify: notFiller,
    source: GITLEAKS
  },
  {
    id: "openai-key",
    label: "OPENAI_KEY",
    kind: "secret",
    pattern: /\bsk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,250}|[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}|[A-Za-z0-9]{48})(?![\w-])/g,
    verify: notFiller,
    source: GITLEAKS
  },
  {
    id: "huggingface-token",
    label: "HF_TOKEN",
    kind: "secret",
    pattern: /\bhf_[A-Za-z]{34}\b/g,
    verify: notFiller,
    source: GITLEAKS
  },
  {
    id: "npm-token",
    label: "NPM_TOKEN",
    kind: "secret",
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/g,
    verify: notFiller,
    source: GITLEAKS
  },
  {
    id: "pypi-token",
    label: "PYPI_TOKEN",
    kind: "secret",
    pattern: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,1000}(?![\w-])/g,
    source: GITLEAKS
  },
  {
    id: "azure-storage-key",
    label: "AZURE_STORAGE_KEY",
    kind: "secret",
    pattern: /(?:AccountKey|azure[_.-]?storage[_.-]?(?:account[_.-]?)?key|storage[_.-]?account[_.-]?key)["'`]?[ \t]{0,5}[=:][ \t]{0,5}["'`]?([A-Za-z0-9+]{86}==)/gi,
    group: 1,
    verify: notFiller,
    source: "https://learn.microsoft.com/en-us/azure/storage/common/storage-configure-connection-string"
  },
  {
    id: "jwt",
    label: "JWT",
    kind: "secret",
    pattern: /\beyJ[A-Za-z0-9_-]{10,4096}\.ey[A-Za-z0-9_-]{10,16384}\.[A-Za-z0-9_-]{0,4096}(?![\w-])/g,
    verify: jwtHeaderHasAlg,
    source: "https://datatracker.ietf.org/doc/html/rfc7519"
  },
  {
    id: "private-key",
    label: "PRIVATE_KEY",
    kind: "secret",
    // the body never holds five dashes, so a BEGIN without an END stops at the next marker instead of scanning 16 KB
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----(?:[^-]|-{1,4}(?!-)){16,65536}?-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/g,
    source: GITLEAKS
  },
  {
    id: "private-key-truncated",
    label: "PRIVATE_KEY",
    kind: "secret",
    // a key cut off before its END line; separators may be real or JSON-escaped newlines, lines may be indented.
    // The base64 class has no newline, backslash or space, so each line can split only one way.
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----[ \t]{0,16}(?:(?:\r?\n|\\r\\n|\\n)[ \t]{0,16}[A-Za-z][A-Za-z0-9-]{0,63}:[ \t][^\r\n\\]{0,256}){0,8}(?:(?:\r?\n|\\r\\n|\\n)[ \t]{0,16}(?=\r?\n|\\r\\n|\\n))?(?:(?:\r?\n|\\r\\n|\\n)[ \t]{0,16}[A-Za-z0-9+/=]{16,128}){2,2048}(?![A-Za-z0-9+/=])/g,
    source: "https://www.rfc-editor.org/rfc/rfc7468"
  },
  {
    id: "db-connection-url",
    label: "DB_URL",
    kind: "secret",
    pattern: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^\s:@/'"`<>]{0,128}:[^\s@/'"`<>]{1,256}@[^\s/'"`<>?#@(){}[\],;]{1,256}(?:[/?#][^\s'"`<>(){}[\],;]{0,1024})?/gi,
    verify: dbUrlHasRealPassword,
    before: notTemplated,
    source: GITHUB_PATTERNS
  },
  {
    id: "auth-header",
    label: "AUTH_HEADER",
    kind: "secret",
    pattern: /\bAuthorization["']?[ \t]{0,5}[:=：][ \t]{0,5}["']?(?:Bearer|Basic|Token)[ \t]{1,5}([A-Za-z0-9._~+/=-]{8,4096})/gi,
    group: 1,
    // template slots (`Bearer {{token}}` in docs), keyword+digit filler (`token123`) and
    // short dictionary-ish strings are not credentials
    verify: (v) => plausibleSecret(v) && !placeholderShaped(v) && entropy(v) >= 2.8 && !/^(?:token|secret|key|password|passwd|bearer|basic|auth|credential)[_-]?\d{0,8}$/i.test(v),
    source: "https://www.rfc-editor.org/rfc/rfc9110#name-authorization"
  },
  {
    id: "generic-secret-quoted",
    label: "SECRET",
    kind: "secret",
    pattern: /(?:api[_-]?key|secret(?:[_-]?key)?|token|password|passwd|pwd|auth|credential|密码|密钥|秘钥|口令|令牌|授权码|授权密钥|访问令牌|访问密钥|凭证|凭据|私钥)s?["'`]?[ \t]{0,5}(?::=|=>|[=:]|：)[ \t]{0,5}["'`]([^\s"'`]{8,256})["'`]/gi,
    group: 1,
    verify: quotedSecret,
    before: keywordStart,
    source: GITLEAKS
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
    source: GITLEAKS
  }
];
var WRAPPABLE = /* @__PURE__ */ new Set([
  "aws-access-key",
  "github-token",
  "gitlab-pat",
  "slack-token",
  "slack-webhook",
  "stripe-live-key",
  "sendgrid-key",
  "twilio-key",
  "google-api-key",
  "google-oauth-secret",
  "anthropic-key",
  "openai-key",
  "huggingface-token",
  "npm-token",
  "pypi-token",
  "private-key",
  "private-key-truncated",
  "db-connection-url",
  "jwt"
]);
var B64_MIN = 24;
var B64_MAX = 8192;
var B64_RUNS = 200;
var B64_VALUE = new Int8Array(128).fill(-1);
for (let i = 0; i < 64; i++) B64_VALUE[B64URL.charCodeAt(i)] = i;
B64_VALUE[43] = 62;
B64_VALUE[47] = 63;
function b64Value(code) {
  return code < 128 ? B64_VALUE[code] : -1;
}
function base64Runs(text) {
  const runs = [];
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
    const shaped = k > j ? total % 4 === 0 : body % 4 === 0 || !std && body % 4 !== 1;
    if (total >= B64_MIN && total <= B64_MAX && !(std && url) && shaped) runs.push([i, k]);
    i = k;
  }
  return runs;
}
function decodePrintable(text, start, end) {
  let stop = end;
  while (stop > start && text.charCodeAt(stop - 1) === 61) stop--;
  const maxBad = Math.floor((stop - start) * 3 / 40);
  let bad = 0;
  let acc = 0;
  let bits = 0;
  let out = "";
  for (let i = start; i < stop; i++) {
    acc = (acc << 6 | b64Value(text.charCodeAt(i))) & 16777215;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      const byte = acc >> bits & 255;
      if (!(byte >= 32 && byte <= 126) && byte !== 9 && byte !== 10 && byte !== 13 && ++bad > maxBad) return null;
      out += String.fromCharCode(byte);
    }
  }
  return out;
}
function firstWrappedRule(decoded) {
  for (let order = 0; order < RULES.length; order++) {
    const rule = RULES[order];
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
var compiledCache = /* @__PURE__ */ new Map();
function compile(pattern) {
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
var PLACEHOLDER_RE = /\[REDACTED:[A-Za-z0-9_-]{1,64}(?:#[0-9a-fA-F]{1,16})?\]/g;
function scan(text, opts = {}) {
  const head = opts.maxBytes && text.length > opts.maxBytes ? text.slice(0, opts.maxBytes) : text;
  const spans = [];
  PLACEHOLDER_RE.lastIndex = 0;
  let masked = head;
  for (let m = PLACEHOLDER_RE.exec(head); m !== null; m = PLACEHOLDER_RE.exec(head)) {
    spans.push([m.index, m.index + m[0].length]);
  }
  if (spans.length > 0) {
    let out = "";
    let at = 0;
    for (const [s, e] of spans) {
      out += head.slice(at, s) + " ".repeat(e - s);
      at = e;
    }
    masked = out + head.slice(at);
  }
  const found = [];
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
      if (raw === void 0 || raw === "") continue;
      const start = indexed ? m.indices?.[g]?.[0] ?? -1 : m.index + m[0].lastIndexOf(raw);
      if (start < 0) continue;
      const end = start + raw.length;
      const value = head.slice(start, end);
      const inPlaceholder = spans.some(([s, e]) => start < e && end > s);
      if (inPlaceholder || rule.before && !rule.before(masked, m.index) || rule.verify && !rule.verify(value)) {
        re.lastIndex = m.index + 1;
        continue;
      }
      found.push({ id: rule.id, label: rule.label, kind: rule.kind, start, end, value, order });
      re.lastIndex = m.index + raw.length - 1 + 1;
    }
    re.lastIndex = 0;
  });
  for (const [start, end] of base64Runs(masked)) {
    const decoded = decodePrintable(masked, start, end);
    if (decoded === null) continue;
    const order = firstWrappedRule(decoded);
    if (order < 0) continue;
    const rule = RULES[order];
    found.push({ id: `${rule.id}-base64`, label: rule.label, kind: rule.kind, start, end, value: head.slice(start, end), order });
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end || a.order - b.order);
  const hits = [];
  let lastEnd = -1;
  for (const h of found) {
    if (h.start < lastEnd) continue;
    hits.push({ id: h.id, label: h.label, kind: h.kind, start: h.start, end: h.end, value: h.value });
    lastEnd = h.end;
  }
  return hits;
}

// src/core/mask.ts
var MIN_REDACT_LENGTH = 6;
function stringLeaves(node, out = []) {
  if (typeof node === "string") out.push(node);
  else if (node && typeof node === "object") for (const child of Object.values(node)) stringLeaves(child, out);
  return out;
}
function redactForms(value) {
  const trimmed = value.trim();
  const forms = /* @__PURE__ */ new Set([value, trimmed]);
  let parts = null;
  if (/^[[{]/.test(trimmed)) {
    try {
      parts = stringLeaves(JSON.parse(trimmed));
    } catch {
      parts = null;
    }
  }
  if (parts || /\s/.test(trimmed)) {
    for (const part of parts ?? [trimmed]) {
      for (const run of part.match(/[A-Za-z0-9+/=_-]{20,}/g) ?? []) forms.add(run);
    }
  }
  return [...forms].filter((form) => form.length >= MIN_REDACT_LENGTH);
}
var Registry = class {
  byValue = /* @__PURE__ */ new Map();
  byPlaceholder = /* @__PURE__ */ new Map();
  /** value forms sorted longest-first, so a value containing another is replaced whole. */
  forms = [];
  get size() {
    return this.byValue.size;
  }
  entries() {
    return [...this.byValue.values()];
  }
  /** Look up an entry by its exact placeholder string. */
  byPlaceholderLookup(placeholder) {
    return this.byPlaceholder.get(placeholder);
  }
  registerManual(value, alias) {
    const trimmed = value.trim();
    if (trimmed.length < MIN_REDACT_LENGTH) return void 0;
    const existing = this.byValue.get(trimmed);
    if (existing && existing.source === "manual" && existing.alias === (alias ?? void 0)) {
      return { entry: existing, replaced: false };
    }
    let label = alias?.trim() ?? "";
    if (!label) label = `secret-${this.countManual() + 1}`;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(label)) label = label.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || `secret-${this.countManual() + 1}`;
    if (existing) this.removeEntry(existing);
    const placeholder = `[REDACTED:${label}]`;
    const entry = { placeholder, value: trimmed, label, alias: alias?.trim() || void 0, source: "manual" };
    if (this.byPlaceholder.has(placeholder) && this.byPlaceholder.get(placeholder) !== entry) {
      let n = 2;
      let p = `[REDACTED:${label}-${n}]`;
      while (this.byPlaceholder.has(p)) p = `[REDACTED:${label}-${++n}]`;
      entry.placeholder = p;
    }
    this.addEntry(entry);
    return { entry, replaced: existing !== void 0 };
  }
  registerAuto(value, ruleId, label, salt) {
    const trimmed = value.trim();
    if (trimmed.length < MIN_REDACT_LENGTH) return void 0;
    const existing = this.byValue.get(trimmed);
    if (existing) return { entry: existing, replaced: false };
    const placeholder = `[REDACTED:${label}#${fnv1a(salt + trimmed)}]`;
    if (this.byPlaceholder.has(placeholder)) return void 0;
    const entry = { placeholder, value: trimmed, label, source: "auto", ruleId };
    this.addEntry(entry);
    return { entry, replaced: false };
  }
  /** Auto-detect secrets in text and register them; returns newly added entries. */
  autoRegister(text, salt, opts = {}) {
    const max = opts.autoDetectMaxBytes ?? 256 * 1024;
    if (text.length > max) return [];
    let hits;
    try {
      hits = scan(text);
    } catch {
      return [];
    }
    const added = [];
    for (const hit of hits) {
      if (this.byValue.has(hit.value)) continue;
      const res = this.registerAuto(hit.value, hit.id, hit.label, salt);
      if (res) added.push(res.entry);
    }
    return added;
  }
  removeByLabel(label) {
    const entry = this.entries().find((e) => e.label === label || e.alias === label || e.placeholder === `[REDACTED:${label}]`);
    if (!entry) return false;
    this.removeEntry(entry);
    return true;
  }
  clear() {
    this.byValue.clear();
    this.byPlaceholder.clear();
    this.forms = [];
  }
  /** Replace all known value forms in text with placeholders. */
  redact(text) {
    if (!text || this.forms.length === 0) return { text, count: 0 };
    const hits = [];
    for (const { form, entry } of this.forms) {
      for (let at = text.indexOf(form); at !== -1; at = text.indexOf(form, at + 1)) {
        hits.push({ start: at, end: at + form.length, entry });
      }
    }
    if (hits.length === 0) return { text, count: 0 };
    hits.sort((a, b) => a.start - b.start || b.end - a.end);
    let out = "";
    let cursor = 0;
    let count = 0;
    let current = null;
    const flush = (hit) => {
      out += text.slice(cursor, hit.start) + hit.entry.placeholder;
      cursor = hit.end;
      count++;
    };
    for (const hit of hits) {
      if (current && hit.start < current.end) continue;
      if (current) flush(current);
      current = hit;
    }
    if (current) flush(current);
    return { text: out + text.slice(cursor), count };
  }
  /** Replace placeholders in text with their real values. Unknown placeholders pass through. */
  restore(text) {
    if (!text || this.byPlaceholder.size === 0) return { text, count: 0 };
    let count = 0;
    const out = text.replace(/\[REDACTED:[A-Za-z0-9_-]{1,64}(?:#[0-9a-fA-F]{1,16})?\]/g, (m) => {
      const entry = this.byPlaceholder.get(m);
      if (!entry) return m;
      count++;
      return entry.value;
    });
    return { text: out, count };
  }
  addEntry(entry) {
    this.byValue.set(entry.value, entry);
    this.byPlaceholder.set(entry.placeholder, entry);
    this.rebuildForms();
  }
  removeEntry(entry) {
    this.byValue.delete(entry.value);
    this.byPlaceholder.delete(entry.placeholder);
    this.rebuildForms();
  }
  rebuildForms() {
    const seen = /* @__PURE__ */ new Set();
    const list = [];
    for (const entry of this.byValue.values()) {
      for (const form of redactForms(entry.value)) {
        if (seen.has(form)) continue;
        seen.add(form);
        list.push({ form, entry });
      }
    }
    this.forms = list.sort((a, b) => b.form.length - a.form.length);
  }
  countManual() {
    let n = 0;
    for (const e of this.byValue.values()) if (e.source === "manual") n++;
    return n;
  }
};
function deepMapStrings(value, fn) {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const r = deepMapStrings(v, fn);
      if (r !== v) changed = true;
      return r;
    });
    return changed ? out : value;
  }
  if (value && typeof value === "object") {
    let changed = false;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const r = deepMapStrings(v, fn);
      if (r !== v) changed = true;
      out[k] = r;
    }
    return changed ? out : value;
  }
  return value;
}
function restoreDeep(obj, registry) {
  let count = 0;
  const mapped = deepMapStrings(obj, (s) => {
    const r = registry.restore(s);
    count += r.count;
    return r.text;
  });
  return { value: mapped, count };
}
function redactDeep(obj, registry) {
  let count = 0;
  const mapped = deepMapStrings(obj, (s) => {
    const r = registry.redact(s);
    count += r.count;
    return r.text;
  });
  return { value: mapped, count };
}
function auditPayload(payload, registry) {
  const leaksByLabel = /* @__PURE__ */ new Map();
  let strings = 0;
  let placeholders = 0;
  let leaks = 0;
  const walk = (node) => {
    if (typeof node === "string") {
      strings++;
      for (const entry of registry.entries()) {
        if (entry.value.length >= MIN_REDACT_LENGTH && node.includes(entry.value)) {
          leaks++;
          leaksByLabel.set(entry.label, (leaksByLabel.get(entry.label) ?? 0) + 1);
        }
      }
      const ph = node.match(/\[REDACTED:[A-Za-z0-9_-]{1,64}(?:#[0-9a-fA-F]{1,16})?\]/g);
      if (ph) placeholders += ph.length;
      return;
    }
    if (Array.isArray(node)) {
      for (const v of node) walk(v);
      return;
    }
    if (node && typeof node === "object") {
      for (const v of Object.values(node)) walk(v);
    }
  };
  walk(payload);
  return { strings, placeholders, leaks, leakedLabels: [...leaksByLabel.keys()] };
}

// src/core/commands.ts
import { homedir } from "node:os";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
var PERSIST_PATH = join(homedir(), ".dsh", "secret-mask.json");
function maskablePreview(entry) {
  const v = entry.value;
  if (v.length <= 8) return "*".repeat(v.length);
  return `${"*".repeat(Math.max(4, Math.min(16, v.length - 8)))}${v.slice(-4)}`;
}
function listText(state) {
  const entries = state.registry.entries();
  if (entries.length === 0) return "secret-mask: no registered values this session.";
  const lines = entries.map((e) => {
    const src = e.source === "manual" ? "manual" : `auto(${e.ruleId ?? "?"})`;
    return `- ${e.placeholder}  [${src}]  ${e.value.length} chars  …${maskablePreview(e)}`;
  });
  return `secret-mask: ${entries.length} value(s) registered:
${lines.join("\n")}`;
}
function statusText(state) {
  const n = state.registry.size;
  return `secret-mask: ${state.enabled ? "ON" : "OFF"}; ${n} value(s) registered; persistence ${state.persisted ? "saved for this workspace" : "off (session-only)"}; send-audit ${state.audit ? "ON" : "OFF"}${state.lastAudit ? `; last: ${state.lastAudit}` : ""}.`;
}
var AUDIT_LOG_PATH = join(homedir(), ".dsh", "secret-mask-audit.log");
function appendAuditLog(result, path = AUDIT_LOG_PATH) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(result) + "\n", { mode: 384 });
    return void 0;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
function readAuditTail(maxLines = 5, path = AUDIT_LOG_PATH) {
  try {
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}
function parseAdd(args) {
  const m = /\s+as\s+([A-Za-z0-9_-]{1,64})\s*$/.exec(args);
  if (m) return { value: args.slice(0, m.index).trim(), alias: m[1] };
  return { value: args.trim() };
}
function handleSecretCommand(state, rawArgs) {
  return handleSync(state, rawArgs.trim());
}
async function handleSync(state, args) {
  const [cmd, ...rest] = args.length ? args.split(/\s+/) : [""];
  const tail = args.slice(cmd.length).trim();
  switch (cmd) {
    case "":
    case "help": {
      return {
        ok: true,
        text: [
          "secret-mask commands:",
          "  /secret add <value> [as <alias>]   register a value (kept out of the session log)",
          "  /secret list                       show registered values (masked preview)",
          "  /secret remove <alias|label>       unregister one value",
          "  /secret clear                      unregister all",
          "  /secret on | off                   enable/disable redaction for this session",
          "  /secret status                     current state",
          "  /secret save | unload              persist values for this workspace / drop them",
          "  /secret audit [on|off|show]        per-send wire-payload proof log"
        ].join("\n")
      };
    }
    case "add": {
      const value = tail;
      if (!value) return { ok: false, text: "Usage: /secret add <value> [as <alias>]  (the value never reaches the model and is not written to the session log)" };
      const parsed = parseAdd(value);
      if (!parsed || !parsed.value) return { ok: false, text: "Usage: /secret add <value> [as <alias>]" };
      const res = state.registry.registerManual(parsed.value, parsed.alias);
      if (!res) return { ok: false, text: `secret-mask: value rejected (must be at least ${MIN_REDACT_LENGTH} characters).` };
      const note = res.replaced ? " (replaced previous entry for this value)" : "";
      return { ok: true, text: `secret-mask: registered ${res.entry.placeholder}${note}` };
    }
    case "list":
      return { ok: true, text: listText(state) };
    case "remove": {
      if (!tail) return { ok: false, text: "Usage: /secret remove <alias|label>" };
      const ok = state.registry.removeByLabel(tail);
      return ok ? { ok: true, text: `secret-mask: removed ${tail}.` } : { ok: false, text: `secret-mask: no entry matching "${tail}".` };
    }
    case "clear": {
      const n = state.registry.size;
      state.registry.clear();
      return { ok: true, text: `secret-mask: cleared ${n} value(s).` };
    }
    case "on":
    case "off": {
      state.enabled = cmd === "on";
      return { ok: true, text: `secret-mask: redaction ${state.enabled ? "enabled" : "disabled"} for this session.` };
    }
    case "audit": {
      const arg = tail.trim();
      if (arg === "on" || arg === "") {
        state.audit = true;
        return { ok: true, text: `secret-mask: send-audit ON — every model request is scanned for registered raw values; evidence appended to ${AUDIT_LOG_PATH}` };
      }
      if (arg === "off") {
        state.audit = false;
        return { ok: true, text: "secret-mask: send-audit OFF." };
      }
      if (arg === "show") {
        const lines = readAuditTail();
        return { ok: true, text: lines.length ? `secret-mask audit evidence (last ${lines.length}):
${lines.join("\n")}` : "secret-mask: no audit evidence yet (turn /secret audit on)." };
      }
      return { ok: false, text: "Usage: /secret audit [on|off|show]" };
    }
    case "status":
      return { ok: true, text: statusText(state) };
    case "save": {
      const err = savePersist(state);
      if (err) return { ok: false, text: `secret-mask: save failed: ${err}` };
      state.persisted = true;
      return { ok: true, text: `secret-mask: ${state.registry.size} value(s) persisted for ${state.cwd} (0600, values stay on this machine).` };
    }
    case "unload": {
      const err = clearPersist(state.cwd);
      state.persisted = false;
      if (err) return { ok: false, text: `secret-mask: unload failed: ${err}` };
      return { ok: true, text: `secret-mask: persisted values for ${state.cwd} removed (session entries kept).` };
    }
    default:
      return { ok: false, text: `secret-mask: unknown subcommand "${cmd}". Try /secret help.` };
  }
}
function savePersist(state, path = PERSIST_PATH) {
  try {
    let file = { version: 1, projects: {} };
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === 1 && parsed.projects) file = parsed;
    } catch {
    }
    file.projects[state.cwd] = state.registry.entries().map((e) => ({
      placeholder: e.placeholder,
      value: e.value,
      label: e.label,
      alias: e.alias,
      source: e.source,
      ruleId: e.ruleId
    }));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(file, null, 2), { mode: 384 });
    return void 0;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
function clearPersist(cwd, path = PERSIST_PATH) {
  try {
    let file = { version: 1, projects: {} };
    try {
      file = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return void 0;
    }
    delete file.projects[cwd];
    writeFileSync(path, JSON.stringify(file, null, 2), { mode: 384 });
    return void 0;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
function loadPersist(state, path = PERSIST_PATH) {
  let n = 0;
  let file;
  try {
    file = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return 0;
  }
  const bucket = file?.projects?.[state.cwd];
  if (!Array.isArray(bucket)) return 0;
  for (const e of bucket) {
    if (state.registry.byPlaceholderLookup(e.placeholder)) continue;
    const res = e.source === "manual" ? state.registry.registerManual(e.value, e.alias) : state.registry.registerAuto(e.value, e.ruleId ?? "unknown", e.label, state.salt);
    if (res) n++;
  }
  if (n > 0) state.persisted = true;
  return n;
}

// src/state.ts
var sessions = /* @__PURE__ */ new Map();
function stateFor(agentId, cfg) {
  const key = agentId && agentId.length ? agentId : "__global__";
  let st = sessions.get(key);
  if (!st) {
    st = {
      registry: new Registry(),
      enabled: cfg.enabled,
      salt: randomBytes(4).toString("hex"),
      cwd: cfg.workspaceDir || process.cwd(),
      persisted: false,
      audit: cfg.audit
    };
    sessions.set(key, st);
    loadPersist(st);
  }
  return st;
}
function dropSession(agentId) {
  if (agentId && agentId.length) sessions.delete(agentId);
}

// src/spans.ts
function isTextBlock(block) {
  return !!block && typeof block === "object" && block.type === "text" && typeof block.text === "string";
}
function rewriteTextBlock(block, fn) {
  if (!isTextBlock(block)) return { block, changed: false };
  const next = fn(block.text);
  if (next === block.text) return { block, changed: false };
  return { block: { ...block, text: next }, changed: true };
}
function redactUserMessage(message, st, autoDetect) {
  let changed = false;
  let newEntries = 0;
  const userAuthored = message.source?.kind === "user";
  const content = message.content.map((block) => {
    if (!isTextBlock(block) || !block.text) return block;
    if (autoDetect && userAuthored) newEntries += st.registry.autoRegister(block.text, st.salt).length;
    const res = st.registry.redact(block.text);
    if (res.count === 0) return block;
    changed = true;
    return { ...block, text: res.text };
  });
  if (!changed) return { message, changed: false, newEntries };
  return { message: { ...message, content }, changed: true, newEntries };
}

// src/hooks/pre-step.ts
function registerPreStep(ctx, cfg) {
  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    if (!decision || decision.kind === "reject" || !Array.isArray(decision.messages)) return decision;
    const st = stateFor(payload.agent?.id, cfg);
    if (!st.enabled) return decision;
    let changed = false;
    const messages = decision.messages.map((m) => {
      const r = redactUserMessage(m, st, cfg.autoDetect);
      if (r.changed) changed = true;
      return r.message;
    });
    if (!changed) return decision;
    return { ...decision, messages };
  });
}

// src/hooks/section.ts
var SECTION_KEY = "secret_masking";
var SECTION_TEXT = [
  "Some credential values in this conversation are hidden behind placeholders like",
  "[REDACTED:alias] or [REDACTED:LABEL#ab12cd34]. Each placeholder stands for one real",
  "secret value that the user knows; it is restored automatically when passed verbatim in",
  "tool arguments. Rules: never guess, shorten, transform or invent the underlying value;",
  "copy the placeholder exactly as shown whenever you need to reference the credential",
  "(file edits, commands, config); do not ask the user to paste the value into chat."
].join("\n");
function registerSection(ctx, cfg) {
  ctx.systemPrompt.section({
    name: SECTION_KEY,
    order: 150,
    // tool guidance band (100–199) per the system-prompt order convention
    text: (context) => {
      const scope = context?.scope;
      const st = stateFor(scope?.id, cfg);
      return st.enabled && st.registry.size > 0 ? SECTION_TEXT : "";
    }
  });
}

// src/hooks/post-execute.ts
function registerPostExecute(ctx, cfg) {
  ctx.on(
    "tools/post-execute",
    async (exec, result, next) => {
      const decision = await next();
      if (!decision || decision.kind !== "accept") return decision;
      const st = stateFor(exec.agent?.id, cfg);
      if (!st.enabled || st.registry.size === 0) return decision;
      if (Object.prototype.hasOwnProperty.call(decision, "value")) {
        const candidate = decision.value;
        if (candidate !== void 0 && candidate !== null && typeof candidate === "object") {
          let clone;
          try {
            clone = structuredClone(candidate);
          } catch {
            clone = void 0;
          }
          if (clone !== void 0) {
            const res = redactDeep(clone, st.registry);
            if (res.count > 0) return { kind: "accept", value: res.value };
          }
        } else if (typeof candidate === "string") {
          const res = st.registry.redact(candidate);
          if (res.count > 0) return { kind: "accept", value: res.text };
        }
      }
      const content = decision.content;
      if (Array.isArray(content)) {
        let changed = false;
        const nextContent = content.map((block) => {
          const r = rewriteTextBlock(block, (text) => st.registry.redact(text).text);
          if (r.changed) changed = true;
          return r.block;
        });
        if (changed) return { kind: "accept", content: nextContent };
      }
      return decision;
    }
  );
}

// src/hooks/shadow-tools.ts
var SHADOW_WHITELIST = ["bash", "write", "edit", "str_replace_editor"];
function registerShadowTools(ctx, cfg) {
  if (!cfg.restoreToolArgs) return;
  ctx.on("agent/session-start", (payload) => {
    const agent = payload?.agent;
    const actx = agent?.ctx;
    if (!agent || !actx?.tools) return;
    for (const name2 of SHADOW_WHITELIST) {
      const orig = actx.tools.get(name2);
      if (!orig) continue;
      const shadow = {
        ...orig,
        execute: async (args, exec) => {
          const st = stateFor(agent.id, cfg);
          let restored = args;
          if (st.enabled && st.registry.size > 0 && args !== null && typeof args === "object") {
            try {
              restored = restoreDeep(structuredClone(args), st.registry).value;
            } catch {
              restored = args;
            }
          }
          return orig.execute(restored, exec);
        }
      };
      actx.tools.register(shadow);
    }
    ctx.logger.info(`dsh-secret-mask: shadow restore tools registered for agent ${agent.id} (${SHADOW_WHITELIST.join(", ")})`);
  });
}

// src/hooks/audit.ts
function registerAudit(ctx, cfg, auditPath) {
  ctx.on("llm/stream", (options, next) => {
    const st = stateFor(options?.sessionId, cfg);
    if (st.enabled && st.audit && st.registry.size > 0) {
      const a = auditPayload({ system: options.system, messages: options.messages }, st.registry);
      const purpose = options.purpose ?? "conversation";
      st.lastAudit = `${a.leaks} leak(s), ${a.placeholders} placeholder(s)`;
      const err = appendAuditLog(
        {
          time: (/* @__PURE__ */ new Date()).toISOString(),
          sessionId: options.sessionId ?? "",
          purpose,
          strings: a.strings,
          placeholders: a.placeholders,
          leaks: a.leaks,
          leakedLabels: a.leakedLabels
        },
        auditPath
      );
      if (err) ctx.logger.warn("dsh-secret-mask: audit log write failed: " + err);
      if (a.leaks > 0) {
        ctx.logger.error(
          `secret-mask LEAK: ${a.leaks} registered value(s) found in the outgoing ${purpose} payload (${a.leakedLabels.join(", ")}) — check /secret audit show`
        );
      }
    }
    return next();
  });
}

// src/hooks/commands.ts
function registerSecretCommand(ctx, cfg) {
  const definition = {
    name: "secret",
    description: "Register/redact secrets: add <value> [as <alias>], list, remove, clear, on/off, status, save/unload, audit [on|off|show]",
    recordInput: false,
    handler: async (invocation) => {
      const st = stateFor(invocation.agent?.id, cfg);
      const outcome = await handleSecretCommand(st, invocation.rawInput ?? "");
      return outcome.ok ? { kind: "success", text: outcome.text } : { kind: "error", text: outcome.text };
    }
  };
  ctx.commands.register(definition);
}

// src/index.ts
var name = "dsh-secret-mask";
var inject = ["tools", "commands", "systemPrompt"];
var Config = z.object({
  enabled: z.boolean().default(true),
  autoDetect: z.boolean().default(true),
  restoreToolArgs: z.boolean().default(true),
  audit: z.boolean().default(false),
  workspaceDir: z.string().default(""),
  auditPath: z.string().default("")
});
function apply(ctx, config) {
  const cfg = {
    enabled: config.enabled ?? true,
    autoDetect: config.autoDetect ?? true,
    restoreToolArgs: config.restoreToolArgs ?? true,
    audit: config.audit ?? false,
    workspaceDir: config.workspaceDir || process.cwd(),
    auditPath: config.auditPath || void 0
  };
  registerPreStep(ctx, cfg);
  registerSection(ctx, cfg);
  registerPostExecute(ctx, cfg);
  registerShadowTools(ctx, cfg);
  registerAudit(ctx, cfg, cfg.auditPath);
  registerSecretCommand(ctx, cfg);
  ctx.on("agent/disposed", (payload) => {
    dropSession(payload?.agent?.id);
  });
  ctx.logger.info("dsh-secret-mask: hooked (pre-step redaction, secret_masking section, post-execute redaction, shadow restore, llm/stream audit, /secret command)");
}
export {
  Config,
  apply,
  inject,
  name
};
