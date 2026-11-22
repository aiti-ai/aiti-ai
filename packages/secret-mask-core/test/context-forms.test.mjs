// Detection must not depend on one hand-written phrasing per case.
//
// Two invariants are asserted here:
//   1. CONTEXT — a credential-shaped value is found for every combination of
//      credential keyword x connector x language we generate, not for a fixed
//      list of sentences.
//   2. SHAPE — a credential-shaped token that dominates its own line is found
//      with no keyword at all (bare paste / unknown provider).
// Anything that is long and random but NOT a credential (git sha, uuid,
// checksum, data-URI base64, semver, path, code identifier) must stay untouched
// in the very same templates, so recall cannot be bought with noise.
//
// All values below are generated fakes, never real credentials.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CANDIDATE_LIMIT, previewValue, scan, scanCandidates } from "../src/detect.ts";

// Deterministic PRNG (mulberry32) so failures reproduce.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGIT = "0123456789";
const B62 = LOWER + UPPER + DIGIT;
const HEX = "0123456789abcdef";

function pick(r, chars, n) {
  let out = "";
  for (let i = 0; i < n; i++) out += chars[Math.floor(r() * chars.length)];
  return out;
}

/** Credential shapes real providers hand out (fakes). */
const TOKEN_SHAPES = [
  (r) => pick(r, B62, 32), // opaque base62
  (r) => pick(r, B62, 40),
  (r) => `${pick(r, LOWER, 8)}-${pick(r, B62, 32)}`, //  provider-<random>
  (r) => `sk-${pick(r, B62, 32)}`, //  OpenAI-compatible vendors
  (r) => `${pick(r, B62, 16)}.${pick(r, B62, 32)}`, //  id.secret pair
  (r) => pick(r, UPPER + DIGIT, 24),
];

/** Long-and-random values that are not credentials. */
const NON_TOKEN_SHAPES = [
  (r) => pick(r, HEX, 40), // git sha
  (r) => `${pick(r, HEX, 8)}-${pick(r, HEX, 4)}-4${pick(r, HEX, 3)}-a${pick(r, HEX, 3)}-${pick(r, HEX, 12)}`, // uuid
  (r) => `sha512-${pick(r, B62, 40)}`, // lockfile integrity
  (r) => `v${1 + Math.floor(r() * 9)}.${Math.floor(r() * 20)}.${Math.floor(r() * 20)}`, // semver
  (r) => `/usr/lib/node_modules/${pick(r, LOWER, 12)}/index.js`, // path
  (r) => pick(r, LOWER, 24), // plain word, no digits
];

/** Keyword vocabularies per language, as users actually type them. */
const KEYWORDS = {
  en: ["api key", "API_KEY", "apikey", "token", "access token", "secret", "client secret", "password", "pwd", "key", "credential"],
  zh: ["密钥", "秘钥", "令牌", "密码", "口令", "凭证", "私钥", "访问密钥", "api 密钥"],
  ja: ["パスワード", "トークン", "秘密鍵"],
  ko: ["비밀번호", "토큰"],
  ru: ["пароль", "токен"],
};

/** Connectors from "an operator" to "just a space", plus line breaks and cells. */
const CONNECTORS = [
  " ", "  ", ": ", ":", "：", "：\n", "\n", " = ", "=", " == ", " => ", " -> ", " is ", " are ",
  " 是 ", "是", " 为 ", "如下：", "就是", "\n\n", " | ", ", ", "; ",
];

const QUOTES = [
  ["", ""],
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
  ["“", "”"],
];

function detected(text, token) {
  return scan(text).some((h) => h.value.includes(token) || token.includes(h.value));
}

