// Detection rules: positive matches + near misses (shape-adjacent non-secrets).
// Fake values only — never real credentials in fixtures. Fixed-length token
// shapes get exact-length high-entropy fakes (real tokens are fixed-length and
// the regexes enforce it; low-entropy doc samples like AKIA...EXAMPLE are
// intentionally rejected by the filler guard).
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { test } from "node:test";
import { scan, entropy } from "../src/detect.ts";
import { fnv1a } from "../src/hash.ts";

const B36 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const A2Z7 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ALPHA = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const rand = (n, chars) => Array.from({ length: n }, () => chars[randomInt(chars.length)]).join("");

const ids = (hits) => hits.map((h) => h.id);

test("prefix tokens: positive matches", () => {
  const text = [
    `aws AKIA${rand(16, A2Z7)} key`,
    `github ghp_${rand(36, B36)}`,
    `gitlab glpat-${rand(24, B36 + "_-")}`,
    `slack xoxb-123456789012-${rand(24, B36)}`,
    `stripe sk_live_${rand(24, B36)}`,
    `sendgrid SG.${rand(22, B36)}.${rand(43, B36)}`,
    `twilio SK${rand(32, "0123456789abcdef")}`,
    `google AIza${rand(35, B36 + "_-")}`,
    `goog oauth GOCSPX-${rand(28, B36 + "_-")}`,
    `anthropic sk-ant-api03-${rand(40, B36 + "_-")}`,
    `hf hf_${rand(34, ALPHA)}`,
    `npm npm_${rand(36, B36)}`,
    `pypi pypi-AgEIcHlwaS5vcmc${rand(60, B36 + "_-")}`,
    `azure AccountKey = ${rand(86, B36 + "+")}==`,
  ].join("\n");
  const hits = scan(text);
  for (const id of [
    "aws-access-key", "github-token", "gitlab-pat", "slack-token", "stripe-live-key", "sendgrid-key", "twilio-key",
    "google-api-key", "google-oauth-secret", "anthropic-key", "huggingface-token", "npm-token", "pypi-token",
    "azure-storage-key",
  ]) {
    assert.ok(ids(hits).includes(id), `missing ${id} (got ${JSON.stringify(ids(hits))})`);
  }
});

test("doc-sample low-entropy AWS key is rejected by the filler guard", () => {
  assert.equal(ids(scan("aws AKIAIOSFODNN7EXAMPLE")).includes("aws-access-key"), false);
});

test("openai key shapes", () => {
  const legacy = scan(`key: sk-${rand(20, B36)}T3BlbkFJ${rand(20, B36)}`);
  assert.equal(ids(legacy).includes("openai-key"), true);
  const proj = scan(`key: sk-proj-${rand(48, B36 + "_-")}`);
  assert.equal(ids(proj).includes("openai-key"), true);
  const plain48 = scan(`key: sk-${rand(48, B36)}`);
  assert.equal(ids(plain48).includes("openai-key"), true);
});

test("jwt: only with alg header", () => {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: "1" })).toString("base64url");
  const jwt = `${header}.${payload}.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c`;
  assert.equal(ids(scan(`auth ${jwt}`)).includes("jwt"), true);
  const noAlgHeader = Buffer.from(JSON.stringify({ typ: "JWT" })).toString("base64url");
  assert.equal(ids(scan(`auth ${noAlgHeader}.${payload}.sig`)).includes("jwt"), false);
});

