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

import { fnv1a } from "./hash.ts";

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
  // common copula-prose status words ("my password is incorrect") — ≥8 chars so they
  // would otherwise pass the length + entropy gates after `password is`
  "incorrect", "forgotten", "encrypted", "protected", "mismatch", "rejected", "verified",
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
  // lockfile integrity / checksum digests are long and random but never secrets
  // (`sha256~` is an OpenShift *token* prefix and is deliberately not listed)
  if (/^(?:sha\d{0,3}[-_]|md5[-_]|h1[-:]|integrity)/i.test(v)) return false;
  if (/^(.)\1*$/.test(v)) return false;
  if (/^v?\d+(?:\.\d+){2,}(?:[-+][A-Za-z0-9.-]+)?$/.test(v)) return false;
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

/** Assignment fragments, URL fragments and member-call punctuation are code, not credentials. */
function codeishValue(v: string): boolean {
  if (v.includes("=") && !/={1,2}$/.test(v)) return true;
  if (v.includes("#")) return true;
  if (v.includes("|")) return true;
  if (/[!?]$/.test(v)) return true;
  if (/\.[a-z_$][\w$]*\s*\(/i.test(v)) return true;
  if (/^[a-z_$][\w$]*(?:\.[a-z_$][\w$]*){1,}$/i.test(v)) return true;
  return false;
}

function bareSecret(v: string): boolean {
  // Entropy gate 2.5 (aligned with notFiller). cc-redact's 3.0 was tuned for its
  // file-scan corpus; in the chat + CJK scene it only ever rejected human-chosen
  // passwords, which commonly sit at 2.5-3.0 (xxewwer1234 = 2.91,
  // 233345电饭锅电饭 = 2.66), while CJK prose straddles the old gate anyway. // cjk-ok
  // Measured cost of 2.5 on 212k local repo files: ~8-10 new hit shapes, all
  // keyword+colon prose or minified-code artifacts, no real credentials.
  if (!plausibleSecret(v) || placeholderShaped(v) || entropy(v) < 2.5) return false;
  // A code identifier or member chain with no digit (getToken, process.env.KEY,
  // my-secret-name) is not a value -- but letter-only credentials exist (base62
  // and base32 keys without digits), so a long high-entropy run with no
  // word-like lowercase stretch is still accepted. Word-shaped text has runs of
  // lowercase; random key material does not.
  if (!/\d/.test(v) && /^[A-Za-z_$][\w$]*(?:[.\-][A-Za-z_$][\w$]*)*$/.test(v)) {
    // Key material mixes case almost uniformly (or is base32 upper only); a
    // camelCase identifier keeps most letters lowercase.
    const upperRatio = (segment) => {
      const letters = segment.replace(/[^A-Za-z]/g, "");
      return letters.length < 6 ? 0 : segment.replace(/[^A-Z]/g, "").length / letters.length;
    };
    const dense = Math.max(...v.split(/[-_.]+/).map(upperRatio));
    // screaming-snake constants (`SYSTEM_ENCRYPTION_BY_PASSWORD`) are code names
    const snakeConstant = /^[A-Z][A-Z0-9_]*$/.test(v) && v.includes("_");
    const randomish = v.length >= 20 && entropy(v) >= 3.2 && dense >= 0.4 && !snakeConstant;
    if (!randomish) return false;
  }
  // English prose after a keyword ("no token is configured.", "the token is expired."): a single
  // lowercase word (optionally with sentence punctuation) and no digit is a sentence, not a value
  if (!/\d/.test(v) && /^[a-z][a-z_-]*[.,;:!?]?$/.test(v)) return false;
  if (codeishValue(v)) return false;
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

/** Words that make a nearby value a credential when no operator binds them. */
const NEAR_KEYWORD =
  /(?:api[_-]?key|secret(?:[_-]?key)?|token|passw(?:or)?d|passwd|pwd|passphrase|credential|密码|密钥|秘钥|口令|令牌|授权码|授权密钥|访问令牌|访问密钥|凭证|凭据|私钥)/i;
/** How far back (chars) a credential keyword still counts for a bare assignment. */
const NEAR_WINDOW = 160;

/** The credential keyword sits in the same passage (a few sentences back at most). */
function keywordNear(text: string, at: number): boolean {
  return NEAR_KEYWORD.test(text.slice(Math.max(0, at - NEAR_WINDOW), at));
}

/**
 * cjk-ok-next (code sample)
 * Bare value handed over by an assignment verb (`设为 X`, `set it to X`). No
 * operator binds it, so the bar is higher than for `= value`: ASCII only, both
 * letters and digits, and never a file name or an identifier.
 */
function assignedSecret(v: string): boolean {
  if (v.length < 8 || !/[A-Za-z]/.test(v) || !/\d/.test(v)) return false;
  if (!plausibleSecret(v) || placeholderShaped(v) || entropy(v) < 2.8) return false;
  // word-hump identifiers are NOT filtered here on purpose: human-chosen passwords look exactly
  // like them (Kx7dyn4b91, Qz8wEr7t) and the surrounding keyword already names the value
  // config values are often names: `report2024.md`, `release_v2.json`
  return !/\.(?:md|txt|json|ya?ml|toml|ini|conf|cfg|log|ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|sh|zsh|lock|env|html?|css|sql|xml|csv)$/i.test(v);
}

/** True when the offset is inside a `${...}` expression (template default, not a literal). */
function insideTemplate(text: string, at: number): boolean {
  const open = text.lastIndexOf("${", at);
  if (open === -1) return false;
  const close = text.indexOf("}", open);
  return close === -1 || close > at;
}

// ---------------------------------------------------------------------------
// rules (secret kind; PII rules are planned as an opt-in follow-up)
// ---------------------------------------------------------------------------

const GITLEAKS = "https://github.com/gitleaks/gitleaks";
const GITHUB_PATTERNS = "https://docs.github.com/code-security/secret-scanning";

// ---------------------------------------------------------------------------
// Layer 1 — shape rules: the credential is recognizable by itself
// ---------------------------------------------------------------------------
// A data-driven prefix table (one line per provider) instead of a regex per
// vendor. Prefix + charset + length is what gitleaks/TruffleHog call a
// "detector"; it needs no surrounding prose, so it survives any phrasing the
// user invents (`token X`, `K='X'`, `curl -H ...`, a bare paste, base64).

interface VendorSpec {
  id: string;
  label: string;
  /** Regex fragment for the prefix (authored; may use groups and classes). */
  prefix?: string;
  /** Charset of the random body after the prefix. */
  chars?: string;
  min?: number;
  max?: number;
  /** Full pattern source; skips the prefix/charset assembly. */
  re?: string;
  ci?: boolean;
  verify?: (v: string) => boolean;
  source?: string;
}

function vendorRule(spec: VendorSpec): Rule {
  const src =
    spec.re ??
    `${spec.prefix}[${spec.chars ?? "A-Za-z0-9"}]{${spec.min ?? 20},${spec.max ?? 300}}`;
  return {
    id: spec.id,
    label: spec.label,
    kind: "secret",
    pattern: new RegExp(`(?<![A-Za-z0-9_])${src}(?![A-Za-z0-9_-])`, spec.ci ? "gi" : "g"),
    verify: spec.verify ?? notFiller,
    source: spec.source ?? GITLEAKS,
  };
}

/** Provider prefixes whose own shape identifies a credential. */
const VENDOR_SPECS: VendorSpec[] = [
  // --- AI providers -------------------------------------------------------
  // `sk-` covers OpenAI-compatible vendors (DeepSeek, Moonshot, DashScope,
  // Zhipu paas, SiliconFlow, StepFun, ...). The body must be one contiguous
  // alnum run so words like `sk-configuration-example` never match.
  { id: "sk-generic", label: "API_KEY", prefix: "sk-", min: 20, max: 200 },
  { id: "openrouter-key", label: "OPENROUTER_KEY", prefix: "sk-or-v1-", min: 40, max: 100 },
  { id: "groq-key", label: "GROQ_KEY", prefix: "gsk_", min: 40, max: 80 },
  { id: "xai-key", label: "XAI_KEY", prefix: "xai-", min: 40, max: 100 },
  { id: "perplexity-key", label: "PERPLEXITY_KEY", prefix: "pplx-", min: 30, max: 80 },
  { id: "replicate-key", label: "REPLICATE_KEY", prefix: "r8_", min: 30, max: 48 },
  { id: "together-key", label: "TOGETHER_KEY", prefix: "tgp_v1_", min: 30, max: 80 },
  // `ark-` = volcengine Ark (doubao): UUID hex groups + optional short suffix
  {
    id: "ark-token",
    label: "ARK_KEY",
    re: String.raw`\bark-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}(?:-[0-9a-f]{2,12})*\b`,
    ci: true,
  },
  // Zhipu / bigmodel style `<32-hex-id>.<32-alnum-secret>` pair
  {
    id: "dotted-id-secret",
    label: "API_KEY",
    re: String.raw`\b[0-9a-z]{16,40}\.[A-Za-z0-9]{16,64}\b`,
    verify: (v) => {
      const [, secret = ""] = v.split(".");
      return /[0-9]/.test(v.split(".")[0] ?? "") && /[A-Za-z]/.test(secret) && /[0-9]/.test(secret) && entropy(secret) >= 3;
    },
  },
  // China cloud providers with fixed AK prefixes
  { id: "tencent-ak", label: "TENCENT_AK", prefix: "AKID", chars: "A-Za-z0-9", min: 13, max: 40 },
  { id: "baidu-ak", label: "BAIDU_AK", prefix: String.raw`bce-v3/ALTAK-`, chars: "A-Za-z0-9_\-", min: 16, max: 80 },
  { id: "alibaba-ak", label: "ALIBABA_AK", prefix: "LTAI", chars: "A-Za-z0-9", min: 12, max: 30 },

  // --- source hosts -------------------------------------------------------
  { id: "github-fine-grained", label: "GITHUB_TOKEN", prefix: "github_pat_", chars: "A-Za-z0-9_", min: 60, max: 255 },
  { id: "github-app", label: "GITHUB_TOKEN", prefix: "gh[suro]_", chars: "A-Za-z0-9", min: 30, max: 255 },
  { id: "gitlab-token", label: "GITLAB_TOKEN", prefix: "gl(?:pat|rt|dt|ft|ptt|cbt|imt|soat|oas|agent|ffct)-", chars: "A-Za-z0-9_-", min: 16, max: 300 },
  { id: "gitlab-legacy", label: "GITLAB_TOKEN", prefix: "GR1348941", chars: "A-Za-z0-9_-", min: 16, max: 60 },
  { id: "gitee-token", label: "GITEE_TOKEN", prefix: "gitee_", chars: "A-Za-z0-9", min: 20, max: 60 },
  { id: "bitbucket-token", label: "BITBUCKET_TOKEN", prefix: "ATBB", chars: "A-Za-z0-9", min: 20, max: 60 },
  { id: "atlassian-token", label: "ATLASSIAN_TOKEN", prefix: "ATATT", chars: "A-Za-z0-9_=\\-/", min: 40, max: 400 },
  { id: "npm-token-v", label: "NPM_TOKEN", prefix: "npm_", chars: "A-Za-z0-9", min: 30, max: 60 },
  { id: "rubygems-token", label: "RUBYGEMS_TOKEN", prefix: "rubygems_", chars: "A-Za-z0-9", min: 40, max: 60 },
  { id: "clojars-token", label: "CLOJARS_TOKEN", prefix: "CLOJARS_", chars: "A-Za-z0-9", min: 50, max: 80, ci: true },

  // --- cloud / infra ------------------------------------------------------
  { id: "aws-bedrock-key", label: "AWS_KEY", prefix: "ABSK", chars: "A-Za-z0-9+/=", min: 80, max: 300 },
  { id: "digitalocean-token", label: "DIGITALOCEAN_TOKEN", prefix: "do[rpo]_v1_", chars: "a-f0-9", min: 60, max: 64 },
  { id: "heroku-key", label: "HEROKU_KEY", prefix: "HRKU-AA", chars: "A-Za-z0-9_-", min: 50, max: 70 },
  { id: "flyio-token", label: "FLY_TOKEN", prefix: "fo1_", chars: "A-Za-z0-9_-", min: 40, max: 60 },
  { id: "flyio-machines", label: "FLY_TOKEN", prefix: "fm[12]_[a-z]*", chars: "A-Za-z0-9+/=", min: 90, max: 300 },
  { id: "netlify-token", label: "NETLIFY_TOKEN", prefix: "nfp_", chars: "A-Za-z0-9", min: 30, max: 60 },
  { id: "render-token", label: "RENDER_TOKEN", prefix: "rnd_", chars: "A-Za-z0-9", min: 20, max: 50 },
  { id: "cloudflare-origin-ca", label: "CLOUDFLARE_KEY", prefix: String.raw`v1\.0-[a-f0-9]{24}-`, chars: "a-f0-9", min: 100, max: 200 },
  { id: "openshift-token", label: "OPENSHIFT_TOKEN", prefix: "sha256~", chars: "A-Za-z0-9_-", min: 40, max: 60 },
  { id: "hashicorp-vault", label: "VAULT_TOKEN", prefix: "hv[bs]\.", chars: "A-Za-z0-9_-", min: 90, max: 300 },
  { id: "terraform-cloud", label: "TF_TOKEN", prefix: String.raw`[a-z0-9]{14}\.atlasv1\.`, chars: "A-Za-z0-9_=\\-", min: 50, max: 80 },
  { id: "pulumi-token", label: "PULUMI_TOKEN", prefix: "pul-", chars: "a-f0-9", min: 40, max: 44 },

  // --- observability / dev SaaS ------------------------------------------
  { id: "sentry-user-token", label: "SENTRY_TOKEN", prefix: "sntryu_", chars: "a-f0-9", min: 60, max: 64 },
  { id: "sentry-org-token", label: "SENTRY_TOKEN", prefix: "sntrys_", chars: "A-Za-z0-9+/=", min: 60, max: 300 },
  { id: "grafana-cloud-token", label: "GRAFANA_TOKEN", prefix: "gl[cs]a?_", chars: "A-Za-z0-9+/", min: 30, max: 400 },
  { id: "grafana-api-key", label: "GRAFANA_KEY", prefix: "eyJrIjoi", chars: "A-Za-z0-9", min: 60, max: 400 },
  { id: "newrelic-key", label: "NEWRELIC_KEY", prefix: "NRAK-", chars: "A-Z0-9", min: 20, max: 40 },
  { id: "sonar-token", label: "SONAR_TOKEN", prefix: "squ_", chars: "a-f0-9", min: 40, max: 48 },
  { id: "postman-token", label: "POSTMAN_TOKEN", prefix: "PMAK-", chars: "a-fA-F0-9-", min: 40, max: 80 },
  { id: "doppler-token", label: "DOPPLER_TOKEN", prefix: "dp\\.pt\\.", chars: "a-z0-9", min: 40, max: 50 },
  { id: "contentful-token", label: "CONTENTFUL_TOKEN", prefix: "CFPAT-", chars: "A-Za-z0-9_-", min: 40, max: 80 },

  // --- payments / commerce ------------------------------------------------
  { id: "square-token", label: "SQUARE_TOKEN", prefix: "sq0atp-", chars: "A-Za-z0-9_-", min: 20, max: 60 },
  { id: "shopify-token", label: "SHOPIFY_TOKEN", prefix: "shp(?:at|ca|pa|ss)_", chars: "a-fA-F0-9", min: 32, max: 32 },
  { id: "plaid-token", label: "PLAID_TOKEN", prefix: "access-(?:sandbox|development|production)-", chars: "A-Za-z0-9-", min: 20, max: 60 },
  { id: "mapbox-token", label: "MAPBOX_TOKEN", prefix: "p[ks]\\.eyJ", chars: "A-Za-z0-9_=.\\-", min: 30, max: 200 },

  // --- productivity -------------------------------------------------------
  { id: "notion-token", label: "NOTION_TOKEN", prefix: "(?:ntn_|secret_)", chars: "A-Za-z0-9", min: 40, max: 60 },
  { id: "linear-token", label: "LINEAR_TOKEN", prefix: "lin_api_", chars: "A-Za-z0-9", min: 40, max: 60 },
  { id: "1password-key", label: "ONEPASSWORD_KEY", prefix: "A3-", chars: "A-Z0-9-", min: 40, max: 60 },
  { id: "1password-token", label: "ONEPASSWORD_TOKEN", prefix: "ops_eyJ", chars: "A-Za-z0-9+/=", min: 200, max: 400 },
  { id: "age-key", label: "AGE_KEY", prefix: "AGE-SECRET-KEY-1", chars: "A-Z0-9", min: 50, max: 70 },
  { id: "docker-pat", label: "DOCKER_TOKEN", prefix: "dckr_pat_", chars: "A-Za-z0-9_-", min: 20, max: 60 },
];
// airtable: `pat` + 14 alnum + `.` + 64 hex (the plain `pat…` form above is the
// tolerant half; the dotted form is matched by the full entry below)
VENDOR_SPECS.push({
  id: "airtable-pat",
  label: "AIRTABLE_TOKEN",
  re: String.raw`\bpat[A-Za-z0-9]{14}\.[a-f0-9]{64}\b`,
});

/** Bots and webhooks: the URL itself is the credential. */
const WEBHOOK_RULES: Rule[] = [
  {
    id: "discord-webhook",
    label: "DISCORD_WEBHOOK",
    kind: "secret",
    pattern: /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d{15,25}\/[A-Za-z0-9_-]{60,90}/g,
    source: "https://discord.com/developers/docs/resources/webhook",
  },
  {
    id: "telegram-bot-url",
    label: "TELEGRAM_TOKEN",
    kind: "secret",
    pattern: /https:\/\/api\.telegram\.org\/bot\d{8,12}:[A-Za-z0-9_-]{30,40}/g,
    source: "https://core.telegram.org/bots/api#authorizing-your-bot",
  },
  {
    id: "feishu-webhook",
    label: "FEISHU_WEBHOOK",
    kind: "secret",
    pattern: /https:\/\/open\.(?:feishu\.cn|larksuite\.com)\/open-apis\/bot\/v2\/hook\/[0-9a-f-]{36}/g,
    source: "https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot",
  },
  {
    id: "dingtalk-webhook",
    label: "DINGTALK_WEBHOOK",
    kind: "secret",
    pattern: /https:\/\/oapi\.dingtalk\.com\/robot\/send\?access_token=[0-9a-f]{64}/g,
    source: "https://open.dingtalk.com/document/orgapp/custom-robot-access",
  },
  {
    id: "wecom-webhook",
    label: "WECOM_WEBHOOK",
    kind: "secret",
    pattern: /https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=[0-9a-f-]{36}/g,
    source: "https://developer.work.weixin.qq.com/document/path/91770",
  },
];

// ---------------------------------------------------------------------------
// Layer 2 — context grammar: keyword + connector soup + credential-shaped value
// ---------------------------------------------------------------------------
// The old rules each spelled out one separator (=, :, is, 是, quoted). Any // cjk-ok
// phrasing outside that enumeration leaked. This rule does not enumerate:
// after a credential keyword it accepts up to 20 connector TOKENS (spaces,
// newlines, quotes, brackets, any operator, arrows, parentheses, the copulas
// and link verbs) and then takes the first credential-shaped value. `token X`,
// `token X`, `token\nX`, `KEY => X`, `密钥如下：X`, `| token | X |` all collapse // cjk-ok
// into one grammar. The value still has to survive bareSecret (entropy, no
// identifiers, no prose words), which is what keeps false positives down.

const KEYWORD_ALT = String.raw`(?:api[ _-]?key|access[ _-]?key(?:[ _-]?(?:id|secret))?|secret[ _-]?access[ _-]?key|secret[ _-]?key|private[ _-]?key|public[ _-]?key|client[ _-]?(?:secret|id)|app[ _-]?(?:key|secret)|appid|appsecret|consumer[ _-]?(?:key|secret)|license[ _-]?key|signing[ _-]?key|encryption[ _-]?key|master[ _-]?key|api[ _-]?secret|access[ _-]?token|refresh[ _-]?token|id[ _-]?token|session[ _-]?token|auth[ _-]?token|apikey|key|bearer|passphrase|password|passwd|passw|pwd|creds|credential|secret|token|auth|webhook|dsn|salt|ak|sk|密码|密钥|秘钥|口令|令牌|凭证|凭据|私钥|公钥|通行码|授权码|访问密钥|访问令牌|签名密钥|加密密钥|パスワード|トークン|秘密鍵|비밀번호|토큰|пароль|токен)`;

/** A value must start with an alphanumeric and may not contain whitespace/CJK prose. */
const VALUE_BODY = String.raw`((?:[A-Za-z0-9](?:[^\s"'\u0060;,(){}<>[\]\\，。、；：！？“”‘’（）「」『』【】]|\\(?![nrt])){7,299}))`;
const VALUE_TAIL = String.raw`(?!(?!\\[nrt])[^\s"'\u0060;,(){}<>[\]，。、；：！？“”‘’（）「」『』【】])`;

/** Strong connector: an operator, a copula, a quote, a line break or a table cell. */
const STRONG_SEP = String.raw`(?:(?:(?:[ \t]{0,5}(?::=|=>|->|→|[=:：]{1,3})|[ \t]{0,5}(?:是|为|就是|如下|分别为|即|等于|\bis\b|\bare\b|\bwas\b|\bwere\b|\bequals?\b|\bnamed\b|\bcalled\b)[ \t]{0,5}(?::=|=>|[=:：])?|[ \t]{0,4}[|,;，。、]|\s*\n\s*)[ \t]{0,3}["'\u0060“”‘’「」『』【】]?[ \t]{0,3})|(?:[ \t]{0,2}["'\u0060“”‘’「」『』【】][ \t]{0,3}))`;
/** Weak connector: whitespace (optionally one quote) only. */
const WEAK_SEP = String.raw`[ \t]{1,5}["'\u0060“”‘’「」『』【】]?[ \t]{0,4}`;

/**
 * Keyword boundary: a real word boundary, a CJK neighbour, or a camelCase
 * compound whose head is a known credential qualifier (`dbPassword`,
 * `clientSecret`). A random hump (`CryptoKey`, `KeyboardEvent`) is not a
 * credential keyword.
 */
function keywordBoundary(text: string, at: number): boolean {
  if (at === 0) return true;
  const prev = text.charAt(at - 1);
  if (prev === ":") return false;
  if (!/[A-Za-z0-9]/.test(prev)) return true;
  if (!/[A-Za-z]/.test(prev)) return false;
  const head = /([A-Za-z][A-Za-z0-9]*)$/.exec(text.slice(Math.max(0, at - 24), at))?.[1] ?? "";
  return /^(?:api|db|client|app|access|secret|private|public|auth|session|refresh|id|user|admin|master|license|signing|encryption|consumer|service|server|account|proxy)$/i.test(head);
}

/** Weak (whitespace-only) evidence demands a machine-generated shape. */
function contextValue(v: string): boolean {
  if (/[\u3040-\u30ff\uac00-\ud7af\u4e00-\u9fff]/.test(v)) return false;
  if (/^\d{1,4}[月日年]/.test(v)) return false;
  return credentialShape(v) || assignedSecret(v);
}

/** Strong evidence: the operator/copula already names the field. */
function strongValue(v: string): boolean {
  if (/[\u3040-\u30ff\uac00-\ud7af\u4e00-\u9fff]/.test(v)) return false;
  if (/^\d{1,4}[月日年]/.test(v)) return false;
  return bareSecret(v) || assignedSecret(v) || credentialShape(v);
}

const CONTEXT_RULES: Rule[] = [
  {
    id: "keyword-value",
    label: "SECRET",
    kind: "secret",
    pattern: new RegExp(`${KEYWORD_ALT}${STRONG_SEP}${VALUE_BODY}${VALUE_TAIL}`, "gi"),
    group: 1,
    verify: strongValue,
    before: keywordBoundary,
    source: GITLEAKS,
  },
  {
    // The old rules enumerated separators; this one does not. `token X`,
    // `token\nX`, `KEY => X`, `密钥如下：X`, `| token | X |` all reach the value; // cjk-ok
    // because the evidence here is only whitespace, the value must pass the
    // strict machine-generated shape gate.
    id: "keyword-bare-value",
    label: "SECRET",
    kind: "secret",
    pattern: new RegExp(`${KEYWORD_ALT}${WEAK_SEP}${VALUE_BODY}${VALUE_TAIL}`, "gi"),
    group: 1,
    verify: contextValue,
    before: keywordBoundary,
    source: GITLEAKS,
  },
];

/** `?api_key=X`, `&access_token=X`, `?sig=X` in any URL. */
const URL_PARAM_RULE: Rule = {
  id: "url-param",
  label: "SECRET",
  kind: "secret",
  pattern:
    /[?&](?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|session[_-]?token|id[_-]?token|token|key|secret|password|passwd|pwd|sig|signature|client[_-]?secret|code)=([^&\s"'<>#]{8,300})/gi,
  group: 1,
  verify: (v) => plausibleSecret(v) && entropy(v) >= 2.6 && !placeholderShaped(v),
  source: GITLEAKS,
};

// ---------------------------------------------------------------------------
// Layer 3 — a standalone credential-shaped token on its own line
// ---------------------------------------------------------------------------
// Covers "the user pastes only the key" and providers whose prefix we do not
// know. Gated hard (line dominance + multi-class shape + entropy), so git
// SHAs, UUIDs, checksums, versions, data-URI base64 and code stay untouched.

const VALUE_ONLY_RE =
  /(?<=^|[\s"'`(\[{<>,;:：，。、=])([A-Za-z0-9][A-Za-z0-9_\-+.\/~]{15,117}(?:={1,2})?)(?=$|[\s"'`)\]}>;,：，。、])/gm;

/** Shapes that are long and random but are not credentials. */
const NOT_CREDENTIAL =
  /^(?:sha(?:1|224|256|384|512)?[-_]|md5[-_]|integrity|etag|data:|blob:|file:|https?:|git\+|npm:|docker:|oci:|sha256~|iVBORw0KGgo|R0lGOD|JVBERi|UEsDB|\/9j\/|v?\d+(?:\.\d+){2})/;

/** True when a standalone token has the shape of a credential. */
function credentialShape(v: string): boolean {
  if (v.length < 16 || v.length > 120) return false;
  if (!/[A-Za-z]/.test(v) || !/\d/.test(v)) return false;
  if (!plausibleSecret(v) || placeholderShaped(v)) return false;
  if (NOT_CREDENTIAL.test(v)) return false;
  // hex-only: git sha, md5, uuid body, byte blobs
  if (/^[0-9a-f]+$/i.test(v)) return false;
  // canonical uuid
  if (/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v)) return false;
  if (entropy(v) < 3.1) return false;
  const classes = (/[a-z]/.test(v) ? 1 : 0) + (/[A-Z]/.test(v) ? 1 : 0) + (/\d/.test(v) ? 1 : 0);
  if (classes < 2) return false;
  // A dotted chain with three or more parts is code or a host name, not a key.
  if (/^[A-Za-z0-9]+(?:\.[A-Za-z0-9]+){2,}$/.test(v)) return false;
  const segments = v.split(/[-_.]+/).filter(Boolean);
  const longSegment = segments.some((s) => s.length >= 16 && /[A-Za-z]/.test(s) && /\d/.test(s));
  // Either long mixed-case randomness (no separator needed), or a prefixed
  // form whose random part is one long segment (`provider-<32 base62>`).
  if (classes === 3) return true;
  return longSegment && entropy(v) >= 3.2;
}

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
  ...VENDOR_SPECS.map(vendorRule),
  ...WEBHOOK_RULES,
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
    // keyword then either an assignment operator or the natural-language copula
    // (`password is "xxx"`, `密码是"xxx"`) before the quoted value // cjk-ok
    pattern: /(?:api[ _-]?key|secret(?:[ _-]?key)?|token|password|passwd|pwd|auth|credential|密码|密钥|秘钥|口令|令牌|授权码|授权密钥|访问令牌|访问密钥|凭证|凭据|私钥)s?["'`]?(?:[ \t]{0,5}(?::=|=>|[=:]|：)|(?:[ \t]+is\b|[ \t]{0,3}是)[ \t]{0,5}(?::=|=>|[=:]|：)?)[ \t]{0,5}["'`]([^\s"'`]{8,256})["'`]/gi,
    group: 1,
    verify: quotedSecret,
    before: keywordStart,
    source: GITLEAKS,
  },
  {
    id: "generic-secret-assign",
    label: "SECRET",
    kind: "secret",
    // keyword then an assignment verb: `密码改成 X`, `new password X`, `set the password to X` // cjk-ok
    pattern: /(?:api[ _-]?key|secret(?:[ _-]?key)?|token|password|passwd|pwd|passphrase|auth|credential|新密码|新口令|新的密码|密码|密钥|秘钥|口令|令牌|授权码|授权密钥|访问令牌|访问密钥|凭证|凭据|私钥)s?["'`]?(?:[ \t]+to\b|[ \t]{0,5}(?:改为|改到|改成|修改为|设置为|设置成|设为|设成|置为|配置为|配置成|换成|换为|变为|变成|重置为|重设为|更改为|更新为))[ \t:：]{0,5}["'`]?((?:[^\s"'`;,(){}<>[\]\\，。、；：！？“”‘’（）]|\\(?![nrt])){8,256})(?!(?!\\[nrt])[^\s"'`;,(){}<>[\]，。、；：！？“”‘’（）])/gi,
    group: 1,
    verify: (v) => bareSecret(v) || assignedSecret(v),
    before: keywordStart,
    source: GITLEAKS,
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
    source: GITLEAKS,
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
    source: GITLEAKS,
  },
  {
    id: "generic-secret",
    label: "SECRET",
    kind: "secret",
    // a literal \n, \r or \t (backslash and letter) ends the value, as in a dotenv string inside source code;
    // fullwidth CJK punctuation also ends the value (`密码：abc123，请记好` must not swallow the trailing prose) // cjk-ok
    // keyword then either an assignment operator or the natural-language copula (`password is xxx`, `密码是xxx`) // cjk-ok
    pattern: /(?:api[ _-]?key|secret(?:[ _-]?key)?|token|password|passwd|pwd|auth|credential|密码|密钥|秘钥|口令|令牌|授权码|授权密钥|访问令牌|访问密钥|凭证|凭据|私钥)s?["'`]?(?:[ \t]{0,5}(?::=|=>|[=:]|：)|(?:[ \t]+is\b|[ \t]{0,3}是)[ \t]{0,5}(?::=|=>|[=:]|：)?)[ \t]{0,5}((?:[^\s"'`;,(){}<>[\]\\，。、；：！？“”‘’（）]|\\(?![nrt])){8,256})(?!(?!\\[nrt])[^\s"'`;,(){}<>[\]，。、；：！？“”‘’（）])/gi,
    group: 1,
    verify: bareSecret,
    before: keywordStart,
    source: GITLEAKS,
  },
  {
    id: "generic-secret-bare",
    label: "SECRET",
    kind: "secret",
    // keyword + whitespace + value with NO operator/copula/quote — the most
    // common chat paste shape (see the bare-form cases in test/detect.test.mjs).
    // A bare keyword binds prose loosely, so date-phrase-shaped values are
    // rejected and the operator forms' entropy/shape bars still apply.
    // The value must start with an alphanumeric (CLI flags like `--secret-id`
    // and template slots are not values) and CJK prose never is one.
    pattern: /(?:api[ _-]?key|secret(?:[ _-]?key)?|token|password|passwd|pwd|passphrase|credential|密码|密钥|秘钥|口令|令牌|授权码|授权密钥|访问令牌|访问密钥|凭证|凭据|私钥)s?[ \t]{1,5}["'`]?([A-Za-z0-9](?:[^\s"'`;,(){}<>[\]\\，。、；：！？“”‘’（）]|\\(?![nrt])){7,255})(?!(?!\\[nrt])[^\s"'`;,(){}<>[\]，。、；：！？“”‘’（）])/gi,
    group: 1,
    verify: (v) =>
      !/[\u3040-\u30ff\uac00-\ud7af\u4e00-\u9fff]/.test(v) &&
      !/^\d{1,4}[月日年]/.test(v) &&
      (bareSecret(v) || assignedSecret(v)),
    before: keywordStart,
    source: GITLEAKS,
  },
  // Broad context grammar + URL parameters (see Layer 2 above).
  ...CONTEXT_RULES,
  URL_PARAM_RULE,
];

// ---------------------------------------------------------------------------
// base64-wrapped detection (a run whose decoded text trips a prefix rule)
// ---------------------------------------------------------------------------

const WRAPPABLE = new Set([
  "aws-access-key", "github-token", "gitlab-pat", "slack-token", "slack-webhook", "stripe-live-key", "sendgrid-key",
  "twilio-key", "google-api-key", "google-oauth-secret", "anthropic-key", "openai-key", "huggingface-token",
  "npm-token", "pypi-token", "ark-token", "sk-generic", "openrouter-key", "github-fine-grained", "gitlab-token",
  "private-key", "private-key-truncated", "db-connection-url", "jwt",
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

// Placeholder shapes live in ./placeholder.ts (v2 `rsec_*` + legacy v1).
import { PLACEHOLDER_RE } from "./placeholder.ts";

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
      if (inPlaceholder || insideTemplate(masked, start) || (rule.before && !rule.before(masked, m.index)) || (rule.verify && !rule.verify(value))) {
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

  // Layer 3: a standalone credential-shaped token that dominates its own line
  // (bare paste, or a labelled value the context grammar did not reach). Line
  // dominance — at most 24 chars of other content — is what keeps minified
  // code, log lines and prose paragraphs out.
  if (!opts.off?.has("value-only")) {
    // Bare-paste mode only: a short, one-or-two-line user text. A pasted file
    // or log is left to the shape and context layers -- flagging every random
    // token inside a file is noise, not protection.
    const nonEmptyLines = masked.split("\n").filter((line) => line.trim()).length;
    const trimmedLength = masked.trim().length;
    if (nonEmptyLines <= 2 && trimmedLength <= 200) {
      VALUE_ONLY_RE.lastIndex = 0;
      for (let m = VALUE_ONLY_RE.exec(masked); m !== null; m = VALUE_ONLY_RE.exec(masked)) {
        const value = m[1]!;
        const start = m.index + m[0].indexOf(value);
        const end = start + value.length;
        const lineStart = Math.max(masked.lastIndexOf("\n", start - 1) + 1, 0);
        const nextBreak = masked.indexOf("\n", end);
        const lineEnd = nextBreak === -1 ? masked.length : nextBreak;
        const line = masked.slice(lineStart, lineEnd).trim();
        if (line.length - value.length > 24) continue;
        if (spans.some(([s, e]) => start < e && end > s)) continue;
        if (!credentialShape(value)) continue;
        found.push({
          id: "value-only",
          label: "SECRET",
          kind: "secret",
          start,
          end,
          value: head.slice(start, end),
          order: RULES.length,
        });
      }
    }
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

// ---------------------------------------------------------------------------
// Preflight candidates — the human-confirmed path is allowed to be looser
// ---------------------------------------------------------------------------
// Automatic masking must not guess (a wrong guess rewrites the user's words
// silently). A pre-send confirmation can afford to guess, because the user sees
// the list and decides. So this pass returns MEDIUM-confidence candidates on
// top of the normal hits:
//   - keyword-adjacent values with relaxed shape bars (short ids, hex, etc.)
//   - standalone machine-looking tokens that auto-mode refuses to touch
// The host shows `preview` (never the value) and masks only what was accepted.

export type CandidateConfidence = "high" | "medium";

export interface Candidate extends Hit {
  confidence: CandidateConfidence;
}

/** Medium evidence, keyword-bound: still not a path/URL/template/checksum. */
function relaxedValue(v: string): boolean {
  if (v.length < 6) return false;
  if (!plausibleSecret(v) || placeholderShaped(v)) return false;
  if (NOT_CREDENTIAL.test(v)) return false;
  if (/[|#]/.test(v)) return false;
  if (!/\d/.test(v) && /^[a-z][a-z_-]*$/.test(v)) return false; // a sentence word
  return true;
}

/** Same value grammar, 6-char floor (the confirmed path may offer short ids). */
const VALUE_BODY_MIN6 = VALUE_BODY.replace("{7,299}", "{5,299}");

const RELAXED_CONTEXT_RULES: Rule[] = [
  {
    id: "candidate-keyword",
    label: "SECRET",
    kind: "secret",
    pattern: new RegExp(`${KEYWORD_ALT}${STRONG_SEP}${VALUE_BODY_MIN6}${VALUE_TAIL}`, "gi"),
    group: 1,
    verify: relaxedValue,
    before: keywordBoundary,
    source: GITLEAKS,
  },
  {
    id: "candidate-keyword-bare",
    label: "SECRET",
    kind: "secret",
    pattern: new RegExp(`${KEYWORD_ALT}${WEAK_SEP}${VALUE_BODY_MIN6}${VALUE_TAIL}`, "gi"),
    group: 1,
    verify: relaxedValue,
    before: keywordBoundary,
    source: GITLEAKS,
  },
];

/** Standalone token, medium evidence: machine-looking but not auto-maskable. */
const CANDIDATE_TOKEN_RE =
  /(?<=^|[\s"'`(\[{<>,;:：，。、=])([A-Za-z0-9][A-Za-z0-9_\-+.\/~]{11,199}(?:={1,2})?)(?=$|[\s"'`)\]}>;,：，。、])/gm;

function candidateShaped(v: string): boolean {
  if (v.length < 12 || v.length > 200) return false;
  if (!/[A-Za-z]/.test(v) || !/\d/.test(v)) return false;
  if (!plausibleSecret(v) || placeholderShaped(v)) return false;
  if (NOT_CREDENTIAL.test(v)) return false;
  if (entropy(v) < 2.6) return false;
  if (v.includes("=") && !/={1,2}$/.test(v)) return false;
  if (/[|#]/.test(v)) return false;
  // a pasted commit id or digest is usually not a credential; keyword-attached
  // hex is still offered through the rules above
  if (/^(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})$/i.test(v)) return false;
  if (/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v)) return false;
  // With separators, one segment must be long and alphanumeric: a kebab of
  // short words/dates (`release-2024-12-01-final`) is a name, not a token.
  if (/[-_.]/.test(v)) {
    const segs = v.split(/[-_.]+/).filter(Boolean);
    if (!segs.some((seg) => seg.length >= 12 && /[A-Za-z]/.test(seg) && /\d/.test(seg))) return false;
  }
  return true;
}

/**
 * Detection for a human-confirmed gate. `strict` adds medium-confidence
 * candidates; results keep positional order and are de-duplicated (a high hit
 * always wins over a medium one covering the same span).
 */
export function scanCandidates(text: string, opts: { strict?: boolean } = {}): Candidate[] {
  const high: Candidate[] = scan(text).map((h) => ({ ...h, confidence: "high" }));
  if (!opts.strict) return high;

  // Placeholders already in the text are not new secrets: protect them the same
  // way scan() does (equal-length spaces keep every offset stable).
  const spans: Array<[number, number]> = [];
  PLACEHOLDER_RE.lastIndex = 0;
  let masked = text;
  for (let m = PLACEHOLDER_RE.exec(text); m !== null; m = PLACEHOLDER_RE.exec(text)) {
    spans.push([m.index, m.index + m[0].length]);
  }
  if (spans.length > 0) {
    let out = "";
    let at = 0;
    for (const [s, e] of spans) {
      out += text.slice(at, s) + " ".repeat(e - s);
      at = e;
    }
    masked = out + text.slice(at);
  }

  type Ranked = Candidate & { order: number };
  const found: Ranked[] = high.map((h, order) => ({ ...h, order }));
  const inPlaceholder = (start: number, end: number) => spans.some(([s, e]) => start < e && end > s);
  const covered = (start: number, end: number) => inPlaceholder(start, end) || found.some((h) => start < h.end && end > h.start);

  const collect = (rules: readonly Rule[], orderBase: number) => {
    rules.forEach((rule, index) => {
      const { re, indexed } = compile(rule.pattern);
      const g = rule.group ?? 0;
      re.lastIndex = 0;
      for (let m = re.exec(masked); m !== null; m = re.exec(masked)) {
        const raw = m[g];
        if (!raw) {
          if (m[0] === "") re.lastIndex++;
          continue;
        }
        const start = indexed ? (m.indices?.[g]?.[0] ?? -1) : m.index + m[0].lastIndexOf(raw);
        if (start < 0) continue;
        const end = start + raw.length;
        const value = text.slice(start, end);
        if (covered(start, end) || insideTemplate(masked, start) || (rule.before && !rule.before(masked, m.index)) || (rule.verify && !rule.verify(value))) {
          re.lastIndex = m.index + 1;
          continue;
        }
        found.push({ id: rule.id, label: rule.label, kind: rule.kind, start, end, value, confidence: "medium", order: orderBase + index });
        re.lastIndex = m.index + raw.length;
      }
      re.lastIndex = 0;
    });
  };

  collect(RELAXED_CONTEXT_RULES, RULES.length);
  const tokenOrder = RULES.length + RELAXED_CONTEXT_RULES.length;
  // Standalone tokens only for chat-sized text: a pasted file or log would fill
  // the confirmation list with every random string on the page. Keyword-bound
  // candidates above still work for big pastes, so nothing real is lost.
  const chatSized = masked.split("\n").filter((line) => line.trim()).length <= 20 && masked.trim().length <= 4000;
  CANDIDATE_TOKEN_RE.lastIndex = 0;
  for (let m = chatSized ? CANDIDATE_TOKEN_RE.exec(masked) : null; m !== null; m = CANDIDATE_TOKEN_RE.exec(masked)) {
    const value = m[1]!;
    const start = m.index + m[0].indexOf(value);
    const end = start + value.length;
    if (covered(start, end) || !candidateShaped(value)) continue;
    found.push({ id: "candidate-token", label: "SECRET", kind: "secret", start, end, value, confidence: "medium", order: tokenOrder });
  }

  found.sort((a, b) => a.start - b.start || b.end - a.end || a.order - b.order);
  const out: Candidate[] = [];
  let lastEnd = -1;
  for (const h of found) {
    if (h.start < lastEnd) continue;
    const { order: _order, ...hit } = h;
    out.push(hit);
    lastEnd = h.end;
  }
  // A confirmation list has to stay reviewable: keep the first CANDIDATE_LIMIT
  // and let callers report the remainder (the host shows "and N more").
  return out.slice(0, CANDIDATE_LIMIT);
}

/** Upper bound on candidates offered in one confirmation dialog. */
export const CANDIDATE_LIMIT = 40;

/** Masked preview for a confirmation list (`ark-1a2b…c5d`), never the value. */
export function previewValue(value: string): string {
  if (value.length <= 10) return "*".repeat(value.length);
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