test("context invariant: keyword x connector x language always detects", () => {
  const r = rng(0x5eed);
  const misses = [];
  for (const [lang, words] of Object.entries(KEYWORDS)) {
    for (const word of words) {
      for (const conn of CONNECTORS) {
        for (const shape of TOKEN_SHAPES) {
          const token = shape(r);
          // Chinese/Japanese keywords are typically written without spacing;
          // a leading space connector would be unusual but must still work.
          const text = `${word}${conn}${token}`;
          if (!detected(text, token)) misses.push(`${lang}:${JSON.stringify(text)}`);
        }
      }
    }
  }
  assert.deepEqual(misses.slice(0, 12), [], `${misses.length} miss(es)`);
});

test("context invariant: quotes around the value", () => {
  const r = rng(0xbeef);
  const misses = [];
  for (const word of [...KEYWORDS.en, ...KEYWORDS.zh]) {
    for (const [open, close] of QUOTES) {
      for (const shape of TOKEN_SHAPES) {
        const token = shape(r);
        for (const conn of [": ", "=", " ", "：", " is "]) {
          const text = `${word}${conn}${open}${token}${close}`;
          if (!detected(text, token)) misses.push(JSON.stringify(text));
        }
      }
    }
  }
  assert.deepEqual(misses.slice(0, 12), [], `${misses.length} miss(es)`);
});

test("shape invariant: a bare credential on its own line needs no keyword", () => {
  const r = rng(0xc0ffee);
  const misses = [];
  for (let i = 0; i < 60; i++) {
    const shape = TOKEN_SHAPES[i % TOKEN_SHAPES.length];
    const token = shape(r);
    const texts = [
      token,
      `${token}\n`,
      `帮我看看这个能不能用\n${token}`,
      `check this: ${token}`,
      `- ${token}`,
    ];
    for (const text of texts) if (!detected(text, token)) misses.push(JSON.stringify(text));
  }
  assert.deepEqual(misses.slice(0, 8), [], `${misses.length} miss(es)`);
});

test("non-credential shapes stay untouched when nothing names them", () => {
  const r = rng(0xdead1);
  const hits = [];
  for (const shape of NON_TOKEN_SHAPES) {
    for (let i = 0; i < 6; i++) {
      const token = shape(r);
      // no credential keyword in the message: a long random-looking value alone
      // must not be guessed into a secret
      for (const text of [token, `帮我看看 ${token} 这个`, `result: ${token}`]) {
        if (scan(text).length > 0) hits.push(JSON.stringify(text));
      }
    }
  }
  assert.deepEqual(hits.slice(0, 10), [], `${hits.length} false positive(s)`);
});

test("unambiguous non-secrets stay untouched even after a keyword", () => {
  // hex strings and uuids are deliberately NOT in this list: many providers
  // issue 32/40/64-hex or uuid-shaped secrets, so a credential keyword next to
  // one is treated as weak evidence, not as a false positive.
  const r = rng(0xdead2);
  const shapes = [
    (g) => `sha512-${pick(g, B62, 40)}`,
    (g) => `v${1 + Math.floor(g() * 9)}.${Math.floor(g() * 20)}.${Math.floor(g() * 20)}`,
    (g) => `/usr/lib/node_modules/${pick(g, LOWER, 12)}/index.js`,
    (g) => pick(g, LOWER, 24),
  ];
  const hits = [];
  for (const shape of shapes) {
    for (let i = 0; i < 6; i++) {
      const token = shape(r);
      for (const text of [`password: ${token}`, `token ${token}`, `key = ${token}`]) {
        if (scan(text).length > 0) hits.push(JSON.stringify(text));
      }
    }
  }
  assert.deepEqual(hits.slice(0, 10), [], `${hits.length} false positive(s)`);
});

