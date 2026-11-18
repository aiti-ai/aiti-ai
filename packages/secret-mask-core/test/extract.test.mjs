// L1/L2/L3 helpers: key names, structured extraction, paths, weak candidates.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Registry } from "../src/mask.ts";
import {
  WEAK_PASSWORDS,
  extractStructuredSecrets,
  inspectSensitivePath,
  inspectToolTargets,
  isSensitiveKey,
  learnFromText,
  registerExtractedSecrets,
  registerMessageToolSecrets,
  registerValueSecrets,
  registerWeakCandidates,
  sensitiveReadTargets,
  weakPasswordCandidates,
} from "../src/extract.ts";

const SECRET = "7fJk2mN9pQrStUvWx3y4z5A6b7C8d9E0";
const WEAK = "rsec_" + "035c" + "2182";

test("sensitive key names: positive and negative", () => {
  for (const key of ["password", "DB_PASSWORD", "db-password", "passwd", "pwd", "passphrase", "secret", "client_secret", "token", "api_key", "apiKey", "access_key_id", "private-key", "credential", "credentials", "_authToken", "auth_token", "dsn", "connection_string", "Authorization"]) {
    assert.equal(isSensitiveKey(key), true, key);
  }
  for (const key of ["sort_key", "monkey", "key", "tokenizer", "author", "username", "client_id", "user", "port"]) {
    assert.equal(isSensitiveKey(key), false, key);
  }
});

test("structured extraction: env / INI / TOML / YAML / JSON / header / URL / netrc", () => {
  const env = extractStructuredSecrets('DB_PASSWORD=abc123\nPORT=3000\nexport API_TOKEN="xyz987654"\nSAFE=value');
  assert.deepEqual(env.map((x) => [x.key, x.value, x.format]), [
    ["DB_PASSWORD", "abc123", "env"],
    ["API_TOKEN", "xyz987654", "env"],
  ]);
  const yaml = extractStructuredSecrets("server:\n  password: abcdefgh\n  user: admin\n  token: 'tok_12345678'");
  assert.deepEqual(yaml.map((x) => [x.key, x.value]), [["password", "abcdefgh"], ["token", "tok_12345678"]]);
  const json = extractStructuredSecrets('{"password": "qwerty123", "nested": {"api_key": "key_12345678"}, "name": "x"}');
  assert.deepEqual(json.map((x) => [x.key, x.value]).sort(), [["api_key", "key_12345678"], ["password", "qwerty123"]]);
  const fragment = extractStructuredSecrets('log: {"password":"qwerty123"} done');
  assert.deepEqual(fragment.map((x) => x.value), ["qwerty123"]);
  const header = extractStructuredSecrets("Authorization: Bearer abcdef123456");
  assert.deepEqual(header.map((x) => [x.key, x.value, x.format]), [["authorization", "abcdef123456", "header"]]);
  const url = extractStructuredSecrets("postgres://user:123abc@localhost:5432/db");
  assert.deepEqual(url.map((x) => [x.key, x.value]), [["url-password", "123abc"]]);
  const netrc = extractStructuredSecrets("machine example.com login me password zzz12345");
  assert.deepEqual(netrc.map((x) => x.value), ["zzz12345"]);
});

test("structured extraction: placeholders, stop words and short values are skipped", () => {
  const out = extractStructuredSecrets(
    [
      "DB_PASSWORD=${DB_PASSWORD}",
      "API_TOKEN={{token}}",
      "PASSWORD=required",
      "SECRET=changeme",
      "PWD=$PASSWORD",
      "password: null",
      "token: abc", // < 6
      "dsn: postgres://u:p@h/db",
    ].join("\n"),
  );
  assert.deepEqual(out.map((x) => x.key), ["token", "dsn"]);
  assert.equal(out[0].value, "abc");
  assert.equal(out[1].value, "postgres://u:p@h/db");
  // registration still enforces the 6-char floor
  const r = new Registry();
  assert.equal(registerExtractedSecrets("token: abc\ndsn: postgres://u:p@h/db", r, "s").count, 1);
});

test("registerExtractedSecrets: registers, redacts, dedupes and enforces length", () => {
  const r = new Registry();
  const text = "DB_PASSWORD=abc123\nAPI_TOKEN=xyz987654\nSHORT=abc";
  const res = registerExtractedSecrets(text, r, "salt");
  assert.equal(res.count, 2);
  assert.deepEqual(res.keys.sort(), ["API_TOKEN", "DB_PASSWORD"]);
  assert.equal(r.size, 2);
  // second pass: nothing new
  assert.equal(registerExtractedSecrets(text, r, "salt").count, 0);
  // registered values are redacted in the same text
  const red = r.redact(text);
  assert.ok(!red.text.includes("abc123"));
  assert.ok(!red.text.includes("xyz987654"));
  assert.ok(red.text.includes("DB_PASSWORD="), "keys stay readable");
  assert.equal(r.restore(red.text).text, text);
});

test("sensitive paths: dotenv, ssh, pgpass, secret files, key files; negatives", () => {
  const yes = [
    ".env",
    "/home/u/proj/.env.local",
    "/home/u/.ssh/id_rsa",
    "/home/u/.ssh/id_ed25519",
    ".pgpass",
    ".netrc",
    "/home/u/.aws/credentials",
    "/home/u/.kube/config",
    "/home/u/.docker/config.json",
    "secret.txt",
    "db-password.txt",
    "secrets.json",
    "credentials.json",
    "server.key",
    "cert.p12",
  ];
  for (const p of yes) assert.equal(inspectSensitivePath(p).sensitive, true, p);
  const no = ["/home/u/.ssh/id_rsa.pub", "src/tokenizer.ts", "README.md", "config.json", "package.json", "cert.pem"];
  for (const p of no) assert.equal(inspectSensitivePath(p).sensitive, false, p);
  assert.equal(inspectSensitivePath("/home/u/.ssh/id_rsa").dedicated, true);
  assert.equal(inspectSensitivePath(".env").dedicated, false);
  assert.equal(inspectSensitivePath("secret.txt").dedicated, true);
  assert.equal(inspectSensitivePath("secrets.json").dedicated, false);
});

