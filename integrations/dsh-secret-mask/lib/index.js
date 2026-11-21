/* @aiti-ai/dsh-secret-mask · host bundle (core inlined, @deepseek-ai/* external) · do not edit */

// src/index.ts
import z from "@deepseek-ai/schemastery";

// src/state.ts
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

// ../../packages/secret-mask-core/dist/index.js
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { appendFileSync, chmodSync, existsSync, mkdirSync as mkdirSync2, readFileSync as readFileSync2, statSync as fileStat, writeFileSync as writeFileSync2 } from "node:fs";
import { basename, dirname as dirname2, resolve } from "node:path";
function fnv1a(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
var PLACEHOLDER_PREFIX = "rsec_";
var PLACEHOLDER_HASH_LEN = 8;
var STABLE_NAMESPACE = "vault";
function placeholderFromHash(hash) {
  return PLACEHOLDER_PREFIX + hash.slice(0, PLACEHOLDER_HASH_LEN);
}
var PLACEHOLDER_RE = /(?<![A-Za-z0-9_@$.-])rsec_[0-9a-f]{8}\b|\[REDACTED:[A-Za-z0-9_-]{1,64}(?:#[0-9a-fA-F]{1,16})?\]/g;
function findV2Placeholders(text) {
  if (!text) return [];
  return text.match(/(?<![A-Za-z0-9_@$.-])rsec_[0-9a-f]{8}\b/g) ?? [];
}
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
  "optional",
  // common copula-prose status words ("my password is incorrect") — ≥8 chars so they
  // would otherwise pass the length + entropy gates after `password is`
  "incorrect",
  "forgotten",
  "encrypted",
  "protected",
  "mismatch",
  "rejected",
  "verified"
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
  if (!plausibleSecret(v) || placeholderShaped(v) || entropy(v) < 2.5) return false;
  if (!/\d/.test(v) && /^[A-Za-z_$][\w$]*(?:[.\-][A-Za-z_$][\w$]*)*$/.test(v)) return false;
  if (!/\d/.test(v) && /^[a-z][a-z_-]*[.,;:!?]?$/.test(v)) return false;
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
var NEAR_KEYWORD = /(?:api[_-]?key|secret(?:[_-]?key)?|token|passw(?:or)?d|passwd|pwd|passphrase|credential|密码|密钥|秘钥|口令|令牌|授权码|授权密钥|访问令牌|访问密钥|凭证|凭据|私钥)/i;
var NEAR_WINDOW = 160;
function keywordNear(text, at) {
  return NEAR_KEYWORD.test(text.slice(Math.max(0, at - NEAR_WINDOW), at));
}
function assignedSecret(v) {
  if (v.length < 8 || !/[A-Za-z]/.test(v) || !/\d/.test(v)) return false;
  if (!plausibleSecret(v) || placeholderShaped(v) || entropy(v) < 2.8) return false;
  return !/\.(?:md|txt|json|ya?ml|toml|ini|conf|cfg|log|ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|sh|zsh|lock|env|html?|css|sql|xml|csv)$/i.test(v);
}
function insideTemplate(text, at) {
  const open = text.lastIndexOf("${", at);
  if (open === -1) return false;
  const close = text.indexOf("}", open);
  return close === -1 || close > at;
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
    // keyword then either an assignment operator or the natural-language copula
    // (`password is "xxx"`, `密码是"xxx"`) before the quoted value // cjk-ok
    pattern: /(?:api[_-]?key|secret(?:[_-]?key)?|token|password|passwd|pwd|auth|credential|密码|密钥|秘钥|口令|令牌|授权码|授权密钥|访问令牌|访问密钥|凭证|凭据|私钥)s?["'`]?(?:[ \t]{0,5}(?::=|=>|[=:]|：)|(?:[ \t]+is\b|是)[ \t]{0,5}(?::=|=>|[=:]|：)?)[ \t]{0,5}["'`]([^\s"'`]{8,256})["'`]/gi,
    group: 1,
    verify: quotedSecret,
    before: keywordStart,
    source: GITLEAKS
  },
  {
    id: "generic-secret-assign",
    label: "SECRET",
    kind: "secret",
    // keyword then an assignment verb: `密码改成 X`, `new password X`, `set the password to X` // cjk-ok
    pattern: /(?:api[_-]?key|secret(?:[_-]?key)?|token|password|passwd|pwd|passphrase|auth|credential|新密码|新口令|新的密码|密码|密钥|秘钥|口令|令牌|授权码|授权密钥|访问令牌|访问密钥|凭证|凭据|私钥)s?["'`]?(?:[ \t]+to\b|[ \t]{0,5}(?:改为|改到|改成|修改为|设置为|设置成|设为|设成|置为|配置为|配置成|换成|换为|变为|变成|重置为|重设为|更改为|更新为))[ \t:：]{0,5}["'`]?((?:[^\s"'`;,(){}<>[\]\\，。、；：！？“”‘’（）]|\\(?![nrt])){8,256})(?!(?!\\[nrt])[^\s"'`;,(){}<>[\]，。、；：！？“”‘’（）])/gi,
    group: 1,
    verify: (v) => bareSecret(v) || assignedSecret(v),
    before: keywordStart,
    source: GITLEAKS
  },
  {
    id: "new-password",
    label: "SECRET",
    kind: "secret",
    // a declared new password: `new password X`, `新密码 X` (no operator needed) // cjk-ok
    pattern: /(?:新密码|新的密码|新口令|new[ _-]?pass(?:word|phrase))[ \t]{0,5}["'`]?(?:[=:：]|是|为)?[ \t]{0,5}["'`]?((?:[^\s"'`;,(){}<>[\]\\，。、；：！？“”‘’（）]|\\(?![nrt])){8,256})(?!(?!\\[nrt])[^\s"'`;,(){}<>[\]，。、；：！？“”‘’（）])/gi,
    group: 1,
    verify: assignedSecret,
    before: keywordStart,
    source: GITLEAKS
  },
  {
    id: "assigned-value",
    label: "SECRET",
    kind: "secret",
    // assignment verb without an operator, gated by a credential keyword in the same passage
    // (`帮我设为 Kx7dyn4b91` after a sentence about 密码, `set it to ...`) // cjk-ok
    pattern: /(?:改为|改到|改成|修改为|设置为|设置成|设为|设成|置为|配置为|配置成|换成|换为|变为|变成|重置为|重设为|更改为|更新为|\b(?:reset|change|update|set)[ \t]+(?:it|them|this|that|the[ \t]+\w+)?[ \t]*to)[ \t:：]{0,5}["'`]?([A-Za-z0-9!@#$%^&*_+=~-]{8,128})["'`]?(?![A-Za-z0-9!@#$%^&*_+=~-])/g,
    group: 1,
    verify: assignedSecret,
    before: keywordNear,
    source: GITLEAKS
  },
  {
    id: "generic-secret",
    label: "SECRET",
    kind: "secret",
    // a literal \n, \r or \t (backslash and letter) ends the value, as in a dotenv string inside source code;
    // fullwidth CJK punctuation also ends the value (`密码：abc123，请记好` must not swallow the trailing prose) // cjk-ok
    // keyword then either an assignment operator or the natural-language copula (`password is xxx`, `密码是xxx`) // cjk-ok
    pattern: /(?:api[_-]?key|secret(?:[_-]?key)?|token|password|passwd|pwd|auth|credential|密码|密钥|秘钥|口令|令牌|授权码|授权密钥|访问令牌|访问密钥|凭证|凭据|私钥)s?["'`]?(?:[ \t]{0,5}(?::=|=>|[=:]|：)|(?:[ \t]+is\b|是)[ \t]{0,5}(?::=|=>|[=:]|：)?)[ \t]{0,5}((?:[^\s"'`;,(){}<>[\]\\，。、；：！？“”‘’（）]|\\(?![nrt])){8,256})(?!(?!\\[nrt])[^\s"'`;,(){}<>[\]，。、；：！？“”‘’（）])/gi,
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
      if (inPlaceholder || insideTemplate(masked, start) || rule.before && !rule.before(masked, m.index) || rule.verify && !rule.verify(value)) {
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
  constructor() {
    this.salt = "";
    this.byValue = /* @__PURE__ */ new Map();
    this.byPlaceholder = /* @__PURE__ */ new Map();
    this.redirects = /* @__PURE__ */ new Map();
    this.forms = [];
  }
  get size() {
    return this.byValue.size;
  }
  entries() {
    return [...this.byValue.values()];
  }
  /** Look up an entry by its exact placeholder string (current or redirected). */
  byPlaceholderLookup(placeholder) {
    return this.byPlaceholder.get(placeholder) ?? this.redirects.get(placeholder);
  }
  /** True when this exact value is already registered. */
  hasValue(value) {
    return this.byValue.has(value.trim());
  }
  /** True when a placeholder is mounted (present or redirected). */
  isMounted(placeholder) {
    return this.byPlaceholderLookup(placeholder) !== void 0;
  }
  /**
   * Register one value. `source` selects the placeholder namespace:
   * manual/auto → session-salted hash; vault → stable namespace hash.
   */
  register(value, source, opts = {}) {
    const trimmed = value.trim();
    if (trimmed.length < (opts.minLength ?? MIN_REDACT_LENGTH)) return void 0;
    const alias = opts.alias?.trim() || void 0;
    const existing = this.byValue.get(trimmed);
    if (existing && existing.source === source && existing.alias === alias && !opts.placeholder) {
      return { entry: existing, replaced: false };
    }
    const sameAlias = alias && (source === "manual" || source === "vault") ? this.entries().find((e) => e.source === source && e.alias === alias && e !== existing) : void 0;
    if (sameAlias) this.removeEntry(sameAlias, false);
    let label;
    if (alias) label = alias;
    else if (opts.label) label = opts.label;
    else if (source === "manual") label = `secret-${this.countSource("manual") + 1}`;
    else label = "SECRET";
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(label)) {
      label = label.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64) || "secret";
    }
    const stable = source === "vault" || Boolean(opts.namespace);
    const namespace = opts.namespace ?? STABLE_NAMESPACE;
    const salt = opts.salt ?? this.salt;
    const placeholder = opts.placeholder ? this.takeable(opts.placeholder, existing) ? opts.placeholder : void 0 : stable && alias ? this.generate((n) => fnv1a(`${namespace}:${alias}${n > 1 ? `#${n}` : ""}`), existing, trimmed) : source === "manual" && alias && !salt ? (
      // No salt available: keep a deterministic shape (hosts that never set
      // a salt still get cross-session placeholders).
      this.generate((n) => fnv1a(`manual:${alias}${n > 1 ? `#${n}` : ""}`), existing, trimmed)
    ) : this.generate((n) => fnv1a(`${salt}${trimmed}${n > 1 ? `#${n}` : ""}`), existing, trimmed);
    if (!placeholder) return void 0;
    if (existing) this.removeEntry(existing, existing.placeholder !== placeholder);
    const entry = {
      placeholder,
      value: trimmed,
      label,
      alias,
      source,
      ...opts.ruleId ? { ruleId: opts.ruleId } : {},
      ...stable ? { stable: true } : {}
    };
    this.addEntry(entry);
    return { entry, replaced: existing !== void 0 };
  }
  registerManual(value, alias, opts = {}) {
    return this.register(value, "manual", { ...opts, alias });
  }
  registerAuto(value, ruleId, label, salt, opts = {}) {
    return this.register(value, "auto", { ...opts, salt, label, ruleId });
  }
  /** Stable entry (vault): placeholder survives sessions and resume. */
  registerStable(value, alias, namespace = STABLE_NAMESPACE, opts = {}) {
    return this.register(value, "vault", { ...opts, alias, namespace });
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
  /** Remove by label, alias, or exact placeholder. */
  removeByLabel(label) {
    const entry = this.entries().find(
      (e) => e.label === label || e.alias === label || e.placeholder === label
    );
    if (!entry) return false;
    this.removeEntry(entry, true);
    return true;
  }
  /**
   * Remove an entry WITHOUT keeping a redirect — the placeholder stops
   * resolving, so the G7 guard blocks later references (`/vault forget`).
   */
  forgetByLabel(label) {
    const entry = this.entries().find((e) => e.label === label || e.alias === label || e.placeholder === label);
    if (!entry) return false;
    this.byValue.delete(entry.value);
    this.byPlaceholder.delete(entry.placeholder);
    this.redirects.delete(entry.placeholder);
    for (const [token, target] of this.redirects) if (target.value === entry.value) this.redirects.delete(token);
    this.rebuildForms();
    return true;
  }
  /** Drop a redirect (snapshot unload); keeps current entries intact. */
  clearRedirects() {
    this.redirects.clear();
  }
  redirectsSnapshot() {
    return Object.fromEntries([...this.redirects].map(([k, v]) => [k, v.placeholder]));
  }
  /** Redirected placeholder → entry (audit/guard support). */
  redirectEntries() {
    return [...this.redirects];
  }
  clear() {
    this.byValue.clear();
    this.byPlaceholder.clear();
    this.redirects.clear();
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
    const out = text.replace(new RegExp(PLACEHOLDER_RE.source, "g"), (m) => {
      const entry = this.byPlaceholderLookup(m);
      if (!entry) return m;
      count++;
      return entry.value;
    });
    return { text: out, count };
  }
  /** True when `placeholder` is free — or already belongs to this value/slot. */
  takeable(placeholder, existing) {
    const current = this.byPlaceholder.get(placeholder);
    if (!current || current === existing) return true;
    return current.value === existing?.value;
  }
  generate(seed, existing, value) {
    for (let n = 1; n <= 64; n++) {
      const p = placeholderFromHash(seed(n));
      const occupied = this.byPlaceholder.get(p);
      const redirected = this.redirects.get(p);
      const sameSlot = p === existing?.placeholder;
      const sameValue = value !== void 0 && (occupied?.value === value || redirected?.value === value);
      if ((!occupied || sameSlot || sameValue) && (!redirected || sameSlot || sameValue)) return p;
    }
    return void 0;
  }
  addEntry(entry) {
    this.byValue.set(entry.value, entry);
    this.byPlaceholder.set(entry.placeholder, entry);
    this.rebuildForms();
  }
  /**
   * Remove one entry. `follow` keeps a redirect from the old placeholder to
   * whatever entry replaces this value next (auto→manual upgrade path): the
   * model may still reference the previous placeholder in later turns.
   */
  removeEntry(entry, follow) {
    this.byValue.delete(entry.value);
    this.byPlaceholder.delete(entry.placeholder);
    if (follow) this.redirects.set(entry.placeholder, entry);
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
  countSource(source) {
    let n = 0;
    for (const e of this.byValue.values()) if (e.source === source) n++;
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
  const placeholderRe = new RegExp(PLACEHOLDER_RE.source, "g");
  const walk = (node) => {
    if (typeof node === "string") {
      strings++;
      for (const entry of registry.entries()) {
        if (entry.value.length >= MIN_REDACT_LENGTH && node.includes(entry.value)) {
          leaks++;
          leaksByLabel.set(entry.label, (leaksByLabel.get(entry.label) ?? 0) + 1);
        }
      }
      placeholders += (node.match(placeholderRe) ?? []).length;
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
var EXTRACT_MIN_LENGTH = MIN_REDACT_LENGTH;
var EXTRACT_MAX_BYTES = 256 * 1024;
var SENSITIVE_SEGMENT = /(?:^|[._-])(?:pass(?:word|wd|phrase)?|pwd|secret|token|credentials?|bearer|dsn)(?:$|[._-])/i;
var SENSITIVE_KEY_PREFIX = /(?:^|[._-])(?:api|access|private|secret|client)[_-]?key(?:$|[._-])/i;
var SENSITIVE_CONNECTION = /^(?:connection|conn)[_-]?(?:string|str)$/i;
var SENSITIVE_AUTH_TOKEN = /(?:^|[._-])auth[_-]?token(?:$|[._-])/i;
function isSensitiveKey(key) {
  const k = key.trim();
  if (!k) return false;
  if (/^authorization$/i.test(k)) return true;
  if (k.replace(/^[_-]+/, "") === "authToken") return true;
  return SENSITIVE_SEGMENT.test(k) || SENSITIVE_KEY_PREFIX.test(k) || SENSITIVE_CONNECTION.test(k) || SENSITIVE_AUTH_TOKEN.test(k) || /^_?authToken$/i.test(k);
}
var STOP_VALUES = /* @__PURE__ */ new Set(
  [
    "true",
    "false",
    "null",
    "none",
    "nil",
    "undefined",
    "yes",
    "no",
    "on",
    "off",
    "required",
    "optional",
    "default",
    "changeme",
    "example",
    "placeholder",
    "redacted",
    "dummy",
    "sample",
    "insert",
    "enabled",
    "disabled",
    "invalid",
    "expired",
    "configured",
    "incorrect",
    "forgotten",
    "encrypted",
    "protected",
    "mismatch",
    "rejected",
    "verified",
    "unknown",
    "hidden",
    "empty",
    "todo",
    "tbd",
    "string",
    "number",
    "boolean",
    "hash",
    "stored",
    "used",
    "set",
    "changed",
    "shown",
    "provided",
    "supplied",
    "managed",
    "rotated",
    "generated",
    "sent",
    "passed",
    "given",
    "needed",
    "accepted",
    "defined",
    "specified",
    "documented",
    "discussed",
    "reset",
    "updated",
    "saved",
    "checked",
    "validated"
  ]
);
function isPlaceholderish(v) {
  if (/^\[REDACTED:/.test(v)) return true;
  if (/^(?:\$\{.*\}|\$\(?[A-Za-z_]\w*\)?|%[A-Za-z_]\w*%|\{\{.*\}\}|<.*>|__.*__)$/.test(v)) return true;
  if (/^(?:process\.env|os\.environ|env\.|import\.meta\.env|vault:\/\/|file:\/\/|secret:\/\/)/i.test(v)) return true;
  if (/^[x*.]+$/i.test(v) || /^(?:x{4,}|\*{3,}|\.{3,})/.test(v)) return true;
  if (/\$\{|\{\{|process\.env\./.test(v)) return true;
  return false;
}
function cleanValue(raw, minLength) {
  let v = raw.trim();
  if (!v) return void 0;
  const quoted = /^(['"`])([\s\S]*)\1$/.exec(v);
  if (quoted) {
    v = quoted[2];
  } else {
    const comment = v.search(/\s+#/);
    if (comment > 0) v = v.slice(0, comment).trim();
  }
  if (v.length < minLength || v.length > 4096) return void 0;
  if (isPlaceholderish(v)) return void 0;
  if (STOP_VALUES.has(v.toLowerCase())) return void 0;
  return v;
}
function pushHit(out, seen, key, raw, format, minLength) {
  if (!isSensitiveKey(key)) return;
  if (/^authorization$/i.test(key) && format !== "header") return;
  const value = cleanValue(raw, minLength);
  if (!value) return;
  const dedupe = `${key.toLowerCase()}\0${value}`;
  if (seen.has(dedupe)) return;
  seen.add(dedupe);
  out.push({ key, value, format });
}
function extractJsonTree(value, out, seen, minLength) {
  if (Array.isArray(value)) {
    for (const item of value) extractJsonTree(item, out, seen, minLength);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string") pushHit(out, seen, key, child, "json", minLength);
    else extractJsonTree(child, out, seen, minLength);
  }
}
function tryJson(text, out, seen, minLength) {
  const trimmed = text.trim();
  const start = Math.min(...["{", "["].map((c) => trimmed.indexOf(c) < 0 ? Number.MAX_SAFE_INTEGER : trimmed.indexOf(c)));
  if (!Number.isFinite(start) || start === Number.MAX_SAFE_INTEGER) return false;
  let parsed;
  try {
    parsed = JSON.parse(trimmed.slice(start));
  } catch {
    return false;
  }
  extractJsonTree(parsed, out, seen, minLength);
  return true;
}
function extractStructuredSecrets(text, opts = {}) {
  const minLength = opts.minLength ?? 3;
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  if (!text) return out;
  tryJson(text, out, seen, minLength);
  for (const m of text.matchAll(/"([A-Za-z_][\w.-]*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
    let value = m[2];
    try {
      value = JSON.parse(`"${m[2]}"`);
    } catch {
    }
    pushHit(out, seen, m[1], value, "json", minLength);
  }
  for (const line of text.split(/\r?\n/)) {
    const eq = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=\s*(.+?)\s*$/.exec(line);
    if (eq) pushHit(out, seen, eq[1], eq[2], "env", minLength);
  }
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(?:#|\/\/|--)/.test(line)) continue;
    const kv = /^\s*([A-Za-z_][\w.-]*)\s*:\s*(.+?)\s*$/.exec(line);
    if (kv) pushHit(out, seen, kv[1], kv[2], "yaml", minLength);
  }
  for (const m of text.matchAll(/\bAuthorization\s*:\s*(?:Bearer|Basic|Token|Digest)\s+([^\s,;]+)/gi)) {
    pushHit(out, seen, "authorization", m[1], "header", minLength);
  }
  for (const m of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/([^/\s:@]+):([^/\s@]+)@/gi)) {
    pushHit(out, seen, "url-password", m[2], "url", minLength);
  }
  for (const m of text.matchAll(/^\s*(?:machine|default)\b.*?\bpassword\s+([^\s]+)/gim)) {
    pushHit(out, seen, "password", m[1], "netrc", minLength);
  }
  return out;
}
function labelFor(key) {
  return key.toUpperCase().replace(/[^A-Z0-9_.-]/g, "_").slice(0, 48) || "EXTRACTED";
}
function registerExtractedSecrets(text, registry, salt, opts = {}) {
  if (!text || text.length > EXTRACT_MAX_BYTES) return { count: 0, keys: [], entries: [] };
  const minLength = opts.minLength ?? EXTRACT_MIN_LENGTH;
  const keys = [];
  const entries = [];
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
var PRIVATE_KEY_FILE = /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i;
var KEY_FILE_EXT = /\.(?:key|p12|pfx|jks|keystore)$/i;
var CONFIG_EXT = /* @__PURE__ */ new Set(["", ".txt", ".env", ".conf", ".ini", ".properties", ".cfg", ".yml", ".yaml", ".json", ".toml", ".xml"]);
var SECRET_STEM = /(?:^|[._-])(?:secret|secrets|password|passwd|pwd|credential|credentials|token|apikey|api-key|private-key|db-password)(?:$|[._-])/i;
function inspectSensitivePath(input) {
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
    return { sensitive: true, dedicated: true, category: "key-file" };
  }
  const configLike = CONFIG_EXT.has(ext) || ext === "";
  if (configLike && (SECRET_STEM.test(stem) || /^(?:secret|secrets|password|passwd|pwd|credential|credentials|token)$/i.test(stem))) {
    const dedicated = ext === "" || ext === ".txt" || ext === ".conf" || ext === ".cfg";
    return { sensitive: true, dedicated, category: "secret-file" };
  }
  return { sensitive: false, dedicated: false };
}
var READ_COMMANDS = /* @__PURE__ */ new Set([
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "strings",
  "xxd",
  "od",
  "base64",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "sed",
  "awk",
  "cut",
  "sort",
  "uniq",
  "source",
  ".",
  "type",
  "Get-Content",
  "gc",
  "get-content"
]);
var PATTERN_FIRST = /* @__PURE__ */ new Set(["grep", "egrep", "fgrep", "rg", "ag", "sed", "awk"]);
var BARE_SENSITIVE = /* @__PURE__ */ new Set([
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "kubeconfig",
  "credentials",
  "secret",
  "secrets",
  "password",
  "passwd",
  "pwd",
  "token",
  "apikey",
  "api-key",
  "private-key",
  ".netrc",
  ".pgpass",
  ".npmrc",
  ".git-credentials"
]);
var WRITE_COMMANDS = /* @__PURE__ */ new Set(["tee", "Set-Content", "set-content", "Out-File", "out-file", "Add-Content", "add-content"]);
function dequote(token) {
  const t = token.trim();
  if (/^(['"]).*\1$/.test(t)) return t.slice(1, -1);
  return t;
}
function looksLikePath(token) {
  const t = dequote(token);
  if (!t || t.startsWith("-") || t.startsWith("$") || t.includes("=")) return false;
  return /[/\\]/.test(t) || /^\.[^.]/.test(t) || /\.[a-z0-9]{1,8}$/i.test(t) || BARE_SENSITIVE.has(t.toLowerCase());
}
function shellTokens(segment) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(segment); m; m = re.exec(segment)) tokens.push(m[1] ?? m[2] ?? m[3] ?? "");
  return tokens.filter(Boolean);
}
function bashTargets(command) {
  const reads = [];
  const writes = [];
  for (const rawSegment of command.split(/&&|\|\||[;|\n]/)) {
    const segment = rawSegment.trim();
    if (!segment) continue;
    for (const m of segment.matchAll(/(?:^|\s)(?:>>?)\s*([^\s;|&]+)/g)) writes.push(dequote(m[1]));
    for (const m of segment.matchAll(/(?:^|\s)<\s*([^\s;|&]+)/g)) reads.push(dequote(m[1]));
    const tokens = shellTokens(segment);
    if (tokens.length === 0) continue;
    const name2 = (tokens[0].split(/[/\\]/).pop() ?? "").toLowerCase();
    if (READ_COMMANDS.has(name2) || READ_COMMANDS.has(tokens[0])) {
      let start = 1;
      while (start < tokens.length && tokens[start].startsWith("-")) start++;
      if (PATTERN_FIRST.has(name2) || PATTERN_FIRST.has(tokens[0])) start++;
      for (const token of tokens.slice(start)) if (looksLikePath(token)) reads.push(dequote(token));
    } else if (WRITE_COMMANDS.has(name2)) {
      for (const token of tokens.slice(1)) if (!token.startsWith("-") && looksLikePath(token)) writes.push(dequote(token));
    }
  }
  return { reads, writes, contents: [command] };
}
function inspectToolTargets(toolName, input) {
  const i = input && typeof input === "object" ? input : {};
  const reads = [];
  const writes = [];
  const contents = [];
  const str = (v) => typeof v === "string" ? v : void 0;
  const path = str(i.path) ?? str(i.file_path) ?? str(i.filePath) ?? str(i.filename);
  const name2 = String(toolName ?? "").toLowerCase();
  if (name2 === "read" && path) reads.push(path);
  if ((name2 === "write" || name2 === "edit" || name2 === "apply_patch") && path) writes.push(path);
  for (const key of ["content", "text", "newText", "new_string", "newString", "patch"]) {
    const v = str(i[key]);
    if (v) contents.push(v);
  }
  const edits = i.edits;
  if (Array.isArray(edits)) {
    for (const e of edits) {
      const obj = e && typeof e === "object" ? e : {};
      for (const key of ["newText", "new_string", "content"]) {
        const v = str(obj[key]);
        if (v) contents.push(v);
      }
    }
  }
  const command = str(i.command) ?? str(i.script) ?? str(i.code);
  if (command && (name2 === "bash" || name2 === "powershell" || name2 === "shell" || name2 === "exec")) {
    const t = bashTargets(command);
    reads.push(...t.reads);
    writes.push(...t.writes);
    contents.push(command);
  } else if (command) {
    contents.push(command);
  }
  if (path && name2 !== "bash" && name2 !== "powershell" && name2 !== "shell" && name2 !== "exec" && !/write|edit|create|patch|append/i.test(name2)) {
    reads.push(path);
  }
  return { reads: [...new Set(reads)], writes: [...new Set(writes)], contents };
}
function registerValueSecrets(value, registry, salt, opts = {}) {
  let count = 0;
  const keys = [];
  const walk = (node) => {
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
      for (const item of Object.values(node)) walk(item);
    }
  };
  walk(value);
  return { count, keys: [...new Set(keys)] };
}
function sensitiveReadTargets(toolName, input) {
  return inspectToolTargets(toolName, input).reads.map((path) => ({ path, info: inspectSensitivePath(path) })).filter((x) => x.info.sensitive);
}
var WEAK_PASSWORDS = /* @__PURE__ */ new Set([
  "password",
  "passw0rd",
  "password1",
  "password12",
  "password123",
  "p@ssw0rd",
  "passw0rd1",
  "123456",
  "1234567",
  "12345678",
  "123456789",
  "1234567890",
  "0123456789",
  "9876543210",
  "123456a",
  "a123456",
  "a12345678",
  "rsec_035c2182",
  "abc123",
  "abc12345",
  "abcd1234",
  "abc123!",
  "qwerty",
  "qwertyui",
  "qwertyuiop",
  "qwerty12",
  "qwerty123",
  "qwe123",
  "qweasd",
  "qweasdzxc",
  "asdfgh",
  "asdfghjkl",
  "asdf1234",
  "zxcvbnm",
  "zxcvbnm123",
  "poiuytrewq",
  "1qaz2wsx",
  "1qazxsw2",
  "1qaz2wsx3edc",
  "1qaz@wsx",
  "1q2w3e4r",
  "1q2w3e4r5t",
  "q1w2e3r4",
  "zaq12wsx",
  "qazwsx",
  "qazwsxedc",
  "abcdef",
  "abcdefg",
  "abcdefgh",
  "iloveyou",
  "iloveu",
  "loveme",
  "loveyou",
  "mylove",
  "forever",
  "admin",
  "admin123",
  "admin888",
  "administrator",
  "root",
  "root123",
  "toor",
  "guest",
  "guest123",
  "user",
  "user123",
  "user1234",
  "test",
  "test123",
  "test1234",
  "demo",
  "demo123",
  "temp123",
  "temp1234",
  "letmein",
  "letmein123",
  "welcome",
  "welcome1",
  "welcome123",
  "changeme",
  "secret",
  "secret123",
  "monkey",
  "monkey123",
  "dragon",
  "dragon123",
  "master",
  "sunshine",
  "sunshine1",
  "princess",
  "princess1",
  "football",
  "football1",
  "baseball",
  "baseball1",
  "shadow",
  "shadow1",
  "superman",
  "superman1",
  "michael",
  "michael1",
  "jennifer",
  "jennifer1",
  "trustno1",
  "whatever",
  "nothing",
  "trustme",
  "woaini",
  "woaini1314",
  "woaini520",
  "5201314",
  "5201314520",
  "1314520",
  "1314521",
  "7758521",
  "7758258",
  "888888",
  "88888888",
  "666666",
  "66666666",
  "111111",
  "11111111",
  "000000",
  "00000000",
  "999999",
  "555555",
  "777777",
  "123123",
  "112233",
  "11223344",
  "121212",
  "159753",
  "147258369",
  "123321",
  "654321",
  "987654321",
  "123654",
  "159357",
  "159951",
  "1234554321",
  "25252525",
  "mysql",
  "postgres",
  "postgresql",
  "oracle",
  "sybase",
  "sa123456",
  "system",
  "manager",
  "company",
  "computer",
  "internet",
  "service",
  "server",
  "backup",
  "default",
  "oracle123",
  "mysql123",
  "fuckyou",
  "fuckyou1",
  "fuckoff",
  "asshole",
  "bitch",
  "suckit",
  "biteme",
  "killer",
  "access",
  "flower",
  "hello",
  "hello123",
  "freedom",
  "whatever1",
  "starwars",
  "pokemon",
  "naruto",
  "batman",
  "matrix",
  "mustang",
  "mercedes",
  "ferrari",
  "corvette",
  "porsche",
  "yamaha",
  "hunter",
  "ranger",
  "buster",
  "soccer",
  "hockey",
  "tennis",
  "golfer",
  "cookie",
  "orange",
  "banana",
  "purple",
  "silver",
  "golden",
  "diamond",
  "pepper",
  "ginger",
  "summer",
  "winter",
  "spring",
  "autumn",
  "january",
  "february"
]);
var WEAK_CONTEXT = /(password|passwd|pwd|passphrase|密码|口令|令牌|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credential)s?["'`]?[ \t]{0,5}(?::=|=>|[=:]|：|(?:[ \t]+is\b)|是|(?:[ \t]+to\b)|改为|改到|改成|修改为|设置为|设置成|设为|设成|置为|配置为|配置成|换成|换为|变成|重置为|更改为|更新为)[ \t:：]{0,5}["'`]?([^\s"'`;,(){}<>[\]\\，。、；：！？“”‘’（）]{3,64})/gi;
function weakPasswordCandidates(text) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  if (!text || text.length > EXTRACT_MAX_BYTES) return out;
  WEAK_CONTEXT.lastIndex = 0;
  for (let m = WEAK_CONTEXT.exec(text); m; m = WEAK_CONTEXT.exec(text)) {
    const key = m[1];
    const raw = m[2];
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
function registerWeakCandidates(text, registry, salt, opts = {}) {
  const minLength = opts.minLength ?? EXTRACT_MIN_LENGTH;
  const out = [];
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
      }
      out.push({ ...candidate, registered });
    } else {
      try {
        opts.onCandidate?.(candidate);
      } catch {
      }
      out.push({ ...candidate, registered: false });
    }
  }
  return out;
}
function learnFromText(text, registry, salt, opts = {}) {
  const minLength = opts.minLength ?? EXTRACT_MIN_LENGTH;
  const extracted = registerExtractedSecrets(text, registry, salt, { minLength });
  if (extracted.count > 0 || !opts.whole) {
    return { count: extracted.count, keys: extracted.keys, entries: extracted.entries };
  }
  const trimmed = text.trim();
  if (trimmed.length < minLength || trimmed.length > 1048576) return { count: 0, keys: [], entries: [] };
  if (registry.hasValue(trimmed) || registry.isMounted(trimmed)) return { count: 0, keys: [], entries: [] };
  const label = (opts.label ?? "FILE").toUpperCase().replace(/[^A-Z0-9_.-]/g, "_").slice(0, 48) || "FILE";
  const res = registry.registerAuto(trimmed, "learn:whole", label, salt, { minLength });
  return res ? { count: 1, keys: [label], wholeRegistered: true, entries: [res.entry] } : { count: 0, keys: [], entries: [] };
}
var RULES_FILE_NAME = "secret-mask-rules.json";
function emptyFile() {
  return { version: 1, rules: [], projects: {} };
}
function normalize(raw, where, errors) {
  if (!raw || typeof raw !== "object") {
    errors.push(`${where}: rule must be an object`);
    return void 0;
  }
  const r = raw;
  if (typeof r.match !== "string" || r.match.length === 0) {
    errors.push(`${where}: missing "match"`);
    return void 0;
  }
  if (typeof r.label !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(r.label)) {
    errors.push(`${where}: missing/invalid "label" (1-64 of [A-Za-z0-9_.-])`);
    return void 0;
  }
  const type = r.type === "exact" ? "exact" : "regex";
  const mode = r.mode === "fixed" ? "fixed" : "placeholder";
  const rule = { match: r.match, label: r.label, type, mode };
  if (mode === "fixed") rule.fixed = typeof r.fixed === "string" && r.fixed ? r.fixed : `<redacted:${r.label}>`;
  if (typeof r.flags === "string" && r.flags) rule.flags = r.flags.replace(/[gy]/g, "");
  if (typeof r.minLength === "number" && Number.isFinite(r.minLength)) rule.minLength = Math.max(1, Math.floor(r.minLength));
  if (type === "regex") {
    try {
      new RegExp(rule.match, flagsOf(rule));
    } catch (e) {
      errors.push(`${where}: invalid regex for "${rule.label}": ${e instanceof Error ? e.message : String(e)}`);
      return void 0;
    }
  }
  return rule;
}
function flagsOf(rule) {
  return `g${rule.flags ?? ""}`;
}
function parseRulesFile(raw) {
  const errors = [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { file: emptyFile(), errors: [`invalid JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  if (!parsed || typeof parsed !== "object") return { file: emptyFile(), errors: ["rules file must be a JSON object"] };
  const doc = parsed;
  const file = emptyFile();
  const list = Array.isArray(doc.rules) ? doc.rules : [];
  list.forEach((rule, i) => {
    const n = normalize(rule, `rules[${i}]`, errors);
    if (n) file.rules.push(n);
  });
  if (doc.projects && typeof doc.projects === "object") {
    for (const [scope, rules] of Object.entries(doc.projects)) {
      if (!Array.isArray(rules)) continue;
      file.projects[scope] = [];
      rules.forEach((rule, i) => {
        const n = normalize(rule, `projects[${scope}][${i}]`, errors);
        if (n) file.projects[scope].push(n);
      });
    }
  }
  return { file, errors };
}
function readRulesFile(path) {
  try {
    return parseRulesFile(readFileSync(path, "utf8"));
  } catch (e) {
    const code = e.code;
    if (code === "ENOENT") return { file: emptyFile(), errors: [] };
    return { file: emptyFile(), errors: [e instanceof Error ? e.message : String(e)] };
  }
}
function writeRulesFile(path, file) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(file, null, 2) + "\n", { mode: 384 });
    return void 0;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
function mergeRules(file, scope) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const rule of [...file.projects[scope] ?? [], ...file.rules]) {
    if (seen.has(rule.label)) continue;
    seen.add(rule.label);
    out.push(rule);
  }
  return out;
}
var RulesSource = class {
  constructor(path, scope) {
    this.stamp = "";
    this.errors = [];
    this.path = path;
    this.scope = scope;
  }
  rules() {
    this.refresh();
    return mergeRules(this.cache ?? emptyFile(), this.scope);
  }
  refresh(force = false) {
    let stamp = "missing";
    try {
      const st = statSync(this.path);
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      stamp = "missing";
    }
    if (!force && this.cache && stamp === this.stamp) return;
    const { file, errors } = readRulesFile(this.path);
    this.cache = file;
    this.errors = errors;
    this.stamp = stamp;
  }
  setScope(scope) {
    this.scope = scope;
    this.cache = void 0;
    this.stamp = "";
  }
  reload() {
    this.refresh(true);
    return this.rules();
  }
};
function minLengthOf(rule) {
  return rule.minLength ?? MIN_REDACT_LENGTH;
}
function registerRuleMatches(text, registry, rules, salt) {
  if (!text || rules.length === 0) return 0;
  let added = 0;
  for (const rule of rules) {
    if ((rule.mode ?? "placeholder") !== "placeholder") continue;
    const min = minLengthOf(rule);
    if ((rule.type ?? "regex") === "exact") {
      if (rule.match.length < min || !text.includes(rule.match)) continue;
      if (registry.registerAuto(rule.match, `custom:${rule.label}`, rule.label, salt, { minLength: min })) added++;
      continue;
    }
    let re;
    try {
      re = new RegExp(rule.match, flagsOf(rule));
    } catch {
      continue;
    }
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      if (m[0] === "") {
        re.lastIndex++;
        continue;
      }
      if (m[0].length >= min && registry.registerAuto(m[0], `custom:${rule.label}`, rule.label, salt, { minLength: min })) added++;
    }
  }
  return added;
}
function applyFixedRules(text, rules) {
  if (!text || rules.length === 0) return { text, count: 0 };
  let out = text;
  let count = 0;
  for (const rule of rules) {
    if (rule.mode !== "fixed") continue;
    const replacement = rule.fixed ?? `<redacted:${rule.label}>`;
    if ((rule.type ?? "regex") === "exact") {
      if (rule.match.length === 0) continue;
      const parts = out.split(rule.match);
      if (parts.length > 1) {
        count += parts.length - 1;
        out = parts.join(replacement);
      }
      continue;
    }
    let re;
    try {
      re = new RegExp(rule.match, flagsOf(rule));
    } catch {
      continue;
    }
    out = out.replace(re, () => {
      count++;
      return replacement;
    });
  }
  return { text: out, count };
}
function ruleSummary(rule) {
  const mode = rule.mode ?? "placeholder";
  const type = rule.type ?? "regex";
  const extra = mode === "fixed" ? ` → ${rule.fixed ?? `<redacted:${rule.label}>`} (one-way)` : "";
  return `${rule.label}: ${type} /${rule.match}/${rule.flags ?? ""} [${mode}]${extra}`;
}
function addRuleToFile(path, scope, rule, target = "project") {
  const { file } = readRulesFile(path);
  if (target === "global") {
    file.rules = file.rules.filter((r) => r.label !== rule.label);
    file.rules.push(rule);
  } else {
    const bucket = file.projects[scope] ?? [];
    file.projects[scope] = bucket.filter((r) => r.label !== rule.label).concat(rule);
  }
  return writeRulesFile(path, file);
}
function removeRuleFromFile(path, scope, label) {
  const { file } = readRulesFile(path);
  const before = file.rules.length + (file.projects[scope]?.length ?? 0);
  file.rules = file.rules.filter((r) => r.label !== label);
  if (file.projects[scope]) file.projects[scope] = file.projects[scope].filter((r) => r.label !== label);
  const after = file.rules.length + (file.projects[scope]?.length ?? 0);
  const err = writeRulesFile(path, file);
  return err ? { removed: 0, error: err } : { removed: before - after };
}
function unmountedPlaceholders(text, registry) {
  if (!text) return [];
  const out = [];
  for (const token of findV2Placeholders(text)) {
    if (registry.isMounted(token) || registry.hasValue(token)) continue;
    if (!out.includes(token)) out.push(token);
  }
  return out;
}
function unmountedInValue(value, registry) {
  const out = [];
  const walk = (node) => {
    if (typeof node === "string") {
      for (const token of unmountedPlaceholders(node, registry)) if (!out.includes(token)) out.push(token);
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
  walk(value);
  return out;
}
function guardReason(tokens, opts = {}) {
  const list = tokens.join(", ");
  const hint = opts.landing === "ephemeral" ? `/secret add <label> to register the value again (ephemeral landing keeps values in memory only) or ask the user to provide it` : `vault_get <alias> to re-mount the value, or /secret add <label> to register it in this session`;
  return `secret-mask: refused to run with unresolved placeholder(s) ${list}. The value behind them is not mounted in this session — call ${hint}. Do not retype, guess or replace the placeholder yourself.`;
}
var LANDING_MODES = ["plain", "vault", "ephemeral"];
var MASK_LANDING_MODES = ["plain", "ephemeral"];
var DEFAULT_LANDING = "plain";
function isLandingMode(value) {
  return LANDING_MODES.includes(value);
}
function landingText(mode) {
  switch (mode) {
    case "plain":
      return "plain — values stay in the session file (grep-able; recovery works by re-detection or /secret load)";
    case "vault":
      return "vault — session file is redacted; values are stored in the encrypted vault (/vault add) and re-mount via vault_get";
    case "ephemeral":
      return "ephemeral — session file is redacted; values live in this process only and are unrecoverable after exit";
  }
}
function landingChangeWarning(next, previous) {
  if (next === previous) return void 0;
  if (next === "ephemeral") return "ephemeral: values registered from now on are not persisted anywhere — if you lose this process you must provide them again.";
  if (next === "vault") return "vault: new values should be entered with /vault add (encrypted, cross-session). Session-only values stay in memory.";
  if (next === "plain") return "plain: messages from now on keep real values in the session file again.";
  return void 0;
}
var PERSIST_FILE_NAME = "secret-mask.json";
var AUDIT_FILE_NAME = "secret-mask-audit.log";
function maskablePreview(entry) {
  const v = entry.value;
  if (v.length <= 8) return "*".repeat(v.length);
  return `${"*".repeat(Math.max(4, Math.min(16, v.length - 8)))}${v.slice(-4)}`;
}
function listText(state) {
  const entries = state.registry.entries();
  if (entries.length === 0) {
    return "secret-mask: no registered values this session. Use /secret add (interactive) or vault_get <alias>.";
  }
  const lines = entries.map((e) => {
    const src = e.source === "manual" ? "manual" : e.source === "vault" ? "vault" : `auto(${e.ruleId ?? "?"})`;
    const name2 = e.alias ?? e.label;
    return `- ${e.placeholder} → ${name2}  [${src}]  ${e.value.length} chars  …${maskablePreview(e)}`;
  });
  return `secret-mask: ${entries.length} value(s) registered (landing: ${state.landing}):
${lines.join("\n")}`;
}
function statusText(state) {
  const rules = state.rules?.length ?? 0;
  const parts = [
    `secret-mask: ${state.disabledBy ? `DISABLED (by ${state.disabledBy})` : state.enabled ? "ON" : "OFF"}`,
    `landing ${state.landing}`,
    `${state.registry.size} value(s) registered`,
    `guard ${state.guard ? "ON" : "OFF"}`,
    `strict ${state.strict ? "ON" : "OFF"}`,
    `rules ${rules}${state.rulesError ? " (errors — /secret rule list)" : ""}`,
    `extract ${state.extract === false ? "OFF" : "ON"}`,
    `files ${state.filePolicy ?? "learn"}`,
    `weak ${state.weakMode ?? "notify"}`,
    `send-audit ${state.audit ? "ON" : "OFF"}`
  ];
  if (state.lastAudit) parts.push(`last audit: ${state.lastAudit}`);
  return parts.join("; ") + ".";
}
function appendAuditLog(result, path) {
  try {
    mkdirSync2(dirname2(path), { recursive: true });
    appendFileSync(path, JSON.stringify(result) + "\n", { mode: 384 });
    return void 0;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
function readAuditTail(maxLines = 5, path) {
  if (!path) return [];
  try {
    const lines = readFileSync2(path, "utf8").trimEnd().split("\n");
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}
function parseAdd(args) {
  const asMatch = /\s+as\s+([A-Za-z0-9_-]{1,64})\s*$/.exec(args);
  if (asMatch) return { value: args.slice(0, asMatch.index).trim(), alias: asMatch[1] };
  const aliasMatch = /^(.*?)\s+--alias\s+([A-Za-z0-9_-]{1,64})\s*$/.exec(args);
  if (aliasMatch) return { value: aliasMatch[1].trim(), alias: aliasMatch[2] };
  return { value: args.trim() };
}
function availableLandings(state) {
  return state.landingModes ?? MASK_LANDING_MODES;
}
function handleSecretCommand(state, rawArgs, io = {}) {
  return handleSync(state, rawArgs.trim(), io);
}
async function handleSync(state, args, io) {
  const [cmd, ...rest] = args.length ? args.split(/\s+/) : [""];
  const tail = args.slice(cmd.length).trim();
  switch (cmd) {
    case "":
    case "help":
      return { ok: true, text: helpText(state) };
    case "add": {
      let value = tail;
      let alias;
      if (!value || /^--alias(\s|$)/.test(value)) {
        const requestedAlias = /^--alias\s+([A-Za-z0-9_-]{1,64})$/.exec(value)?.[1];
        value = await io.input?.("Paste secret value (input is kept out of the chat)") ?? "";
        alias = requestedAlias;
        if (!value.trim()) return { ok: false, text: "secret-mask: cancelled." };
      } else {
        const parsed = parseAdd(value);
        value = parsed.value;
        alias = parsed.alias;
      }
      const res = state.registry.registerManual(value, alias, { salt: state.salt });
      if (!res) return { ok: false, text: `secret-mask: value rejected (must be at least ${MIN_REDACT_LENGTH} characters).` };
      const note = res.replaced ? " (replaced previous entry for this value)" : "";
      return { ok: true, text: `secret-mask: registered ${res.entry.placeholder} → ${res.entry.alias ?? res.entry.label}${note}` };
    }
    case "list":
      return { ok: true, text: listText(state) };
    case "remove": {
      if (!tail) return { ok: false, text: "Usage: /secret remove <alias|label|placeholder>" };
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
    case "landing":
      return landingCommand(state, tail);
    case "guard": {
      if (!tail) return { ok: true, text: `secret-mask: guard ${state.guard ? "ON" : "OFF"} — unresolved placeholders in tool arguments are ${state.guard ? "blocked" : "allowed through"}.` };
      if (tail !== "on" && tail !== "off") return { ok: false, text: "Usage: /secret guard [on|off]" };
      state.guard = tail === "on";
      return { ok: true, text: `secret-mask: guard ${state.guard ? "enabled" : "disabled"}.` };
    }
    case "strict": {
      if (!tail) return { ok: true, text: `secret-mask: strict ${state.strict ? "ON" : "OFF"}.` };
      if (tail !== "on" && tail !== "off") return { ok: false, text: "Usage: /secret strict [on|off]" };
      state.strict = tail === "on";
      return { ok: true, text: `secret-mask: strict ${state.strict ? "enabled" : "disabled"} — side channels ${state.strict ? "fail closed" : "warn and pass"}.` };
    }
    case "rule":
      return ruleCommand(state, tail, io);
    case "audit": {
      const arg = tail.trim();
      if (arg === "on" || arg === "") {
        state.audit = true;
        return { ok: true, text: `secret-mask: send-audit ON — every provider request is scanned for registered raw values; evidence appended to ${state.auditPath}` };
      }
      if (arg === "off") {
        state.audit = false;
        return { ok: true, text: "secret-mask: send-audit OFF." };
      }
      if (arg === "show") {
        const lines = readAuditTail(5, state.auditPath);
        return {
          ok: true,
          text: lines.length ? `secret-mask audit evidence (last ${lines.length}):
${lines.join("\n")}` : "secret-mask: no audit evidence yet (turn /secret audit on)."
        };
      }
      return { ok: false, text: "Usage: /secret audit [on|off|show]" };
    }
    case "status":
      return { ok: true, text: statusText(state) };
    case "extract": {
      if (!tail) return { ok: true, text: `secret-mask: extract ${state.extract === false ? "OFF" : "ON"} — structured key-value extraction from tool output and write inputs.` };
      if (tail !== "on" && tail !== "off") return { ok: false, text: "Usage: /secret extract [on|off]" };
      state.extract = tail === "on";
      return { ok: true, text: `secret-mask: extract ${state.extract ? "enabled" : "disabled"}.` };
    }
    case "files": {
      if (!tail) return { ok: true, text: `secret-mask: sensitive-file policy = ${state.filePolicy ?? "learn"} (learn | block | off).` };
      if (tail !== "learn" && tail !== "block" && tail !== "off") return { ok: false, text: "Usage: /secret files [learn|block|off]" };
      state.filePolicy = tail;
      const note = tail === "learn" ? " — structured values are registered; dedicated secret files are withheld as a placeholder" : tail === "block" ? " — reads of sensitive paths are blocked before execution" : " — path policy disabled";
      return { ok: true, text: `secret-mask: file policy → ${tail}${note}.` };
    }
    case "weak": {
      if (!tail) return { ok: true, text: `secret-mask: weak candidates = ${state.weakMode ?? "notify"} (notify | auto | off).` };
      if (tail !== "notify" && tail !== "auto" && tail !== "off") return { ok: false, text: "Usage: /secret weak [notify|auto|off]" };
      state.weakMode = tail;
      return { ok: true, text: `secret-mask: weak candidates → ${tail}${tail === "notify" ? " (dictionary hits register, other candidates only notify)" : tail === "auto" ? " (all weak candidates register)" : ""}.` };
    }
    case "learn": {
      const arg = tail.trim();
      let text;
      let label;
      let whole = false;
      if (!arg || arg === "last") {
        if (!state.lastToolOutput) return { ok: false, text: "secret-mask: no recent tool output to learn from." };
        text = state.lastToolOutput;
      } else {
        const path = resolve(state.cwd, arg);
        try {
          const st = fileStat(path);
          if (!st.isFile()) return { ok: false, text: `secret-mask: not a file: ${path}` };
          if (st.size > 1048576) return { ok: false, text: `secret-mask: file too large (${st.size} bytes; limit 1MB).` };
          text = readFileSync2(path, "utf8");
          label = basename(path);
          whole = inspectSensitivePath(path).dedicated;
        } catch (e) {
          return { ok: false, text: `secret-mask: cannot read ${path}: ${e instanceof Error ? e.message : String(e)}` };
        }
      }
      const res = learnFromText(text, state.registry, state.salt, { whole, label });
      const keys = res.keys.slice(0, 8).join(", ") + (res.keys.length > 8 ? ", …" : "");
      return {
        ok: true,
        text: res.count ? `secret-mask: learned ${res.count} value(s)${keys ? ` (${keys})` : ""}${res.wholeRegistered ? " — whole file registered" : ""}.` : "secret-mask: nothing new to learn (no structured value, or already registered)."
      };
    }
    case "save": {
      if (!tail) return { ok: false, text: "Usage: /secret save <file> — explicit plaintext snapshot (you own the file and its safety)." };
      const path = resolve(state.cwd, tail);
      const err = saveSnapshot(state.registry.entries(), path);
      if (err) return { ok: false, text: `secret-mask: save failed: ${err}` };
      return { ok: true, text: `secret-mask: ${state.registry.size} value(s) written to ${path} (0600, plaintext — placement and safety are yours).` };
    }
    case "load": {
      if (!tail) return { ok: false, text: "Usage: /secret load <file> — explicit snapshot load (nothing is auto-loaded)." };
      const path = resolve(state.cwd, tail);
      const res = loadSnapshot(state.registry, path, { cwd: state.cwd, salt: state.salt });
      if (res.error) return { ok: false, text: `secret-mask: load failed: ${res.error}` };
      state.persisted = false;
      return { ok: true, text: `secret-mask: loaded ${res.loaded} value(s) from ${path}${res.skipped ? ` (${res.skipped} already registered)` : ""}.` };
    }
    case "unload":
      return { ok: true, text: "secret-mask: /secret unload is retired (no implicit persistence). Use /secret clear to drop session entries, or /secret save|load <file> explicitly." };
    default:
      return { ok: false, text: `secret-mask: unknown subcommand "${cmd}". Try /secret help.` };
  }
}
function helpText(state) {
  const modes = availableLandings(state).join("|");
  return [
    "secret-mask commands:",
    "  /secret add [<value>] [as <alias> | --alias <alias>]   register a value (masked input when omitted)",
    "  /secret list                       placeholders → aliases (masked previews)",
    "  /secret remove <alias|label>       unregister one value",
    "  /secret clear                      unregister all",
    "  /secret on | off                   enable/disable redaction for this session",
    `  /secret landing [${modes}]   where real values may live on disk (current: ${state.landing})`,
    "  /secret guard [on|off]             block unresolved placeholders in tool arguments",
    "  /secret strict [on|off]            fail closed on side channels (compaction, ! commands)",
    "  /secret rule list | add | remove | reload   custom detection rules",
    "  /secret extract [on|off]           structured extraction from tool output / write inputs",
    "  /secret files [learn|block|off]    sensitive-file policy (learn = register & redact)",
    "  /secret weak [notify|auto|off]     weak-password candidates (L3)",
    "  /secret learn [last|<file>]        register values from the last tool output or a file",
    "  /secret save <file> | load <file>  explicit plaintext snapshot (no implicit state)",
    "  /secret audit [on|off|show]        per-send wire-payload proof log",
    "  /secret status                     current state"
  ].join("\n");
}
function landingCommand(state, tail) {
  const modes = availableLandings(state);
  if (!tail) {
    const lines = modes.map((m) => `  ${m === state.landing ? "*" : " "} ${landingText(m)}`);
    return { ok: true, text: `secret-mask: landing policy (current: ${state.landing})
${lines.join("\n")}` };
  }
  if (!isLandingMode(tail)) return { ok: false, text: `Usage: /secret landing [${modes.join("|")}]` };
  if (!modes.includes(tail)) return { ok: false, text: `secret-mask: landing "${tail}" is not available in this package (supported: ${modes.join(", ")}).` };
  const previous = state.landing ?? DEFAULT_LANDING;
  state.landing = tail;
  const warning = landingChangeWarning(tail, previous);
  return { ok: true, text: `secret-mask: landing → ${tail}${warning ? `
${warning}` : ""}` };
}
async function ruleCommand(state, tail, io) {
  const tokens = tail.split(/\s+/).filter(Boolean);
  const sub = tokens[0] ?? "list";
  if (!state.rulesPath && sub !== "list") {
    return { ok: false, text: "secret-mask: no custom rules file configured by this host." };
  }
  if (sub === "list" || sub === "") {
    const rules = state.rules ?? [];
    const errors = state.rulesError ? [`errors: ${state.rulesError}`] : [];
    if (rules.length === 0 && errors.length === 0) {
      return { ok: true, text: `secret-mask: no custom rules${state.rulesPath ? ` (${state.rulesPath})` : ""}.` };
    }
    const lines = rules.map((r) => `- ${ruleSummary(r)}`);
    return { ok: true, text: `secret-mask: ${rules.length} custom rule(s)${state.rulesPath ? ` from ${state.rulesPath}` : ""}:
${[...lines, ...errors].join("\n")}` };
  }
  if (sub === "reload") {
    io.reloadRules?.();
    return { ok: true, text: "secret-mask: custom rules reloaded." };
  }
  if (sub === "add") {
    let rest = tokens.slice(1);
    let target = "project";
    if (rest.includes("--global")) {
      target = "global";
      rest = rest.filter((t) => t !== "--global");
    }
    let fixed;
    const fixedAt = rest.indexOf("--fixed");
    if (fixedAt >= 0) {
      fixed = rest.slice(fixedAt + 1).join(" ");
      rest = rest.slice(0, fixedAt);
    }
    const [label, type, ...patternParts] = rest;
    if (!label || type !== "exact" && type !== "regex" || patternParts.length === 0) {
      return { ok: false, text: "Usage: /secret rule add <label> <exact|regex> <pattern> [--fixed <text>] [--global]" };
    }
    const rule = {
      label,
      type,
      match: patternParts.join(" "),
      mode: fixed !== void 0 ? "fixed" : "placeholder"
    };
    if (fixed !== void 0) rule.fixed = fixed || `<redacted:${label}>`;
    if (type === "regex") {
      try {
        new RegExp(rule.match, "g");
      } catch (e) {
        return { ok: false, text: `secret-mask: invalid regex: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(label)) return { ok: false, text: "secret-mask: label must be 1-64 chars of [A-Za-z0-9_.-]." };
    const err = addRuleToFile(state.rulesPath, state.cwd, rule, target);
    if (err) return { ok: false, text: `secret-mask: could not write rules: ${err}` };
    io.reloadRules?.();
    return { ok: true, text: `secret-mask: rule "${label}" added (${target}).` };
  }
  if (sub === "remove") {
    const label = tokens[1];
    if (!label) return { ok: false, text: "Usage: /secret rule remove <label>" };
    const res = removeRuleFromFile(state.rulesPath, state.cwd, label);
    if (res.error) return { ok: false, text: `secret-mask: could not write rules: ${res.error}` };
    if (res.removed === 0) return { ok: false, text: `secret-mask: no rule labelled "${label}".` };
    io.reloadRules?.();
    return { ok: true, text: `secret-mask: removed rule "${label}".` };
  }
  return { ok: false, text: "Usage: /secret rule [list|add|remove|reload]" };
}
function saveSnapshot(entries, path) {
  try {
    const file = {
      version: 2,
      savedAt: (/* @__PURE__ */ new Date()).toISOString(),
      cwd: process.cwd(),
      entries: entries.map((e) => ({
        placeholder: e.placeholder,
        value: e.value,
        label: e.label,
        alias: e.alias,
        source: e.source,
        ruleId: e.ruleId,
        stable: e.stable
      }))
    };
    mkdirSync2(dirname2(path), { recursive: true });
    writeFileSync2(path, JSON.stringify(file, null, 2) + "\n", { mode: 384 });
    try {
      chmodSync(path, 384);
    } catch {
    }
    return void 0;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
function legacyEntries(raw, cwd) {
  const doc = JSON.parse(raw);
  const projects = doc?.projects;
  if (!projects || typeof projects !== "object") return [];
  if (Array.isArray(projects[cwd])) return projects[cwd];
  return Object.values(projects).flatMap((list) => Array.isArray(list) ? list : []);
}
function loadSnapshot(registry, path, opts = {}) {
  let raw;
  try {
    raw = readFileSync2(path, "utf8");
  } catch (e) {
    return { loaded: 0, skipped: 0, error: e instanceof Error ? e.message : String(e) };
  }
  let entries;
  try {
    const doc = JSON.parse(raw);
    if (doc.version === 2 && Array.isArray(doc.entries)) {
      entries = doc.entries;
    } else {
      entries = legacyEntries(raw, opts.cwd ?? process.cwd());
    }
  } catch (e) {
    return { loaded: 0, skipped: 0, error: `invalid snapshot: ${e instanceof Error ? e.message : String(e)}` };
  }
  let loaded = 0;
  let skipped = 0;
  for (const e of entries) {
    if (!e || typeof e.value !== "string" || typeof e.placeholder !== "string") {
      skipped++;
      continue;
    }
    if (registry.isMounted(e.placeholder)) {
      skipped++;
      continue;
    }
    const res = registry.register(e.value, e.source ?? "manual", {
      alias: e.alias,
      label: e.label,
      placeholder: e.placeholder,
      salt: opts.salt,
      ruleId: e.ruleId
    });
    if (res) loaded++;
    else skipped++;
  }
  return { loaded, skipped };
}
function loadPersist(state, path) {
  return loadSnapshot(state.registry, path, { cwd: state.cwd, salt: state.salt }).loaded;
}

// src/state.ts
var sessions = /* @__PURE__ */ new Map();
var rulesSources = /* @__PURE__ */ new Map();
var PERSIST_PATH = join(homedir(), ".dsh", PERSIST_FILE_NAME);
var AUDIT_LOG_PATH = join(homedir(), ".dsh", AUDIT_FILE_NAME);
var RULES_PATH = join(homedir(), ".dsh", RULES_FILE_NAME);
function rulesFor(cwd) {
  let src = rulesSources.get(cwd);
  if (!src) {
    src = new RulesSource(RULES_PATH, cwd);
    rulesSources.set(cwd, src);
  }
  return src;
}
function refreshRules(st) {
  const src = rulesFor(st.cwd);
  st.rules = src.rules();
  st.rulesError = src.errors.length ? src.errors.join("; ") : void 0;
}
function reloadRules(st) {
  const src = rulesFor(st.cwd);
  st.rules = src.reload();
  st.rulesError = src.errors.length ? src.errors.join("; ") : void 0;
}
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
      audit: cfg.audit,
      persistPath: PERSIST_PATH,
      auditPath: cfg.auditPath || AUDIT_LOG_PATH,
      extract: true,
      filePolicy: "learn",
      weakMode: "notify",
      lastToolOutput: "",
      landing: "ephemeral",
      landingModes: ["plain", "ephemeral"],
      guard: true,
      strict: false,
      rulesPath: RULES_PATH,
      rules: []
    };
    st.registry.salt = st.salt;
    sessions.set(key, st);
    loadPersist(st, st.persistPath);
    refreshRules(st);
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
function redactUserMessage(message, st, autoDetect, weak) {
  let changed = false;
  let newEntries = 0;
  const userAuthored = message.source?.kind === "user";
  const content = message.content.map((block) => {
    if (!isTextBlock(block) || !block.text) return block;
    if (autoDetect && userAuthored) {
      newEntries += st.registry.autoRegister(block.text, st.salt).length;
      if (weak) newEntries += registerWeakCandidates(block.text, st.registry, st.salt, weak).filter((c) => c.registered).length;
    }
    const rules = st.rules ?? [];
    if (rules.length > 0) newEntries += registerRuleMatches(block.text, st.registry, rules, st.salt);
    const res = st.registry.redact(block.text);
    let text = res.text;
    let count = res.count;
    if (rules.length > 0) {
      const fixed = applyFixedRules(text, rules);
      text = fixed.text;
      count += fixed.count;
    }
    if (count === 0) return block;
    changed = true;
    return { ...block, text };
  });
  if (!changed) return { message, changed: false, newEntries };
  return { message: { ...message, content }, changed: true, newEntries };
}

// src/hooks/pre-step.ts
function registerPreStep(ctx, cfg) {
  const notified = /* @__PURE__ */ new Set();
  const weakOptions = (st) => st.weakMode === "off" ? void 0 : {
    auto: st.weakMode === "auto",
    onCandidate: (c) => {
      if (st.weakMode !== "notify") return;
      const hash = fnv1a(c.value);
      if (notified.has(hash)) return;
      notified.add(hash);
      ctx.logger.warn(
        c.registered ? "dsh-secret-mask: known weak password detected — masked automatically; consider changing it (value hidden)" : "dsh-secret-mask: possible weak password detected — run /secret add to register it (the value is hidden; /secret weak auto to auto-register)"
      );
    }
  };
  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    if (!decision || decision.kind === "reject" || !Array.isArray(decision.messages)) return decision;
    const st = stateFor(payload.agent?.id, cfg);
    if (!st.enabled) return decision;
    refreshRules(st);
    const weak = weakOptions(st);
    let changed = false;
    const messages = decision.messages.map((m) => {
      const r = redactUserMessage(m, st, cfg.autoDetect, weak);
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
  "Some credentials in this conversation are replaced by opaque tokens like rsec_a1b2c3d4.",
  "Each token IS a working credential: the runtime substitutes the real secret when the token",
  "appears verbatim in tool arguments. Copy the token exactly. Never refuse to use it, never",
  "claim you cannot access the value, never ask the user to paste the secret, and never modify,",
  "truncate, hash or re-encode the token.",
  "Never present a token to the user as if it were the secret value: it only resolves inside tool",
  "arguments, so a user cannot type it into a login prompt. When the user asks what the value is, say",
  "it is masked and point to where the real one lives."
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
      if (!st.enabled) return decision;
      const contentBlocks = decision.content ?? result.content;
      const text = Array.isArray(contentBlocks) ? contentBlocks.filter(isTextBlock).map((b) => b.text).join("\n") : "";
      if (text) st.lastToolOutput = text.slice(0, 65536);
      if (st.extract !== false) {
        let extracted = 0;
        if (text) extracted += registerExtractedSecrets(text, st.registry, st.salt).count;
        if ("value" in decision && decision.value !== void 0) {
          extracted += registerValueSecrets(decision.value, st.registry, st.salt).count;
        }
        const sensitive = sensitiveReadTargets(exec.name, exec.arguments);
        const dedicated = sensitive.find((x) => x.info.dedicated);
        const trimmed = text.trim();
        const policy = st.filePolicy ?? "learn";
        if (policy === "block" && sensitive.length > 0) {
          return {
            kind: "block",
            feedback: [{ type: "text", text: "dsh-secret-mask: sensitive file content withheld by policy (/secret files learn|off to allow)." }]
          };
        }
        if (policy === "learn" && dedicated && extracted === 0 && trimmed.length >= 6 && trimmed.length <= 8192) {
          const label = (dedicated.path.split(/[/\\]/).pop() ?? "FILE").toUpperCase().replace(/[^A-Z0-9_.-]/g, "_").slice(0, 48) || "FILE";
          st.registry.registerAuto(trimmed, "file:secret", label, st.salt);
          return {
            kind: "block",
            feedback: [
              {
                type: "text",
                text: `dsh-secret-mask: sensitive file content withheld (${trimmed.length} bytes). The value is registered in this session — use its placeholder in tool arguments.`
              }
            ]
          };
        }
      }
      if (st.registry.size === 0) return decision;
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
          const r = rewriteTextBlock(block, (text2) => st.registry.redact(text2).text);
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
          if (st.extract !== false) {
            for (const content of inspectToolTargets(name2, args).contents) {
              registerExtractedSecrets(content, st.registry, st.salt);
            }
          }
          let restored = args;
          if (st.enabled && args !== null && typeof args === "object") {
            if (st.guard) {
              const missing = unmountedInValue(args, st.registry);
              if (missing.length > 0) throw new Error(guardReason(missing, { landing: st.landing }));
            }
            if (st.registry.size > 0) {
              try {
                restored = restoreDeep(structuredClone(args), st.registry).value;
              } catch {
                restored = args;
              }
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
function registerAudit(ctx, cfg) {
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
        cfg.auditPath || st.auditPath
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
    description: "Register/redact secrets: add/list/remove/clear, on/off, guard, rules, save|load <file>, audit, status",
    recordInput: false,
    handler: async (invocation) => {
      const st = stateFor(invocation.agent?.id, cfg);
      refreshRules(st);
      const outcome = await handleSecretCommand(st, invocation.rawInput ?? "", {
        reloadRules: () => reloadRules(st)
      });
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
  registerAudit(ctx, cfg);
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