test("vendor prefixes are shape-detected with no keyword at all", () => {
  const r = rng(0xfeed);
  const cases = [
    `ghp_${pick(r, B62, 36)}`,
    `github_pat_${pick(r, B62 + "_", 82)}`,
    `glpat-${pick(r, B62 + "_-", 24)}`,
    `xoxb-${pick(r, DIGIT, 12)}-${pick(r, B62, 24)}`,
    `AKIA${pick(r, UPPER + DIGIT, 16)}`,
    `AIza${pick(r, B62 + "_-", 35)}`,
    `sk-ant-api03-${pick(r, B62 + "_-", 93)}`,
    `npm_${pick(r, B62, 36)}`,
    `hf_${pick(r, LOWER, 34)}`,
    `dckr_pat_${pick(r, B62 + "_-", 27)}`,
    `NRAK-${pick(r, UPPER, 27)}`,
    `gsk_${pick(r, B62, 52)}`,
    `sk-or-v1-${pick(r, B62, 64)}`,
    `AKID${pick(r, B62, 32)}`,
    `ark-${pick(r, HEX, 8)}-${pick(r, HEX, 4)}-${pick(r, HEX, 4)}-${pick(r, HEX, 4)}-${pick(r, HEX, 12)}-${pick(r, HEX, 5)}`,
  ];
  const misses = [];
  for (const token of cases) {
    // wrapped in prose that has no credential keyword on purpose
    if (!detected(`这个还能用吗 ${token}`, token)) misses.push(token.slice(0, 12));
    if (!detected(token, token)) misses.push(token.slice(0, 12));
  }
  assert.deepEqual(misses, []);
});

test("real-world handover phrasings", () => {
  const KEY = "Zx8Kp2Lm9Qr4Tv7Wn3Yb6Cd1";
  const positives = [
    `token ${KEY}`,
    `token: ${KEY}`,
    `token= ${KEY}`,
    `API_KEY=${KEY}`,
    `export API_KEY="${KEY}"`,
    `-H "Authorization: Bearer ${KEY}"`,
    `"apiKey": "${KEY}"`,
    `api_key: ${KEY}`,
    `apiKey = '${KEY}'`,
    `{"token":"${KEY}"}`,
    `https://api.example.com/v1?api_key=${KEY}`,
    `https://api.example.com/v1?access_token=${KEY}&x=1`,
    `我的密钥是 ${KEY}`,
    `密钥如下：${KEY}`,
    `我把 token 贴这里了：${KEY}`,
    `用这个 key 试试 ${KEY}`,
    `这是 apikey，${KEY}，帮我跑一下`,
    `密码是 ${KEY}，请记住`,
    `| token | ${KEY} |`,
    `K='${KEY}'`,
    `token\n${KEY}`,
    `${KEY}`,
  ];
  const misses = positives.filter((text) => !detected(text, KEY));
  assert.deepEqual(misses, []);
});

test("prose and code that must not be masked", () => {
  const negatives = [
    "token bucket algorithm limits requests",
    "the token is invalid, please regenerate",
    "check that the token has not expired",
    "password policy requires at least 12 characters",
    "key rotation happens every quarter",
    "key point is performance",
    "secret santa 2024",
    "api key rotation is quarterly",
    "the authorization header is missing",
    "please use your own API key",
    "api_key = process.env.API_KEY",
    "token = getToken()",
    "password = os.environ['PASSWORD']",
    "secret: {{secrets.MY_SECRET}}",
    "token: <your-token-here>",
    "AKIAIOSFODNN7EXAMPLE",
    "0123456789abcdef0123456789abcdef01234567",
    "123e4567-e89b-12d3-a456-426614174000",
    "v1.2.3-beta.4",
    "CryptoKey | Uint8Array",
    "types.KeyObject",
    "path-key@3.1.0",
    "/usr/local/bin/node",
    "https://ark.cn-beijing.volces.com/api/v3/models",
    "token 12月3日过期",
    "密码至少 12 位，包含大小写",
    "本机 IP 10.203.10.48，端口 20341",
    "本仓库 42837 个文件",
    "édition française trésor",
  ];
  const hits = negatives.filter((t) => scan(t).length > 0);
  assert.deepEqual(hits, []);
});