test("tool targets: read/write/edit and bash reads/writes/contents", () => {
  assert.deepEqual(inspectToolTargets("read", { path: "/p/.env" }).reads, ["/p/.env"]);
  const write = inspectToolTargets("write", { path: "/p/.env", content: "PASSWORD=abc12345" });
  assert.deepEqual(write.writes, ["/p/.env"]);
  assert.deepEqual(write.contents, ["PASSWORD=abc12345"]);
  const edit = inspectToolTargets("edit", { path: "/p/cfg", oldText: "a", newText: "DB_PASSWORD=abc12345" });
  assert.deepEqual(edit.contents, ["DB_PASSWORD=abc12345"]);
  const bash = inspectToolTargets("bash", { command: "cat ~/.env | grep PW; echo 'API_TOKEN=abc12345' > /tmp/out" });
  assert.deepEqual(bash.reads, ["~/.env"]);
  assert.deepEqual(bash.writes, ["/tmp/out"]);
  assert.deepEqual(bash.contents.length, 1);
  assert.deepEqual(inspectToolTargets("powershell", { command: "Get-Content C:\\Users\\u\\.env" }).reads, ["C:\\Users\\u\\.env"]);
  assert.deepEqual(sensitiveReadTargets("read", { path: "/p/.env" }).map((x) => x.path), ["/p/.env"]);
  assert.deepEqual(sensitiveReadTargets("read", { path: "/p/README.md" }), []);
});

test("weak candidates: dictionary hits, prose stop words, strong context only", () => {
  assert.ok(WEAK_PASSWORDS.has(WEAK));
  assert.ok(WEAK_PASSWORDS.has("qwerty"));
  const a = weakPasswordCandidates("我的密码是" + WEAK);
  assert.deepEqual(a.map((x) => [x.key, x.value, x.dictionary]), [["密码", WEAK, true]]);
  const b = weakPasswordCandidates("my password is qwerty");
  assert.equal(b.length, 1);
  assert.equal(b[0].value, "qwerty");
  assert.equal(weakPasswordCandidates("password is configured.").length, 0);
  assert.equal(weakPasswordCandidates("password is expired").length, 0);
  assert.equal(weakPasswordCandidates("the password is stored elsewhere").length, 0, "no strong operator → no candidate");
  const c = weakPasswordCandidates("密码是abc!@#");
  assert.equal(c.length, 1);
  assert.equal(c[0].dictionary, false);
});

test("weak candidates: dictionary registers, non-dictionary notifies, auto registers", () => {
  const r = new Registry();
  const notified = [];
  registerWeakCandidates("我的密码是" + WEAK, r, "s", { onCandidate: (c) => notified.push(c.value) });
  assert.equal(r.size, 1);
  assert.equal(r.entries()[0].source, "auto");
  assert.match(r.entries()[0].ruleId, /^weak:/);
  assert.deepEqual(notified, [WEAK], "dictionary hits report the warning too");
  // non-dictionary weak value: notify only
  const r2 = new Registry();
  const seen = [];
  registerWeakCandidates("密码是abc!@#", r2, "s", { onCandidate: (c) => seen.push(c.value) });
  assert.equal(r2.size, 0);
  assert.deepEqual(seen, ["abc!@#"]);
  // auto mode registers it
  const r3 = new Registry();
  registerWeakCandidates("密码是abc!@#", r3, "s", { auto: true });
  assert.equal(r3.size, 1);
  // too short to register
  const r4 = new Registry();
  registerWeakCandidates("password=1234", r4, "s", { auto: true });
  assert.equal(r4.size, 0);
});

test("learnFromText: structured first, whole-content fallback", () => {
  const r = new Registry();
  const env = learnFromText("DB_PASSWORD=abc12345", r, "s", { whole: true });
  assert.equal(env.count, 1);
  assert.equal(env.wholeRegistered, undefined);
  const r2 = new Registry();
  const whole = learnFromText("123abc", r2, "s", { whole: true, label: "secret.txt" });
  assert.equal(whole.count, 1);
  assert.equal(whole.wholeRegistered, true);
  assert.equal(whole.keys[0], "SECRET.TXT");
  assert.equal(r2.restore(r2.entries()[0].placeholder).text, "123abc");
  // no whole fallback when disabled
  const r3 = new Registry();
  assert.equal(learnFromText("123abc", r3, "s").count, 0);
});

test("message tool-call mining and nested details mining", () => {
  const r = new Registry();
  const msg = {
    role: "assistant",
    content: [
      { type: "text", text: "writing" },
      { type: "toolCall", id: "t1", name: "write", arguments: { path: "/p/.env", content: "DB_PASSWORD=abc12345" } },
      { type: "toolCall", id: "t2", name: "bash", arguments: { command: "export API_TOKEN=xyz987654" } },
    ],
  };
  const res = registerMessageToolSecrets(msg, r, "s");
  assert.equal(res.count, 2);
  assert.deepEqual(res.keys.sort(), ["API_TOKEN", "DB_PASSWORD"]);
  // nested details: stdout contains an env line
  const r2 = new Registry();
  const nested = registerValueSecrets({ stdout: "PASSWORD=abc12345", nested: [{ token: "abc" }] }, r2, "s");
  assert.equal(nested.count, 1);
  assert.equal(r2.size, 1);
});
