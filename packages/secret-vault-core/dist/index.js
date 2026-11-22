// src/crypto.ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
var KEY_BYTES = 32;
var IV_BYTES = 12;
var TAG_BYTES = 16;
function generateKey() {
  return randomBytes(KEY_BYTES);
}
function encryptValue(key, plaintext) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ct.toString("base64")
  };
}
function decryptValue(key, env) {
  const iv = Buffer.from(env.iv, "base64");
  const tag = Buffer.from(env.tag, "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error("vault: malformed envelope");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(env.ct, "base64")), decipher.final()]).toString("utf8");
}
function writeFileAtomic(path, data, mode = 384) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, data, { mode });
  try {
    chmodSync(tmp, mode);
  } catch {
  }
  renameSync(tmp, path);
  try {
    chmodSync(path, mode);
  } catch {
  }
}
function readKeyFile(path) {
  try {
    const raw = readFileSync(path);
    if (raw.length !== KEY_BYTES) throw new Error(`vault: keyfile ${path} must be exactly ${KEY_BYTES} bytes`);
    return raw;
  } catch (e) {
    if (e.code === "ENOENT") return void 0;
    throw e;
  }
}
function createKeyFile(path) {
  const key = generateKey();
  writeFileAtomic(path, key, 384);
  return key;
}

// src/store.ts
import { homedir as homedir2 } from "node:os";
import { chmodSync as chmodSync3, existsSync as existsSync2, readFileSync as readFileSync3, renameSync as renameSync2, rmSync as rmSync2 } from "node:fs";
import { join as join2 } from "node:path";