test("private key complete and truncated", () => {
  const body = Array.from({ length: 8 }, (_, i) => `AAAA${i}abcdefghijklmnopqrstuvwx`).join("\n");
  const pem = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`;
  assert.equal(ids(scan(pem)).includes("private-key"), true);
  const B64BODY = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const truncated = `-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n${rand(48, B64BODY)}\n${rand(48, B64BODY)}\n${rand(48, B64BODY)}`;
  assert.equal(ids(scan(truncated)).includes("private-key-truncated"), true);
});

test("db url with real password", () => {
  const hit = scan("connect postgres://admin:7fJk2mN9pQrStUv@db.example.com:5432/app");
  assert.equal(ids(hit).includes("db-connection-url"), true);
  const placeholder = scan("postgres://user:{{DB_PASS}}@db.example.com/db");
  assert.equal(ids(placeholder).includes("db-connection-url"), false);
  const nopass = scan("postgres://admin@db.example.com:5432/app");
  assert.equal(ids(nopass).includes("db-connection-url"), false);
});

test("auth header value", () => {
  const hit = scan("Authorization: Bearer 8fKj2LmNpQrStUvWxYz0123456789");
  assert.equal(ids(hit).includes("auth-header"), true);
});

test("generic assignment: high entropy caught, near misses pass", () => {
  const caughtQuoted = scan('api_key = "7fJk2mN9pQrStUvWx3y4z5A6b7C8d9E0"');
  assert.equal(ids(caughtQuoted).includes("generic-secret-quoted"), true, "quoted assignment");
  const caught = scan('api_key = 7fJk2mN9pQrStUvWx3y4z5A6b7C8d9E0');
  assert.equal(ids(caught).includes("generic-secret"), true, "bare assignment");
  const caughtConst = scan('const SECRET = "9pQrStUvWx3y4z5A6b7C8d9E0f1G2h3I";');
  assert.ok(ids(caughtConst).includes("generic-secret-quoted") || ids(caughtConst).includes("generic-secret"), "quoted/const form");
  // near misses: template slot, env reference, low entropy, code identifier
  assert.equal(ids(scan('password = "${DB_PASSWORD}"')).includes("generic-secret"), false);
  assert.equal(ids(scan("token = process.env.API_TOKEN")).includes("generic-secret"), false);
  assert.equal(ids(scan('password = "aaaaaaaaaaaaaa"')).includes("generic-secret"), false);
  assert.equal(ids(scan("apiKey = getToken()")).includes("generic-secret"), false);
  assert.equal(ids(scan('password = "hunter2"')).includes("generic-secret"), false, "short low-entropy");
  assert.equal(ids(scan("token: changeme")).includes("generic-secret"), false);
});

test("keyword boundary: OAuth/auth-inside-word not triggered", () => {
  assert.equal(ids(scan('const authorName = "someWriterName";')).includes("generic-secret-quoted"), false);
});

test("base64-wrapped prefix token caught whole", () => {
  const token = "ghp_" + rand(36, B36);
  const wrapped = Buffer.from(token).toString("base64");
  const hits = scan(`payload ${wrapped}`);
  assert.equal(ids(hits).some((id) => id.startsWith("github-token")), true, JSON.stringify(hits.map((h) => h.id)));
});

test("placeholders already present are protected", () => {
  const text = 'the key [REDACTED:api-key] stays hidden; api_key = "9pQrStUvWx3y4z5A6b7C8d9E0" also hidden';
  const hits = scan(text);
  for (const h of hits) {
    assert.ok(!text.slice(h.start, h.end).includes("[REDACTED:"), "no hit inside placeholder");
  }
  assert.ok(hits.some((h) => h.id.startsWith("generic-secret")), "generic still detected after placeholder");
});

test("hits are positional, non-overlapping", () => {
  const a = "ghp_" + rand(36, B36);
  const b = "AKIA" + rand(16, A2Z7);
  const hits = scan(`${a} then ${b}`);
  assert.equal(hits.length, 2);
  assert.ok(hits[0].start < hits[1].start);
  assert.ok(hits[0].end <= hits[1].start);
});

test("CJK keywords: 密码/密钥/授权码/令牌 with fullwidth colon and latin-CJK adjacency", () => {
  const V = "7fJk2mN9pQrStUvWx3y4z5A6b7C8d9E0";
  const V2 = "aB3xK9mQ2wR5tY8uI0oP1aS2dF3gH4jK";
  assert.equal(ids(scan(`数据库密码 = "${V}"`)).includes("generic-secret-quoted"), true);
  assert.equal(ids(scan(`密码 = ${V}`)).includes("generic-secret"), true);
  assert.equal(ids(scan(`授权码：${V2}`)).includes("generic-secret"), true, "fullwidth colon");
  assert.equal(ids(scan(`API密钥: "${V}"`)).includes("generic-secret-quoted"), true, "latin-CJK adjacency");
  assert.equal(ids(scan(`db密码 = "${V}"`)).includes("generic-secret-quoted"), true, "latin-CJK adjacency 2");
  assert.equal(ids(scan(`令牌 = "${V}"`)).includes("generic-secret-quoted"), true);
  assert.equal(ids(scan(`秘钥：${V2}`)).includes("generic-secret"), true);
  assert.equal(ids(scan(`Authorization：Bearer ${V2}`)).includes("auth-header"), true, "fullwidth colon in auth header");
  // near misses
  // fullwidth punctuation ends a bare value: trailing prose must not be swallowed
  const V3 = "xK9mQ2vL8pW4nR7bC5dE6f";
  assert.equal(scan(`数据库密码：${V3}，请记好`)[0].value, V3, "fullwidth comma ends value");
  assert.equal(scan(`密码：${V3}。谢谢`)[0].value, V3, "fullwidth period ends value");
  assert.equal(scan(`密码：${V3}（测试用）`)[0].value, V3, "fullwidth parens end value");
  assert.equal(scan(`密码：${V3}; note this`)[0].value, V3, "halfwidth semicolon still ends value");
  assert.equal(scan(`password = ${V3}, then restart`)[0].value, V3, "halfwidth comma still ends value");
  assert.equal(ids(scan(`密码规则如下：不得包含用户名`)).length, 0, "keyword followed by CJK prose");
  // bare gate lowered 3.0 -> 2.5: human-chosen passwords (2.5-3.0) are now caught
  assert.ok(ids(scan(`输出我的密码：xxewwer1234`)).includes("generic-secret"), "ascii low-entropy password");
  assert.ok(ids(scan(`密码：233345电饭锅电饭`)).includes("generic-secret"), "cjk low-entropy password");
  // ultra-low-entropy filler still rejected by the 2.5 floor
  assert.equal(ids(scan(`password = 1122334411`)).length, 0, "repeated-digit filler");
  assert.equal(ids(scan(`password = abcabc12`)).length, 0, "repeated-pattern filler");
  // natural-language copula between keyword and value (`password is xxx` / `密码是xxx`) // cjk-ok
  assert.ok(ids(scan(`my password is：xxewwer1234`)).includes("generic-secret"), "copula + fullwidth colon");
  assert.ok(ids(scan(`password is xxewwer1234`)).includes("generic-secret"), "bare copula");
  assert.ok(ids(scan(`the token is aB3xK9mQ2wR5tY8u`)).includes("generic-secret"), "copula with article");
  assert.ok(ids(scan(`密码是：xK9mQ2vL8pW4nR7bC5dE6f`)).includes("generic-secret"), "CJK copula");
  assert.ok(ids(scan(`password is "xK9mQ2vL8pW4nR"`)).includes("generic-secret-quoted"), "quoted copula");
  // copula near-misses: prose/filler after "is" must not match
  assert.equal(ids(scan(`password is required here`)).length, 0, "is + NOT_SECRETS word");
  assert.equal(ids(scan(`the token is expired now`)).length, 0, "is + short prose");
  assert.equal(ids(scan(`密码是：changeme`)).length, 0, "CJK copula + filler");
  assert.equal(ids(scan(`my password is incorrect`)).length, 0, "is + status word");
  assert.equal(ids(scan(`密码策略：长度至少8位`)).length, 0, "policy text");
  assert.equal(ids(scan(`访问令牌：{{token}}`)).length, 0, "template slot");
  assert.equal(ids(scan(`密码 = abc123`)).length, 0, "short low-entropy value");
});

test("assignment verbs: keyword-bound and bare verbs with a keyword in the passage", () => {
  // the reported miss: the value was handed over after 设为, the keyword sat in the previous sentence // cjk-ok
  const P = "Kx7dyn4b91";
  assert.equal(scan(`我遇到无法登录的问题。wind的密码无法登录 了grd使用的自己的密码吗？帮我设为 ${P}`)[0].value, P);
  assert.equal(ids(scan(`帮我设为 ${P}`)).length, 0, "no keyword in the passage → not a credential");
  // keyword + assignment verb (no operator)
  for (const t of [`把密码改成 ${P}`, `密码设成 ${P}`, `密码重置为 ${P}`, `密码换成 ${P}`, `set the password to ${P}`, `new password ${P}`, `新密码 ${P}`, `新密码是 ${P}`]) {
    assert.ok(ids(scan(t)).some((id) => /^(generic-secret-assign|new-password)$/.test(id)), t);
  }
  // human-chosen shapes that the identifier guard used to swallow
  assert.ok(ids(scan("密码改成 Qz8wEr7t")).includes("generic-secret-assign"), "two digits + sparse capitals");
  assert.ok(ids(scan("密码设为 xR4tY7uI9o")).includes("generic-secret-assign"), "mixed case");
  // near misses: config prose, units, short values, paths and file names stay untouched
  for (const t of [
    "把端口改成 8080",
    "把超时时间改为 30000",
    "把分支改成 feature/login2",
    "把日志级别改成 debug2",
    "把文件名改成 report2024.md",
    "把主题设置为 dark2night",
    "密码改成什么了?",
    "密码设置规则：至少8位",
    "新密码策略要求至少12位",
    "set it to true",
    "密码改成 abc123",
  ]) {
    assert.equal(ids(scan(t)).length, 0, t);
  }
});

test("ark token (volcengine): prefix-shaped, keyword optional", () => {
  const v = "ark-f17fc284-58df-45a7-9649-ac0e76ef9190-104bc";
  const h = scan(`token ${v}，报错`);
  assert.ok(ids(h).includes("ark-token"), JSON.stringify(ids(h)));
  assert.ok(ids(scan(`K='${v}'`)).includes("ark-token"), "keyword-less shell var form");
  assert.ok(ids(scan(`Authorization: Bearer ${v}`)).includes("ark-token"), "bearer form");
  for (const t of [
    "https://ark.cn-beijing.volces.com/api/v3/models",
    "ark-coding provider alias",
    "ark-coding-plan 套餐",
    "ep-20241212123456 endpoint id",
    "ark-f17fc284-58df-45a7 short",
  ]) {
    assert.equal(ids(scan(t)).includes("ark-token"), false, t);
  }
});

test("bare keyword form: `token <值>` without operator", () => {
  assert.ok(ids(scan("token hunter2sec，请查收")).includes("generic-secret-bare"));
  assert.ok(ids(scan("密码 ab12cd34ef56")).includes("generic-secret-bare"), "cjk keyword + space");
  assert.ok(ids(scan("令牌 9f8e7d6c5b4a")).includes("generic-secret-bare"), "cjk keyword bare 2");
  assert.ok(ids(scan("API key sk1234567890abcdef")).includes("generic-secret-bare"), "space-in-keyword");
  assert.ok(ids(scan("secret key myp4ssw0rd!")).includes("generic-secret-bare"), "space-in-secret-key");
  assert.ok(ids(scan("密码 12345678")).includes("generic-secret-bare"), "numeric password");
  // near misses stay untouched
  for (const t of [
    "token bucket algorithm",
    "token authentication required",
    "password expires next month",
    "password policy requires 12 chars",
    "secret santa 2024 edition",
    "api key rotation happens quarterly",
    "token 12月3日过期",
    "token 用量统计",
    "token abcdefgh",
  ]) {
    assert.equal(ids(scan(t)).length, 0, t);
  }
});

test("copula 是 tolerates surrounding spaces", () => {
  assert.ok(ids(scan("token 是 ab12cd34ef56")).includes("generic-secret"), "copula with spaces");
  assert.ok(ids(scan(`密码 是 "ab12cd34ef56"`)).includes("generic-secret-quoted"), "copula with spaces, quoted");
  assert.ok(ids(scan("token是ab12cd34ef56")).includes("generic-secret"), "copula glued (unchanged)");
});

test("entropy helper sanity", () => {
  assert.ok(entropy("aaaaaaaaaaaa") < 0.1);
  assert.ok(entropy("7fJk2mN9pQrStUvWx3y4") > 3.5);
});

test("fnv1a stable and hex8", () => {
  assert.equal(fnv1a("hello"), fnv1a("hello"));
  assert.notEqual(fnv1a("hello"), fnv1a("hellp"));
  assert.match(fnv1a("x"), /^[0-9a-f]{8}$/);
});