test("preflight candidates: auto hits are high, loose guesses are medium", () => {
  const KEY = "Zx8Kp2Lm9Qr4Tv7Wn3Yb6Cd1";
  // auto-detectable → high, and strict must not duplicate it
  const high = scanCandidates(`token ${KEY}`, { strict: true });
  assert.equal(high.length, 1);
  assert.equal(high[0].confidence, "high");

  // auto-mode refuses short keyword-bound values; the confirmed path offers them
  for (const text of ["token ab12cd", "我的密钥 q7Kd92", "key: 9f8e7d", "password 123456"]) {
    assert.equal(scanCandidates(text, { strict: false }).length, 0, text);
    const got = scanCandidates(text, { strict: true });
    assert.equal(got.length, 1, text);
    assert.equal(got[0].confidence, "medium", text);
  }

  // auto-mode refuses short standalone tokens too
  assert.equal(scanCandidates("Xy7Kq2mZ9pRt", { strict: false }).length, 0);
  assert.equal(scanCandidates("Xy7Kq2mZ9pRt", { strict: true })[0].confidence, "medium");

  // prose and non-credentials stay empty even in strict mode
  for (const text of ["the token is invalid", "key point is performance", "看下 https://example.com/a/b 这个", "release-2024-12-01-final"]) {
    assert.deepEqual(scanCandidates(text, { strict: true }), [], text);
  }

  // previews never carry the value
  const preview = previewValue(KEY);
  assert.ok(!preview.includes(KEY));
  assert.match(preview, /^Zx8Kp2…6Cd1$/);
});

test("preflight candidates: real chat hand-offs reach the confirmation gate", () => {
  // regression from a real chat: all three phrasings below used to pass
  // through undetected — plausibleSecret() said yes but the relaxed-value
  // guards said no ("sentence word", digit requirement, symbol-leading body).
  const ids = (text) => scanCandidates(text, { strict: true }).map((c) => c.id);

  // explicit operator after the keyword: even a lowercase no-digit value
  assert.ok(ids("密码=thisismycode").includes("candidate-keyword-symbol"), "密码=thisismycode");
  assert.ok(ids("password=thisismycode").includes("candidate-keyword-symbol"), "password=thisismycode");

  // CJK credential word + bare token (also inside a longer chat turn)
  assert.ok(ids("这是我的密码 thisismycode。echo 输出它").includes("candidate-cjk-keyword-token"), "chat turn");
  assert.ok(ids("密码 thisismycode").includes("candidate-cjk-keyword-token"), "密码 thisismycode");

  // symbol-leading token body
  const symbolLeading = ids("密码 *ZE6=AkNQ=^@8*$p");
  assert.ok(symbolLeading.includes("candidate-cjk-keyword-token"), "密码 *ZE6=...");

  // confirmation-gate only: auto-mask (scan) stays quiet on these
  assert.equal(scan("密码=thisismycode").length, 0, "auto-mask must not fire on weak values");
  assert.equal(scan("密码 *ZE6=AkNQ=^@8*$p").length, 0, "auto-mask must not fire on symbol-leading values");

  // prose collisions stay empty in strict mode (English keyword nouns)
  assert.deepEqual(scanCandidates("key point is performance", { strict: true }), [], "key point");
  assert.deepEqual(scanCandidates("the token is invalid", { strict: true }), [], "token is invalid");
});

test("preflight candidates: big pastes do not flood the list", () => {
  const longKey = "Zx8Kp2Lm9Qr4Tv7Wn3Yb6Cd1";
  // 60 lines of code-ish noise: the standalone token pass is chat-only, so this
  // must not produce a candidate per line
  const big = Array.from({ length: 60 }, (_, i) => `const value${i} = build(${i}); // key=${i}abc`).join("\n");
  assert.equal(scanCandidates(big, { strict: true }).length, 0, "no standalone candidates in a code paste");

  // the same tokens with an explicit keyword are still offered
  const labeled = `token ${longKey}\n` + big;
  assert.ok(scanCandidates(labeled, { strict: true }).length >= 1);

  // and the list is capped so a pathological input stays reviewable
  const many = Array.from({ length: 200 }, (_, i) => `password: Abc${i}def${i}Gh`).join("\n");
  assert.ok(scanCandidates(many, { strict: true }).length <= CANDIDATE_LIMIT);
});