// ../secret-mask-core/dist/index.js
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
function stablePlaceholder(namespace, alias) {
  return placeholderFromHash(fnv1a(`${namespace}:${alias}`));
}
var PLACEHOLDER_RE = /(?<![A-Za-z0-9_@$.-])rsec_[0-9a-f]{8}\b|\[REDACTED:[A-Za-z0-9_-]{1,64}(?:#[0-9a-fA-F]{1,16})?\]/g;
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
  if (/^(?:sha\d{0,3}[-_]|md5[-_]|h1[-:]|integrity)/i.test(v)) return false;
  if (/^(.)\1*$/.test(v)) return false;
  if (/^v?\d+(?:\.\d+){2,}(?:[-+][A-Za-z0-9.-]+)?$/.test(v)) return false;
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
function codeishValue(v) {
  if (v.includes("=") && !/={1,2}$/.test(v)) return true;
  if (v.includes("#")) return true;
  if (v.includes("|")) return true;
  if (/[!?]$/.test(v)) return true;
  if (/\.[a-z_$][\w$]*\s*\(/i.test(v)) return true;
  if (/^[a-z_$][\w$]*(?:\.[a-z_$][\w$]*){1,}$/i.test(v)) return true;
  return false;
}
function bareSecret(v) {
  if (!plausibleSecret(v) || placeholderShaped(v) || entropy(v) < 2.5) return false;
  if (!/\d/.test(v) && /^[A-Za-z_$][\w$]*(?:[.\-][A-Za-z_$][\w$]*)*$/.test(v)) {
    const upperRatio = (segment) => {
      const letters = segment.replace(/[^A-Za-z]/g, "");
      return letters.length < 6 ? 0 : segment.replace(/[^A-Z]/g, "").length / letters.length;
    };
    const dense = Math.max(...v.split(/[-_.]+/).map(upperRatio));
    const snakeConstant = /^[A-Z][A-Z0-9_]*$/.test(v) && v.includes("_");
    const randomish = v.length >= 20 && entropy(v) >= 3.2 && dense >= 0.4 && !snakeConstant;
    if (!randomish) return false;
  }
  if (!/\d/.test(v) && /^[a-z][a-z_-]*[.,;:!?]?$/.test(v)) return false;
  if (codeishValue(v)) return false;
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
function vendorRule(spec) {
  const src = spec.re ?? `${spec.prefix}[${spec.chars ?? "A-Za-z0-9"}]{${spec.min ?? 20},${spec.max ?? 300}}`;
  return {
    id: spec.id,
    label: spec.label,
    kind: "secret",
    pattern: new RegExp(`(?<![A-Za-z0-9_])${src}(?![A-Za-z0-9_-])`, spec.ci ? "gi" : "g"),
    verify: spec.verify ?? notFiller,
    source: spec.source ?? GITLEAKS
  };
}
var VENDOR_SPECS = [
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
    ci: true
  },
  // Zhipu / bigmodel style `<32-hex-id>.<32-alnum-secret>` pair
  {
    id: "dotted-id-secret",
    label: "API_KEY",
    re: String.raw`\b[0-9a-z]{16,40}\.[A-Za-z0-9]{16,64}\b`,
    verify: (v) => {
      const [, secret = ""] = v.split(".");
      return /[0-9]/.test(v.split(".")[0] ?? "") && /[A-Za-z]/.test(secret) && /[0-9]/.test(secret) && entropy(secret) >= 3;
    }
  },
  // China cloud providers with fixed AK prefixes
  { id: "tencent-ak", label: "TENCENT_AK", prefix: "AKID", chars: "A-Za-z0-9", min: 13, max: 40 },
  { id: "baidu-ak", label: "BAIDU_AK", prefix: String.raw`bce-v3/ALTAK-`, chars: "A-Za-z0-9_-", min: 16, max: 80 },
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
  { id: "hashicorp-vault", label: "VAULT_TOKEN", prefix: "hv[bs].", chars: "A-Za-z0-9_-", min: 90, max: 300 },
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
  { id: "docker-pat", label: "DOCKER_TOKEN", prefix: "dckr_pat_", chars: "A-Za-z0-9_-", min: 20, max: 60 }
];
VENDOR_SPECS.push({
  id: "airtable-pat",
  label: "AIRTABLE_TOKEN",
  re: String.raw`\bpat[A-Za-z0-9]{14}\.[a-f0-9]{64}\b`
});
var WEBHOOK_RULES = [
  {
    id: "discord-webhook",
    label: "DISCORD_WEBHOOK",
    kind: "secret",
    pattern: /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d{15,25}\/[A-Za-z0-9_-]{60,90}/g,
    source: "https://discord.com/developers/docs/resources/webhook"
  },
  {
    id: "telegram-bot-url",
    label: "TELEGRAM_TOKEN",
    kind: "secret",
    pattern: /https:\/\/api\.telegram\.org\/bot\d{8,12}:[A-Za-z0-9_-]{30,40}/g,
    source: "https://core.telegram.org/bots/api#authorizing-your-bot"
  },
  {
    id: "feishu-webhook",
    label: "FEISHU_WEBHOOK",
    kind: "secret",
    pattern: /https:\/\/open\.(?:feishu\.cn|larksuite\.com)\/open-apis\/bot\/v2\/hook\/[0-9a-f-]{36}/g,
    source: "https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot"
  },
  {
    id: "dingtalk-webhook",
    label: "DINGTALK_WEBHOOK",
    kind: "secret",
    pattern: /https:\/\/oapi\.dingtalk\.com\/robot\/send\?access_token=[0-9a-f]{64}/g,
    source: "https://open.dingtalk.com/document/orgapp/custom-robot-access"
  },
  {
    id: "wecom-webhook",
    label: "WECOM_WEBHOOK",
    kind: "secret",
    pattern: /https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=[0-9a-f-]{36}/g,
    source: "https://developer.work.weixin.qq.com/document/path/91770"
  }
];
var KEYWORD_ALT = String.raw`(?:api[ _-]?key|access[ _-]?key(?:[ _-]?(?:id|secret))?|secret[ _-]?access[ _-]?key|secret[ _-]?key|private[ _-]?key|public[ _-]?key|client[ _-]?(?:secret|id)|app[ _-]?(?:key|secret)|appid|appsecret|consumer[ _-]?(?:key|secret)|license[ _-]?key|signing[ _-]?key|encryption[ _-]?key|master[ _-]?key|api[ _-]?secret|access[ _-]?token|refresh[ _-]?token|id[ _-]?token|session[ _-]?token|auth[ _-]?token|apikey|key|bearer|passphrase|password|passwd|passw|pwd|creds|credential|secret|token|auth|webhook|dsn|salt|ak|sk|密码|密钥|秘钥|口令|令牌|凭证|凭据|私钥|公钥|通行码|授权码|访问密钥|访问令牌|签名密钥|加密密钥|パスワード|トークン|秘密鍵|비밀번호|토큰|пароль|токен)`;
var VALUE_BODY = String.raw`((?:[A-Za-z0-9](?:[^\s"'\u0060;,(){}<>[\]\\，。、；：！？“”‘’（）「」『』【】]|\\(?![nrt])){7,299}))`;
var VALUE_TAIL = String.raw`(?!(?!\\[nrt])[^\s"'\u0060;,(){}<>[\]，。、；：！？“”‘’（）「」『』【】])`;
var STRONG_SEP = String.raw`(?:(?:(?:[ \t]{0,5}(?::=|=>|->|→|[=:：]{1,3})|[ \t]{0,5}(?:是|为|就是|如下|分别为|即|等于|\bis\b|\bare\b|\bwas\b|\bwere\b|\bequals?\b|\bnamed\b|\bcalled\b)[ \t]{0,5}(?::=|=>|[=:：])?|[ \t]{0,4}[|,;，。、]|\s*\n\s*)[ \t]{0,3}["'\u0060“”‘’「」『』【】]?[ \t]{0,3})|(?:[ \t]{0,2}["'\u0060“”‘’「」『』【】][ \t]{0,3}))`;
var WEAK_SEP = String.raw`[ \t]{1,5}["'\u0060“”‘’「」『』【】]?[ \t]{0,4}`;
function keywordBoundary(text, at) {
  if (at === 0) return true;
  const prev = text.charAt(at - 1);
  if (prev === ":") return false;
  if (!/[A-Za-z0-9]/.test(prev)) return true;
  if (!/[A-Za-z]/.test(prev)) return false;
  const head = /([A-Za-z][A-Za-z0-9]*)$/.exec(text.slice(Math.max(0, at - 24), at))?.[1] ?? "";
  return /^(?:api|db|client|app|access|secret|private|public|auth|session|refresh|id|user|admin|master|license|signing|encryption|consumer|service|server|account|proxy)$/i.test(head);
}
function contextValue(v) {
  if (/[\u3040-\u30ff\uac00-\ud7af\u4e00-\u9fff]/.test(v)) return false;
  if (/^\d{1,4}[月日年]/.test(v)) return false;
  return credentialShape(v) || assignedSecret(v);
}
function strongValue(v) {
  if (/[\u3040-\u30ff\uac00-\ud7af\u4e00-\u9fff]/.test(v)) return false;
  if (/^\d{1,4}[月日年]/.test(v)) return false;
  return bareSecret(v) || assignedSecret(v) || credentialShape(v);
}
var CONTEXT_RULES = [
  {
    id: "keyword-value",
    label: "SECRET",
    kind: "secret",
    pattern: new RegExp(`${KEYWORD_ALT}${STRONG_SEP}${VALUE_BODY}${VALUE_TAIL}`, "gi"),
    group: 1,
    verify: strongValue,
    before: keywordBoundary,
    source: GITLEAKS
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
    source: GITLEAKS
  }
];
var URL_PARAM_RULE = {
  id: "url-param",
  label: "SECRET",
  kind: "secret",
  pattern: /[?&](?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|session[_-]?token|id[_-]?token|token|key|secret|password|passwd|pwd|sig|signature|client[_-]?secret|code)=([^&\s"'<>#]{8,300})/gi,
  group: 1,
  verify: (v) => plausibleSecret(v) && entropy(v) >= 2.6 && !placeholderShaped(v),
  source: GITLEAKS
};
var VALUE_ONLY_RE = /(?<=^|[\s"'`(\[{<>,;:：，。、=])([A-Za-z0-9][A-Za-z0-9_\-+.\/~]{15,117}(?:={1,2})?)(?=$|[\s"'`)\]}>;,：，。、])/gm;
var NOT_CREDENTIAL = /^(?:sha(?:1|224|256|384|512)?[-_]|md5[-_]|integrity|etag|data:|blob:|file:|https?:|git\+|npm:|docker:|oci:|sha256~|iVBORw0KGgo|R0lGOD|JVBERi|UEsDB|\/9j\/|v?\d+(?:\.\d+){2})/;
function credentialShape(v) {
  if (v.length < 16 || v.length > 120) return false;
  if (!/[A-Za-z]/.test(v) || !/\d/.test(v)) return false;
  if (!plausibleSecret(v) || placeholderShaped(v)) return false;
  if (NOT_CREDENTIAL.test(v)) return false;
  if (/^[0-9a-f]+$/i.test(v)) return false;
  if (/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v)) return false;
  if (entropy(v) < 3.1) return false;
  const classes = (/[a-z]/.test(v) ? 1 : 0) + (/[A-Z]/.test(v) ? 1 : 0) + (/\d/.test(v) ? 1 : 0);
  if (classes < 2) return false;
  if (/^[A-Za-z0-9]+(?:\.[A-Za-z0-9]+){2,}$/.test(v)) return false;
  const segments = v.split(/[-_.]+/).filter(Boolean);
  const longSegment = segments.some((s) => s.length >= 16 && /[A-Za-z]/.test(s) && /\d/.test(s));
  if (classes === 3) return true;
  return longSegment && entropy(v) >= 3.2;
}
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
  ...VENDOR_SPECS.map(vendorRule),
  ...WEBHOOK_RULES,
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
    pattern: /(?:api[ _-]?key|secret(?:[ _-]?key)?|token|password|passwd|pwd|auth|credential|密码|密钥|秘钥|口令|令牌|授权码|授权密钥|访问令牌|访问密钥|凭证|凭据|私钥)s?["'`]?(?:[ \t]{0,5}(?::=|=>|[=:]|：)|(?:[ \t]+is\b|[ \t]{0,3}是)[ \t]{0,5}(?::=|=>|[=:]|：)?)[ \t]{0,5}["'`]([^\s"'`]{8,256})["'`]/gi,
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
    pattern: /(?:api[ _-]?key|secret(?:[ _-]?key)?|token|password|passwd|pwd|passphrase|auth|credential|新密码|新口令|新的密码|密码|密钥|秘钥|口令|令牌|授权码|授权密钥|访问令牌|访问密钥|凭证|凭据|私钥)s?["'`]?(?:[ \t]+to\b|[ \t]{0,5}(?:改为|改到|改成|修改为|设置为|设置成|设为|设成|置为|配置为|配置成|换成|换为|变为|变成|重置为|重设为|更改为|更新为))[ \t:：]{0,5}["'`]?((?:[^\s"'`;,(){}<>[\]\\，。、；：！？“”‘’（）]|\\(?![nrt])){8,256})(?!(?!\\[nrt])[^\s"'`;,(){}<>[\]，。、；：！？“”‘’（）])/gi,
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
    pattern: /(?:api[ _-]?key|secret(?:[ _-]?key)?|token|password|passwd|pwd|auth|credential|密码|密钥|秘钥|口令|令牌|授权码|授权密钥|访问令牌|访问密钥|凭证|凭据|私钥)s?["'`]?(?:[ \t]{0,5}(?::=|=>|[=:]|：)|(?:[ \t]+is\b|[ \t]{0,3}是)[ \t]{0,5}(?::=|=>|[=:]|：)?)[ \t]{0,5}((?:[^\s"'`;,(){}<>[\]\\，。、；：！？“”‘’（）]|\\(?![nrt])){8,256})(?!(?!\\[nrt])[^\s"'`;,(){}<>[\]，。、；：！？“”‘’（）])/gi,
    group: 1,
    verify: bareSecret,
    before: keywordStart,
    source: GITLEAKS
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
    verify: (v) => !/[\u3040-\u30ff\uac00-\ud7af\u4e00-\u9fff]/.test(v) && !/^\d{1,4}[月日年]/.test(v) && (bareSecret(v) || assignedSecret(v)),
    before: keywordStart,
    source: GITLEAKS
  },
  // Broad context grammar + URL parameters (see Layer 2 above).
  ...CONTEXT_RULES,
  URL_PARAM_RULE
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
  "ark-token",
  "sk-generic",
  "openrouter-key",
  "github-fine-grained",
  "gitlab-token",
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
  if (!opts.off?.has("value-only")) {
    const nonEmptyLines = masked.split("\n").filter((line) => line.trim()).length;
    const trimmedLength = masked.trim().length;
    if (nonEmptyLines <= 2 && trimmedLength <= 200) {
      VALUE_ONLY_RE.lastIndex = 0;
      for (let m = VALUE_ONLY_RE.exec(masked); m !== null; m = VALUE_ONLY_RE.exec(masked)) {
        const value = m[1];
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
          order: RULES.length
        });
      }
    }
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
function relaxedValue(v) {
  if (v.length < 6) return false;
  if (!plausibleSecret(v) || placeholderShaped(v)) return false;
  if (NOT_CREDENTIAL.test(v)) return false;
  if (/[|#]/.test(v)) return false;
  if (!/\d/.test(v) && /^[a-z][a-z_-]*$/.test(v)) return false;
  return true;
}
var VALUE_BODY_MIN6 = VALUE_BODY.replace("{7,299}", "{5,299}");
var RELAXED_CONTEXT_RULES = [
  {
    id: "candidate-keyword",
    label: "SECRET",
    kind: "secret",
    pattern: new RegExp(`${KEYWORD_ALT}${STRONG_SEP}${VALUE_BODY_MIN6}${VALUE_TAIL}`, "gi"),
    group: 1,
    verify: relaxedValue,
    before: keywordBoundary,
    source: GITLEAKS
  },
  {
    id: "candidate-keyword-bare",
    label: "SECRET",
    kind: "secret",
    pattern: new RegExp(`${KEYWORD_ALT}${WEAK_SEP}${VALUE_BODY_MIN6}${VALUE_TAIL}`, "gi"),
    group: 1,
    verify: relaxedValue,
    before: keywordBoundary,
    source: GITLEAKS
  }
];
var CANDIDATE_TOKEN_RE = /(?<=^|[\s"'`(\[{<>,;:：，。、=])([A-Za-z0-9][A-Za-z0-9_\-+.\/~]{11,199}(?:={1,2})?)(?=$|[\s"'`)\]}>;,：，。、])/gm;
function candidateShaped(v) {
  if (v.length < 12 || v.length > 200) return false;
  if (!/[A-Za-z]/.test(v) || !/\d/.test(v)) return false;
  if (!plausibleSecret(v) || placeholderShaped(v)) return false;
  if (NOT_CREDENTIAL.test(v)) return false;
  if (entropy(v) < 2.6) return false;
  if (v.includes("=") && !/={1,2}$/.test(v)) return false;
  if (/[|#]/.test(v)) return false;
  if (/^(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})$/i.test(v)) return false;
  if (/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v)) return false;
  if (/[-_.]/.test(v)) {
    const segs = v.split(/[-_.]+/).filter(Boolean);
    if (!segs.some((seg) => seg.length >= 12 && /[A-Za-z]/.test(seg) && /\d/.test(seg))) return false;
  }
  return true;
}
function scanCandidates(text, opts = {}) {
  const high = scan(text).map((h) => ({ ...h, confidence: "high" }));
  if (!opts.strict) return high;
  const spans = [];
  PLACEHOLDER_RE.lastIndex = 0;
  let masked = text;
  for (let m = PLACEHOLDER_RE.exec(text); m !== null; m = PLACEHOLDER_RE.exec(text)) {
    spans.push([m.index, m.index + m[0].length]);
  }
  if (spans.length > 0) {
    let out2 = "";
    let at = 0;
    for (const [s, e] of spans) {
      out2 += text.slice(at, s) + " ".repeat(e - s);
      at = e;
    }
    masked = out2 + text.slice(at);
  }
  const found = high.map((h, order) => ({ ...h, order }));
  const inPlaceholder = (start, end) => spans.some(([s, e]) => start < e && end > s);
  const covered = (start, end) => inPlaceholder(start, end) || found.some((h) => start < h.end && end > h.start);
  const collect = (rules, orderBase) => {
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
        const start = indexed ? m.indices?.[g]?.[0] ?? -1 : m.index + m[0].lastIndexOf(raw);
        if (start < 0) continue;
        const end = start + raw.length;
        const value = text.slice(start, end);
        if (covered(start, end) || insideTemplate(masked, start) || rule.before && !rule.before(masked, m.index) || rule.verify && !rule.verify(value)) {
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
  const chatSized = masked.split("\n").filter((line) => line.trim()).length <= 20 && masked.trim().length <= 4e3;
  CANDIDATE_TOKEN_RE.lastIndex = 0;
  for (let m = chatSized ? CANDIDATE_TOKEN_RE.exec(masked) : null; m !== null; m = CANDIDATE_TOKEN_RE.exec(masked)) {
    const value = m[1];
    const start = m.index + m[0].indexOf(value);
    const end = start + value.length;
    if (covered(start, end) || !candidateShaped(value)) continue;
    found.push({ id: "candidate-token", label: "SECRET", kind: "secret", start, end, value, confidence: "medium", order: tokenOrder });
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end || a.order - b.order);
  const out = [];
  let lastEnd = -1;
  for (const h of found) {
    if (h.start < lastEnd) continue;
    const { order: _order, ...hit } = h;
    out.push(hit);
    lastEnd = h.end;
  }
  return out.slice(0, CANDIDATE_LIMIT);
}
var CANDIDATE_LIMIT = 40;
function previewValue(value) {
  if (value.length <= 10) return "*".repeat(value.length);
  return `${value.slice(0, 6)}\u2026${value.slice(-4)}`;
}
var encoder = new TextEncoder();
var MIN_REDACT_LENGTH = 6;
var EXTRACT_MAX_BYTES = 256 * 1024;
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
function assessPasswordStrength(value) {
  const v = value.trim();
  const lower = v.toLowerCase();
  const reasons = [];
  if (WEAK_PASSWORDS.has(lower)) reasons.push("dictionary");
  if (v.length < 8) reasons.push("short");
  if (/^\d+$/.test(v) && v.length < 12) reasons.push("digits-only");
  if (/^[a-z]+$/.test(v) && v.length < 12) reasons.push("lowercase-only");
  if (v.length >= 8 && !WEAK_PASSWORDS.has(lower) && entropy(v) < 2.5) reasons.push("low-entropy");
  if (/^(.)\1+$/.test(v) || /(0123|1234|2345|3456|4567|5678|6789|abcd|bcde|qwer|asdf|zxcv|password|admin)/i.test(v)) reasons.push("sequence");
  return { weak: reasons.length > 0, reasons };
}
function describePasswordWeakness(strength) {
  const labels = {
    dictionary: "common weak password",
    short: "shorter than 8 characters",
    "digits-only": "digits only",
    "lowercase-only": "lowercase letters only",
    "low-entropy": "low entropy",
    sequence: "sequential pattern"
  };
  return strength.reasons.map((r) => labels[r]).join(", ");
}

// src/keychain.ts
import { spawn, spawnSync } from "node:child_process";
import { chmodSync as chmodSync2, existsSync, mkdirSync as mkdirSync2, rmSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname as dirname2, join } from "node:path";
var KEYCHAIN_SERVICE = "aiti-secret-vault";
var KEYCHAIN_ACCOUNT = "master-key";
var DEFAULT_TIMEOUT_MS = 1e4;
function findInPath(name) {
  const path = process.env.PATH ?? "";
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      if (existsSync(join(dir, name + ext))) return true;
      if (existsSync(join(dir, name.toLowerCase() + ext.toLowerCase()))) return true;
    }
  }
  return false;
}
function detectKeychainBackend() {
  if (process.platform === "darwin") return "macos-security";
  if (process.platform === "win32") return findInPath("powershell") || findInPath("pwsh") ? "windows-dpapi" : "unavailable";
  if (process.platform === "linux" && findInPath("secret-tool")) return "linux-secret-tool";
  return "unavailable";
}
function windowsKeyFile(opts) {
  if (opts.file) return opts.file;
  const base = process.env.LOCALAPPDATA || process.env.APPDATA || join(homedir(), ".aiti");
  return join(base, "aiti-secret-vault", "master.key.dpapi");
}
function windowsPowerShell() {
  return findInPath("pwsh") ? "pwsh" : "powershell";
}
function runSync(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    encoding: "utf8",
    input: opts.input,
    env: opts.env ?? process.env,
    windowsHide: true
  });
  const notFound = res.status === 44 || // macOS security: item not found
  res.status === 1 && /not found|no such|not set/i.test(String(res.stderr ?? "")) || res.status === 2 && /not found|no such/i.test(String(res.stderr ?? ""));
  return { ok: res.status === 0 && !res.error, stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? res.error ?? ""), notFound };
}
var DARWIN_READ = ["find-generic-password", "-s"];
var DARWIN_ADD = ["add-generic-password", "-U", "-s"];
var DARWIN_DELETE = ["delete-generic-password", "-s"];
function createKeychain(opts = {}) {
  const backend = opts.backend ?? detectKeychainBackend();
  const service = opts.service ?? KEYCHAIN_SERVICE;
  const account = opts.account ?? KEYCHAIN_ACCOUNT;
  const available = () => backend !== "unavailable";
  return {
    backend,
    available,
    get() {
      if (backend === "macos-security") {
        const r = runSync("security", [...DARWIN_READ, service, "-a", account, "-w"], opts);
        if (!r.ok) return void 0;
        return r.stdout.trim() || void 0;
      }
      if (backend === "linux-secret-tool") {
        const r = runSync("secret-tool", ["lookup", "service", service, "account", account], opts);
        return r.ok && r.stdout.trim() ? r.stdout.trim() : void 0;
      }
      if (backend === "windows-dpapi") {
        const file = windowsKeyFile(opts);
        if (!existsSync(file)) return void 0;
        const script = "$ErrorActionPreference='Stop';$sec = Get-Content -Raw -LiteralPath $env:AITI_VAULT_KEY_FILE | ConvertTo-SecureString;$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec);[Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)";
        const r = runSync(windowsPowerShell(), ["-NoProfile", "-NonInteractive", "-Command", script], {
          ...opts,
          env: { ...process.env, AITI_VAULT_KEY_FILE: file }
        });
        return r.ok && r.stdout.trim() ? r.stdout.trim() : void 0;
      }
      return void 0;
    },
    set(value) {
      if (backend === "macos-security") {
        const r = runSync("security", [...DARWIN_ADD, service, "-a", account, "-w", value], opts);
        if (!r.ok) throw new Error(`keychain: security add-generic-password failed: ${r.stderr.trim() || "unknown error"}`);
        return;
      }
      if (backend === "linux-secret-tool") {
        const r = runSync("secret-tool", ["store", "--label", `${service}:${account}`, "service", service, "account", account], { ...opts, input: value });
        if (!r.ok) throw new Error(`keychain: secret-tool store failed: ${r.stderr.trim() || "unknown error"}`);
        return;
      }
      if (backend === "windows-dpapi") {
        const file = windowsKeyFile(opts);
        mkdirSync2(dirname2(file), { recursive: true });
        const script = "$ErrorActionPreference='Stop';$sec = ConvertTo-SecureString $env:AITI_VAULT_KEY -AsPlainText -Force;ConvertFrom-SecureString $sec | Set-Content -NoNewline -LiteralPath $env:AITI_VAULT_KEY_FILE";
        const r = runSync(windowsPowerShell(), ["-NoProfile", "-NonInteractive", "-Command", script], {
          ...opts,
          env: { ...process.env, AITI_VAULT_KEY: value, AITI_VAULT_KEY_FILE: file }
        });
        if (!r.ok) throw new Error(`keychain: DPAPI write failed: ${r.stderr.trim() || "unknown error"}`);
        try {
          chmodSync2(file, 384);
        } catch {
        }
        return;
      }
      throw new Error("keychain: no OS keychain backend available on this platform");
    },
    delete() {
      if (backend === "macos-security") {
        runSync("security", [...DARWIN_DELETE, service, "-a", account], opts);
        return;
      }
      if (backend === "linux-secret-tool") {
        runSync("secret-tool", ["clear", "service", service, "account", account], opts);
        return;
      }
      if (backend === "windows-dpapi") {
        try {
          unlinkSync(windowsKeyFile(opts));
        } catch {
          rmSync(windowsKeyFile(opts), { force: true });
        }
        return;
      }
      throw new Error("keychain: no OS keychain backend available on this platform");
    }
  };
}

// src/store.ts
var DEFAULT_VAULT_DIR = join2(homedir2(), ".pi", "agent", "secret-vault");
var MASTER_KEY_FILE = "master.key";
var MODE_FILE = "config.json";
var GLOBAL_FILE = "global.json";
var CHECK_PLAINTEXT = "aiti-secret-vault:check:v1";
var ALIAS_RE = /^[A-Za-z0-9_.-]{1,64}$/;
var VaultError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "VaultError";
  }
};
function readVaultFile(path) {
  if (!existsSync2(path)) return void 0;
  const raw = JSON.parse(readFileSync3(path, "utf8"));
  if (!raw || raw.version !== 1 || typeof raw.entries !== "object" || !raw.check) {
    throw new VaultError("malformed", `vault: ${path} is not a v1 vault file`);
  }
  return raw;
}
var VaultStore = class {
  constructor(opts = {}) {
    this.dir = opts.dir ?? DEFAULT_VAULT_DIR;
    this.cwd = opts.cwd ?? process.cwd();
    this.keyPath = opts.keyPath ?? join2(this.dir, MASTER_KEY_FILE);
    this.modePath = opts.modePath ?? join2(this.dir, MODE_FILE);
    this.keychain = opts.keychain ?? createKeychain();
  }
  /** Current unlock mode (persisted in config.json; default keyfile). */
  get mode() {
    try {
      const doc = JSON.parse(readFileSync3(this.modePath, "utf8"));
      return doc?.mode === "keychain" ? "keychain" : "keyfile";
    } catch {
      return "keyfile";
    }
  }
  setMode(mode) {
    writeFileAtomic(this.modePath, JSON.stringify({ version: 1, mode }, null, 2) + "\n");
  }
  /** Read the master key from the active backend (base64 in the OS keychain). */
  readStoredKey() {
    if (this.mode === "keychain") {
      const b64 = this.keychain.get();
      if (!b64) return void 0;
      const key = Buffer.from(b64, "base64");
      if (key.length !== 32) throw new VaultError("bad-key", "vault: the OS keychain entry has an invalid key length");
      return key;
    }
    return readKeyFile(this.keyPath);
  }
  /** Session cwd changed (pi session_start may enter another project). */
  updateCwd(cwd) {
    this.cwd = cwd;
  }
  get globalPath() {
    return join2(this.dir, GLOBAL_FILE);
  }
  get projectPath() {
    return join2(this.dir, `vault.${fnv1a(this.cwd)}.json`);
  }
  scopePath(scope) {
    return scope === "global" ? this.globalPath : this.projectPath;
  }
  /** True when a keyfile exists (unlock possible without creating one). */
  get initialized() {
    return existsSync2(this.keyPath);
  }
  get locked() {
    return this.key === void 0;
  }
  /**
   * Load the key (or create it when `create` is set). Fail-closed: an
   * existing keyfile that cannot decrypt a vault check envelope is an error.
   */
  keyFor(create) {
    if (this.key) return this.key;
    let key = this.readStoredKey();
    let created = false;
    if (!key) {
      if (!create) {
        throw new VaultError(
          "locked",
          `vault is not initialized: run /vault add <alias> (creates the vault and its ${this.mode} key) or restore a backup of ~/.pi/agent/secret-vault`
        );
      }
      if (existsSync2(this.projectPath) || existsSync2(this.globalPath)) {
        throw new VaultError(
          "missing-key",
          `vault: the ${this.mode} master key is missing but vault data exists \u2014 restore it (or delete the vault files to start over)`
        );
      }
      if (this.mode === "keychain") {
        if (!this.keychain.available()) {
          throw new VaultError("no-keychain", "vault: keychain mode is configured but no OS keychain backend is available on this machine \u2014 run /vault mode keyfile");
        }
        key = generateKey();
        this.keychain.set(key.toString("base64"));
      } else {
        key = createKeyFile(this.keyPath);
      }
      created = true;
    }
    if (!created) this.verifyKey(key);
    this.key = key;
    return key;
  }
  /**
   * Switch unlock mode, re-encrypting every vault file with a fresh key.
   * All files are decrypted and re-encrypted in memory first, then written;
   * the new key is stored last (keyfile promotion / keychain write).
   */
  rekeyTo(mode) {
    const files = [this.projectPath, this.globalPath].filter((p) => existsSync2(p));
    if (mode === "keychain" && !this.keychain.available()) {
      throw new VaultError("no-keychain", "vault: no OS keychain backend is available on this machine (macOS security / Linux secret-tool / Windows DPAPI)");
    }
    if (files.length === 0) {
      this.setMode(mode);
      this.key = void 0;
      return { ok: true, files: 0 };
    }
    const previousMode = this.mode;
    const oldKey = this.keyFor(false);
    const newKey = generateKey();
    const planned = files.map((path) => {
      const file = readVaultFile(path);
      const entries = {};
      for (const [alias, rec] of Object.entries(file.entries)) {
        entries[alias] = { ...rec, enc: encryptValue(newKey, decryptValue(oldKey, rec.enc)) };
      }
      const next = { version: 1, kdf: null, check: encryptValue(newKey, CHECK_PLAINTEXT), entries };
      return { path, next };
    });
    const pendingKeyfile = `${this.keyPath}.new`;
    if (mode === "keychain") {
      this.keychain.set(newKey.toString("base64"));
    } else {
      writeFileAtomic(pendingKeyfile, newKey, 384);
    }
    for (const { path, next } of planned) {
      writeFileAtomic(path, JSON.stringify(next, null, 2) + "\n");
    }
    if (mode === "keyfile") {
      renameSync2(pendingKeyfile, this.keyPath);
      try {
        chmodSync3(this.keyPath, 384);
      } catch {
      }
    } else {
      try {
        rmSync2(this.keyPath, { force: true });
      } catch {
      }
    }
    if (mode === "keyfile" && previousMode === "keychain") {
      try {
        this.keychain.delete();
      } catch {
      }
    }
    if (previousMode !== mode) this.setMode(mode);
    this.key = newKey;
    return { ok: true, files: files.length };
  }
  /** Explicit unlock (commands/UI). Never creates the vault. */
  unlock() {
    try {
      this.keyFor(false);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  lock() {
    this.key = void 0;
  }
  verifyKey(key) {
    for (const path of [this.projectPath, this.globalPath]) {
      const file = readVaultFile(path);
      if (!file) continue;
      try {
        const check = decryptValue(key, file.check);
        if (check !== CHECK_PLAINTEXT) throw new Error("check mismatch");
      } catch {
        throw new VaultError("bad-key", `vault: the keyfile ${this.keyPath} does not unlock ${path}`);
      }
      return;
    }
  }
  load(scope) {
    return readVaultFile(this.scopePath(scope));
  }
  save(file, scope) {
    writeFileAtomic(this.scopePath(scope), JSON.stringify(file, null, 2) + "\n");
  }
  emptyFile(key) {
    return { version: 1, kdf: null, check: encryptValue(key, CHECK_PLAINTEXT), entries: {} };
  }
  /** All aliases, project entries shadowing global ones. */
  list(opts = {}) {
    const out = /* @__PURE__ */ new Map();
    const scopes = opts.scope ? [opts.scope] : ["global", "project"];
    for (const scope of scopes) {
      const file = this.load(scope);
      if (!file) continue;
      for (const [alias, rec] of Object.entries(file.entries)) {
        out.set(alias, {
          alias,
          scope,
          desc: rec.desc,
          tags: rec.tags,
          version: rec.version,
          createdAt: rec.createdAt,
          updatedAt: rec.updatedAt,
          lastUsedAt: rec.lastUsedAt,
          lastUsedSession: rec.lastUsedSession
        });
      }
    }
    return [...out.values()].sort((a, b) => a.alias.localeCompare(b.alias));
  }
  find(alias) {
    return this.list().find((e) => e.alias === alias);
  }
  /** Decrypt one alias (project bucket first). Throws VaultError when absent/locked. */
  get(alias, opts = {}) {
    for (const scope of ["project", "global"]) {
      const file = this.load(scope);
      const rec = file?.entries?.[alias];
      if (!file || !rec) continue;
      const key = this.keyFor(false);
      let value;
      try {
        value = decryptValue(key, rec.enc);
      } catch {
        throw new VaultError("bad-key", `vault: could not decrypt "${alias}" (key mismatch or corrupted entry)`);
      }
      if (opts.touch) {
        rec.lastUsedAt = (/* @__PURE__ */ new Date()).toISOString();
        if (opts.sessionId) rec.lastUsedSession = opts.sessionId;
        this.save(file, scope);
      }
      return {
        alias,
        scope,
        value,
        info: {
          alias,
          scope,
          desc: rec.desc,
          tags: rec.tags,
          version: rec.version,
          createdAt: rec.createdAt,
          updatedAt: rec.updatedAt,
          lastUsedAt: rec.lastUsedAt,
          lastUsedSession: rec.lastUsedSession
        }
      };
    }
    if (!this.initialized) {
      throw new VaultError(
        "not-initialized",
        "vault is not initialized: ask the user to run /vault add <alias> (creates the vault and its keyfile)"
      );
    }
    throw new VaultError("not-found", `vault: no entry named "${alias}" (/vault list for aliases)`);
  }
  /**
   * Add or rotate an alias. First write auto-creates the vault + keyfile.
   * Rotation keeps createdAt and increments `version` (attributable history).
   */
  add(alias, value, opts = {}) {
    if (!ALIAS_RE.test(alias)) throw new VaultError("bad-alias", "vault: alias must be 1-64 chars of [A-Za-z0-9_.-]");
    const trimmed = value.trim();
    if (trimmed.length < MIN_REDACT_LENGTH) {
      throw new VaultError("too-short", `vault: value must be at least ${MIN_REDACT_LENGTH} characters (shorter values cannot be masked safely)`);
    }
    const strength = assessPasswordStrength(trimmed);
    const key = this.keyFor(true);
    const scope = opts.project ? "project" : "global";
    const file = this.load(scope) ?? this.emptyFile(key);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const previous = file.entries[alias];
    file.entries[alias] = {
      desc: opts.desc ?? previous?.desc,
      tags: opts.tags ?? previous?.tags,
      version: previous ? previous.version + 1 : 1,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      enc: encryptValue(key, trimmed)
    };
    this.save(file, scope);
    const shadowed = scope === "global" && Boolean(this.load("project")?.entries?.[alias]);
    return { alias, scope, version: file.entries[alias].version, created: !previous, shadowed, weak: strength.weak, weakReasons: strength.reasons };
  }
  /** Remove an alias from both buckets. Returns how many records were deleted. */
  remove(alias) {
    let removed = 0;
    for (const scope of ["project", "global"]) {
      const file = this.load(scope);
      if (!file?.entries?.[alias]) continue;
      delete file.entries[alias];
      this.save(file, scope);
      removed++;
    }
    return removed;
  }
  status() {
    const globalFile = this.load("global");
    const projectFile = this.load("project");
    return {
      dir: this.dir,
      mode: this.mode,
      keychainBackend: this.keychain.backend,
      initialized: this.initialized,
      locked: this.locked,
      keyfile: this.keyPath,
      globalEntries: globalFile ? Object.keys(globalFile.entries).length : 0,
      projectEntries: projectFile ? Object.keys(projectFile.entries).length : 0,
      scopes: { global: this.globalPath, project: this.projectPath }
    };
  }
};

// src/entries.ts
import { spawn as spawn2 } from "node:child_process";
import { readFileSync as readFileSync4 } from "node:fs";
var CAPTURE_DEFAULT_TIMEOUT_MS = 1e4;
var CAPTURE_DEFAULT_MAX_BYTES = 4096;
var CAPTURE_DEFAULT_MAX_VALUE = 4096;
function killTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    try {
      spawn2("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).unref();
    } catch {
      try {
        child.kill();
      } catch {
      }
    }
    return;
  }
  try {
    child.kill("SIGKILL");
  } catch {
  }
}
function captureStdout(command, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? CAPTURE_DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? CAPTURE_DEFAULT_MAX_BYTES;
  return new Promise((resolve, reject) => {
    const child = spawn2(command, { shell: true, cwd: opts.cwd ?? process.cwd(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(out.trim());
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish(new VaultError("timeout", `vault: capture timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on("data", (buf) => {
      out += buf.toString("utf8");
      if (Buffer.byteLength(out) > maxBytes) {
        killTree(child);
        finish(new VaultError("too-large", `vault: captured output exceeds ${maxBytes} bytes (refusing to store)`));
      }
    });
    child.stderr?.on("data", (buf) => {
      err = (err + buf.toString("utf8")).slice(-2e3);
    });
    child.on("error", (e) => finish(e));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(new VaultError("capture-failed", `vault: command exited with ${code}${err.trim() ? `: ${err.trim().split("\n")[0]}` : ""}`));
        return;
      }
      finish();
    });
  });
}
async function captureIntoVault(store, alias, command, opts = {}) {
  const value = await captureStdout(command, opts);
  if (value.length > CAPTURE_DEFAULT_MAX_VALUE) {
    throw new VaultError("too-large", `vault: captured value exceeds ${CAPTURE_DEFAULT_MAX_VALUE} bytes (refusing to store)`);
  }
  return store.add(alias, value, { project: opts.project, desc: opts.desc, tags: opts.tags });
}
function parseEnvFile(text) {
  const out = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    if (!value) continue;
    out.push({ key: m[1], value });
  }
  return out;
}
var ENV_NAME_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|DSN)/i;
function aliasFromEnvName(name) {
  return name.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "env-value";
}
function importPairs(store, pairs, opts = {}) {
  const result = { added: 0, rotated: 0, skipped: 0, aliases: [], weak: [] };
  for (const pair of pairs) {
    const alias = aliasFromEnvName(pair.key);
    if (valueExists(store, pair.value)) {
      result.skipped++;
      continue;
    }
    try {
      const res = store.add(alias, pair.value, { project: opts.project, tags: ["imported"] });
      if (res.created) result.added++;
      else result.rotated++;
      result.aliases.push(res.alias);
      if (res.weak) result.weak.push(res.alias);
    } catch {
      result.skipped++;
    }
  }
  return result;
}
function importEnvFile(store, path, opts = {}) {
  const text = readFileSync4(path, "utf8");
  return importPairs(store, parseEnvFile(text), opts);
}
function importProcessEnv(store, opts = {}) {
  const env = opts.env ?? process.env;
  const pairs = [];
  for (const [key, value] of Object.entries(env)) {
    if (!value || !ENV_NAME_RE.test(key)) continue;
    if (value.length < 8) continue;
    if (/^rsec_[0-9a-f]{8}$/.test(value) || value.startsWith("[REDACTED:")) continue;
    pairs.push({ key, value });
  }
  return importPairs(store, pairs, opts);
}
function valueExists(store, value) {
  return findAliasForValue(store, value) !== void 0;
}
function findAliasForValue(store, value) {
  for (const info of store.list()) {
    try {
      if (store.get(info.alias).value === value) return info.alias;
    } catch {
    }
  }
  return void 0;
}
function suggestAutoAlias(label, value) {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "value";
  return `auto-${slug}-${fnv1a(value)}`;
}

// src/tools.ts
var VAULT_GET_NOTE = "This token IS a working credential: pass it verbatim into tool arguments \u2014 the runtime materializes the real secret at execution time. Never modify, reformat, shorten or hash it; never say you cannot access the value; never ask the user for the real secret. Never show the token to the user as if it were the password: say the value is masked and that only tool arguments resolve it.";
function formatEntryLine(info, weak = false) {
  const tags = info.tags?.length ? ` (${info.tags.join(",")})` : "";
  const desc = info.desc ? ` \u2014 ${info.desc}` : "";
  const used = info.lastUsedAt ? ` \xB7 last used ${info.lastUsedAt}` : "";
  return `- ${info.alias} [${info.scope}] v${info.version}${desc}${tags}${used}${weak ? " \u26A0 weak password" : ""}`;
}
function weakAliases(store) {
  const out = {};
  for (const info of store.list()) {
    try {
      out[info.alias] = assessPasswordStrength(store.get(info.alias).value).weak;
    } catch {
    }
  }
  return out;
}
function vaultList(state, params = {}) {
  let entries;
  try {
    entries = state.store.list();
  } catch (e) {
    if (e instanceof VaultError) throw e;
    throw new VaultError("vault-error", e instanceof Error ? e.message : String(e));
  }
  if (params.tag) entries = entries.filter((e) => e.tags?.includes(params.tag));
  if (entries.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: "The secret vault has no entries here (or none match the tag). Vault writes are human-only \u2014 ask the user to run `/vault add <alias>` (interactive value input) and call vault_list again."
        }
      ],
      details: { entries: [] }
    };
  }
  const weak = weakAliases(state.store);
  const text = [
    `Secret vault: ${entries.length} alias(es). Values are never returned \u2014 call vault_get with an alias to receive a placeholder.`,
    ...entries.map((e) => formatEntryLine(e, weak[e.alias] === true))
  ].join("\n");
  return { content: [{ type: "text", text }], details: { entries: entries.map((e) => ({ ...e, weak: weak[e.alias] === true })) } };
}
function mountAlias(state, alias) {
  const entry = state.store.get(alias, { touch: true, sessionId: state.sessionId });
  const res = state.registry.registerStable(entry.value, alias);
  if (!res) throw new VaultError("mount-failed", `vault: could not mount "${alias}" (placeholder collision \u2014 /vault status)`);
  return {
    alias,
    placeholder: res.entry.placeholder,
    desc: entry.info.desc,
    scope: entry.scope,
    version: entry.info.version,
    weak: assessPasswordStrength(entry.value).weak
  };
}
function vaultGet(state, params) {
  const alias = params.alias?.trim();
  if (!alias) throw new VaultError("bad-args", "vault_get requires { alias } \u2014 call vault_list to see aliases");
  const mounted = mountAlias(state, alias);
  return {
    content: [
      {
        type: "text",
        text: [
          mounted.placeholder,
          "",
          VAULT_GET_NOTE,
          `(alias: ${mounted.alias}${mounted.desc ? ` \u2014 ${mounted.desc}` : ""}, v${mounted.version})`,
          ...mounted.weak ? ["Note: this credential is a weak password \u2014 advise the user to rotate it."] : []
        ].join("\n")
      }
    ],
    details: { placeholder: mounted.placeholder, alias: mounted.alias, desc: mounted.desc, version: mounted.version, scope: mounted.scope, weak: mounted.weak }
  };
}

// src/landing.ts
function landValueInVault(state, value, label) {
  try {
    let alias = findAliasForValue(state.store, value);
    let created = false;
    if (!alias) {
      alias = suggestAutoAlias(label, value);
      state.store.add(alias, value, { desc: `auto-captured from prompt (${label})`, tags: ["auto"] });
      created = true;
    }
    const res = state.registry.registerStable(value, alias);
    if (!res) return void 0;
    return { alias, placeholder: res.entry.placeholder, created };
  } catch {
    return void 0;
  }
}

// src/commands.ts
import { existsSync as existsSync3 } from "node:fs";
function parseAddArgs(tail) {
  const tokens = tail.split(/\s+/).filter(Boolean);
  const out = { project: false };
  if (tokens.length === 0) return out;
  out.alias = tokens.shift();
  const desc = [];
  while (tokens.length > 0) {
    const token = tokens.shift();
    if (token === "--project") {
      out.project = true;
      continue;
    }
    if (token === "--tags") {
      const value = tokens.shift();
      if (value) out.tags = value.split(",").map((t) => t.trim()).filter(Boolean);
      continue;
    }
    desc.push(token);
  }
  if (desc.length) out.desc = desc.join(" ");
  return out;
}
function flag(tokens, name) {
  const at = tokens.indexOf(name);
  if (at < 0) return false;
  tokens.splice(at, 1);
  return true;
}
function importSummary(label, res) {
  const weak = res.weak.length ? ` \u26A0 weak password: ${res.weak.join(", ")}` : "";
  return `${label}: ${res.added} added, ${res.rotated} rotated, ${res.skipped} skipped.${weak}`;
}
async function handleVaultCommand(state, rawArgs, io = {}) {
  const args = rawArgs.trim();
  const [cmd, ...rest] = args.length ? args.split(/\s+/) : [""];
  const tail = args.slice(cmd.length).trim();
  const tokens = rest.slice();
  switch (cmd) {
    case "":
    case "help":
      return { ok: true, text: helpText() };
    case "add":
    case "set": {
      const parsed = parseAddArgs(tail);
      if (!parsed.alias) return { ok: false, text: `Usage: /vault ${cmd} <alias> [description] [--project] [--tags a,b]` };
      if (cmd === "set" && !state.store.find(parsed.alias)) {
        return { ok: false, text: `vault: no entry named "${parsed.alias}" \u2014 use /vault add to create it.` };
      }
      if (!io.input) return { ok: false, text: "vault: this host has no masked input surface." };
      const value = await io.input(`Value for "${parsed.alias}" (input is kept out of the chat)`);
      if (!value || !value.trim()) return { ok: false, text: "vault: cancelled." };
      try {
        const res = state.store.add(parsed.alias, value, { desc: parsed.desc, tags: parsed.tags, project: parsed.project });
        return { ok: true, text: describeAdd(res) };
      } catch (e) {
        return { ok: false, text: errorText(e) };
      }
    }
    case "capture": {
      const sep = tail.indexOf(" -- ");
      if (sep < 0) return { ok: false, text: "Usage: /vault capture <alias> [--project] -- <command>" };
      const head = tail.slice(0, sep).trim();
      const command = tail.slice(sep + 4).trim();
      const headTokens = head.split(/\s+/).filter(Boolean);
      const alias = headTokens.shift();
      const project = flag(headTokens, "--project");
      if (!alias || !command) return { ok: false, text: "Usage: /vault capture <alias> [--project] -- <command>" };
      try {
        const cwd = existsSync3(state.cwd) ? state.cwd : process.cwd();
        const res = await captureIntoVault(state.store, alias, command, { project, cwd });
        return { ok: true, text: describeAdd(res) + " (value captured from command output; never echoed)" };
      } catch (e) {
        return { ok: false, text: errorText(e) };
      }
    }
    case "import": {
      const rest2 = tail.split(/\s+/).filter(Boolean);
      const project = flag(rest2, "--project");
      const path = rest2[0];
      if (!path) return { ok: false, text: "Usage: /vault import <file.env> [--project]" };
      try {
        return { ok: true, text: importSummary(`vault import ${path}`, importEnvFile(state.store, path, { project })) };
      } catch (e) {
        return { ok: false, text: errorText(e) };
      }
    }
    case "import-env": {
      const project = flag(tokens, "--project");
      try {
        return { ok: true, text: importSummary("vault import-env", importProcessEnv(state.store, { project })) + " (secret-named variables only)" };
      } catch (e) {
        return { ok: false, text: errorText(e) };
      }
    }
    case "list": {
      const scope = flag(tokens, "--project") ? "project" : flag(tokens, "--global") ? "global" : void 0;
      let entries;
      try {
        entries = state.store.list(scope ? { scope } : {});
      } catch (e) {
        return { ok: false, text: errorText(e) };
      }
      if (entries.length === 0) return { ok: true, text: "vault: no entries (add one with /vault add <alias>)." };
      const lines = entries.map((e) => {
        let weak = false;
        try {
          weak = assessPasswordStrength(state.store.get(e.alias).value).weak;
        } catch {
        }
        return formatEntryLine(e, weak);
      });
      return { ok: true, text: `vault: ${entries.length} entr${entries.length === 1 ? "y" : "ies"}:
${lines.join("\n")}` };
    }
    case "remove": {
      const alias = tokens[0];
      if (!alias) return { ok: false, text: "Usage: /vault remove <alias>" };
      if (!state.store.find(alias)) return { ok: false, text: `vault: no entry named "${alias}".` };
      const confirmed = io.confirm ? await io.confirm(`Delete "${alias}" from the vault? This cannot be undone.`) : await io.input?.(`Type "${alias}" again to confirm deletion`) === alias;
      if (!confirmed) return { ok: false, text: "vault: cancelled." };
      const removed = state.store.remove(alias);
      state.registry.forgetByLabel(alias);
      return { ok: true, text: `vault: removed "${alias}" (${removed} record(s)); mounted placeholder invalidated.` };
    }
    case "reveal": {
      const alias = tokens[0];
      if (!alias) return { ok: false, text: "Usage: /vault reveal <alias>" };
      try {
        const entry = state.store.get(alias);
        if (!io.show && !io.copy) return { ok: false, text: "vault: this host has no dialog/clipboard surface; refusing to print the value into the transcript." };
        io.show?.(`vault: ${alias}`, entry.value);
        io.copy?.(entry.value);
        const strength = assessPasswordStrength(entry.value);
        const weakNote = strength.weak ? ` \u26A0 weak password (${describePasswordWeakness(strength)}); consider rotating it.` : "";
        return {
          ok: true,
          text: `vault: "${alias}" ${io.show ? "shown in a dialog" : ""}${io.show && io.copy ? " and " : ""}${io.copy ? "copied to the clipboard" : ""} \u2014 never printed into the session.${weakNote}`
        };
      } catch (e) {
        return { ok: false, text: errorText(e) };
      }
    }
    case "get": {
      const alias = tokens[0];
      if (!alias) return { ok: false, text: "Usage: /vault get <alias> (mounts the alias; prints only its placeholder)" };
      try {
        const mounted = mountAlias(state, alias);
        const weakNote = mounted.weak ? " \u26A0 weak password \u2014 consider rotating it." : "";
        return { ok: true, text: `vault: mounted "${alias}" as ${mounted.placeholder} (v${mounted.version}, ${mounted.scope}).${weakNote}` };
      } catch (e) {
        return { ok: false, text: errorText(e) };
      }
    }
    case "scope": {
      const st = state.store.status();
      return { ok: true, text: `vault scopes:
- global:  ${st.scopes.global}
- project: ${st.scopes.project}  (${state.cwd})` };
    }
    case "mode": {
      const requested = tokens[0];
      const current = state.store.status();
      if (!requested) {
        const backend = current.keychainBackend === "unavailable" ? "unavailable on this machine" : current.keychainBackend;
        return {
          ok: true,
          text: [
            `vault unlock mode: ${current.mode}`,
            `- keyfile: 32-byte key at ${state.store.keyPath}`,
            `- keychain: OS credential store (backend: ${backend})`,
            "switching modes regenerates the key and re-encrypts every vault file."
          ].join("\n")
        };
      }
      if (requested !== "keyfile" && requested !== "keychain") return { ok: false, text: "Usage: /vault mode [keyfile|keychain]" };
      if (requested === current.mode) return { ok: true, text: `vault: already in ${requested} mode.` };
      const confirmed = io.confirm ? await io.confirm(`Switch the vault to ${requested} mode? The master key is regenerated and every entry re-encrypted.`) : true;
      if (!confirmed) return { ok: false, text: "vault: cancelled." };
      try {
        const res = state.store.rekeyTo(requested);
        return { ok: true, text: `vault: unlock mode \u2192 ${requested} (${res.files} file(s) re-encrypted with a fresh key).` };
      } catch (e) {
        return { ok: false, text: errorText(e) };
      }
    }
    case "lock": {
      state.store.lock();
      return { ok: true, text: "vault: locked (the next read/write needs the keyfile again)." };
    }
    case "unlock": {
      const res = state.store.unlock();
      return res.ok ? { ok: true, text: `vault: unlocked (keyfile ${state.store.keyPath}).` } : { ok: false, text: `vault: unlock failed: ${res.error}` };
    }
    case "forget": {
      const mounted = state.registry.entries().filter((e) => e.source === "vault");
      for (const entry of mounted) state.registry.forgetByLabel(entry.alias ?? entry.label);
      return { ok: true, text: `vault: unmounted ${mounted.length} alias(es); their placeholders are now invalid (guarded).` };
    }
    case "status": {
      const st = state.store.status();
      const mounted = state.registry.entries().filter((e) => e.source === "vault").length;
      return {
        ok: true,
        text: [
          `vault: ${st.initialized ? st.locked ? "locked" : "unlocked" : "not initialized"} (mode: ${st.mode}, keychain: ${st.keychainBackend})`,
          `keyfile: ${st.keyfile}`,
          `entries: ${st.globalEntries} global + ${st.projectEntries} project; mounted in this session: ${mounted}`,
          `dir: ${st.dir}`
        ].join("\n")
      };
    }
    default:
      return { ok: false, text: `vault: unknown subcommand "${cmd}". Try /vault help.` };
  }
}
function describeAdd(res) {
  const scope = res.scope === "project" ? "project" : "global";
  const shadow = res.shadowed ? " (warning: a same-alias project entry shadows this global value)" : "";
  const weak = res.weak ? ` \u26A0 weak password (${res.weakReasons.join(", ")}) \u2014 stored anyway; consider rotating to a stronger one.` : "";
  return `vault: ${res.created ? "added" : "rotated"} "${res.alias}" v${res.version} [${scope}]${shadow}${weak}`;
}
function errorText(e) {
  if (e instanceof VaultError) return e.message;
  return `vault: ${e instanceof Error ? e.message : String(e)}`;
}
function helpText() {
  return [
    "vault commands (values never appear in the transcript):",
    "  /vault add <alias> [desc] [--project] [--tags a,b]   masked input; existing alias = rotate (version+1)",
    "  /vault set <alias>                                  rotate an existing alias",
    "  /vault capture <alias> [--project] -- <command>     stdout into the vault (never echoed)",
    "  /vault import <file.env> [--project]                KEY=value / export KEY=value",
    "  /vault import-env [--project]                       scan this process env (secret-named vars)",
    "  /vault list [--global|--project]                    aliases + metadata (zero values)",
    "  /vault get <alias>                                  mount alias \u2192 placeholder (prints token only)",
    "  /vault reveal <alias>                               dialog + clipboard only, never the transcript",
    "  /vault remove <alias>                               delete (asks for confirmation)",
    "  /vault forget                                       unmount all aliases for this session",
    "  /vault scope | mode | lock | unlock | status"
  ].join("\n");
}

// src/session-state.ts
import { existsSync as existsSync4, readFileSync as readFileSync5 } from "node:fs";
var SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1e3;
var MAX_SESSION_RECORDS = 50;
var EMPTY_SESSION_STATE = { version: 1, sessions: {} };
function readSessionState(path) {
  if (!existsSync4(path)) return { version: 1, sessions: {} };
  try {
    const doc = JSON.parse(readFileSync5(path, "utf8"));
    if (!doc || doc.version !== 1 || typeof doc.sessions !== "object") return { version: 1, sessions: {} };
    return doc;
  } catch {
    return { version: 1, sessions: {} };
  }
}
function prune(file, now = Date.now()) {
  const entries = Object.entries(file.sessions).filter(([, rec]) => {
    if (rec.pid) return true;
    const at = Date.parse(rec.updatedAt);
    return Number.isFinite(at) ? now - at <= SESSION_RETENTION_MS : false;
  }).sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt)).slice(0, MAX_SESSION_RECORDS);
  return { version: 1, sessions: Object.fromEntries(entries) };
}
function writeSessionRecord(path, sessionId, record) {
  const file = readSessionState(path);
  file.sessions[sessionId || "unknown"] = { ...record, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
  writeFileAtomic(path, JSON.stringify(prune(file), null, 2) + "\n");
}

// src/preflight.ts
function candidatesOf(store, text, opts) {
  return scanCandidates(text, { strict: opts.strict ?? true });
}
function valueIndex(store) {
  const index = /* @__PURE__ */ new Map();
  let entries;
  try {
    entries = store.list();
  } catch {
    return index;
  }
  for (const info of entries) {
    try {
      const value = store.get(info.alias).value;
      if (!index.has(value)) index.set(value, info.alias);
    } catch {
    }
  }
  return index;
}
function preflightScan(store, text, opts = {}) {
  let locked = false;
  try {
    store.keyFor(false);
  } catch {
    locked = store.initialized;
  }
  const index = locked ? /* @__PURE__ */ new Map() : valueIndex(store);
  const candidates = candidatesOf(store, text, opts).map((hit, position) => ({
    index: position,
    label: hit.label,
    ruleId: hit.id,
    confidence: hit.confidence,
    preview: previewValue(hit.value),
    stored: index.has(hit.value)
  }));
  return { candidates, locked };
}
function preflightMask(store, text, indices, opts = {}) {
  const hits = candidatesOf(store, text, opts);
  const wanted = [...new Set(indices)].filter((i) => Number.isInteger(i) && i >= 0 && i < hits.length).sort((a, b) => b - a);
  if (wanted.length === 0) return { text, aliases: [] };
  let masked = text;
  const aliases = [];
  const known = valueIndex(store);
  for (const index of wanted) {
    const hit = hits[index];
    let alias = known.get(hit.value);
    if (!alias) {
      alias = suggestAutoAlias(hit.label || hit.id, hit.value);
      const res = store.add(alias, hit.value, { desc: "pre-send preflight", tags: opts.tags ?? ["preflight"] });
      known.set(hit.value, res.alias ?? alias);
    }
    const token = stablePlaceholder(STABLE_NAMESPACE, alias);
    masked = masked.slice(0, hit.start) + token + masked.slice(hit.end);
    if (!aliases.includes(alias)) aliases.push(alias);
  }
  return { text: masked, aliases };
}
export {
  ALIAS_RE,
  CAPTURE_DEFAULT_MAX_BYTES,
  CAPTURE_DEFAULT_MAX_VALUE,
  CAPTURE_DEFAULT_TIMEOUT_MS,
  CHECK_PLAINTEXT,
  DEFAULT_VAULT_DIR,
  EMPTY_SESSION_STATE,
  GLOBAL_FILE,
  KEY_BYTES,
  MASTER_KEY_FILE,
  MAX_SESSION_RECORDS,
  MODE_FILE,
  SESSION_RETENTION_MS,
  VAULT_GET_NOTE,
  VaultError,
  VaultStore,
  aliasFromEnvName,
  captureIntoVault,
  captureStdout,
  createKeyFile,
  decryptValue,
  encryptValue,
  findAliasForValue,
  formatEntryLine,
  generateKey,
  handleVaultCommand,
  importEnvFile,
  importPairs,
  importProcessEnv,
  landValueInVault,
  mountAlias,
  parseEnvFile,
  preflightMask,
  preflightScan,
  readKeyFile,
  readSessionState,
  suggestAutoAlias,
  valueExists,
  vaultGet,
  vaultList,
  weakAliases,
  writeFileAtomic,
  writeSessionRecord
};
