// Registry + redaction engine behaviour (v2 `rsec_<hash8>` placeholders).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Registry, redactForms, restoreDeep, redactDeep, redactDeepInPlace, MIN_REDACT_LENGTH } from "../src/mask.ts";

const SECRET = "7fJk2mN9pQrStUvWx3y4z5A6b7C8d9E0";
const PLACEHOLDER = /^rsec_[0-9a-f]{8}$/;

test("manual registration: credential-shaped placeholder + round-trip", () => {
  const r = new Registry();
  r.salt = "salty";
  const res = r.registerManual(SECRET, "github-token");
  assert.ok(res);
  assert.match(res.entry.placeholder, PLACEHOLDER);
  assert.equal(res.entry.alias, "github-token");
  const text = `use key ${SECRET} in the header`;
  const red = r.redact(text);
  assert.equal(red.count, 1);
  assert.ok(!red.text.includes(SECRET));
  assert.ok(red.text.includes(res.entry.placeholder));
  const back = r.restore(red.text);
  assert.equal(back.text, text);
  assert.equal(back.count, 1);
});

test("min length guard", () => {
  const r = new Registry();
  assert.equal(r.registerManual("abc"), undefined);
  assert.equal(r.registerManual("x".repeat(MIN_REDACT_LENGTH - 1)), undefined);
  assert.ok(r.registerManual("y".repeat(MIN_REDACT_LENGTH)));
});

test("same value + same alias is idempotent; alias re-add keeps the token", () => {
  const r = new Registry();
  r.salt = "s1";
  const a = r.registerManual(SECRET, "one");
  const b = r.registerManual(SECRET, "one");
  assert.equal(a.entry.placeholder, b.entry.placeholder);
  assert.equal(r.size, 1);
  const c = r.registerManual(SECRET, "two");
  assert.equal(c.replaced, true);
  assert.equal(r.size, 1);
  assert.equal(c.entry.alias, "two");
  // same value + same salt → same token (prompt-cache friendly)
  assert.equal(c.entry.placeholder, a.entry.placeholder);
});

test("auto registration: stable placeholder per session salt", () => {
  const r = new Registry();
  const e1 = r.registerAuto(SECRET, "generic-secret", "SECRET", "s1");
  assert.ok(e1);
  assert.match(e1.entry.placeholder, PLACEHOLDER);
  const e2 = r.registerAuto(SECRET, "generic-secret", "SECRET", "s1");
  assert.equal(e1.entry.placeholder, e2.entry.placeholder);
  assert.equal(r.size, 1);
  const r2 = new Registry();
  const other = r2.registerAuto(SECRET, "generic-secret", "SECRET", "s2");
  assert.notEqual(e1.entry.placeholder, other.entry.placeholder, "different salt → different hash");
});

test("stable (vault) registration: cross-session, salt-independent", () => {
  const a = new Registry();
  a.salt = "one";
  const e1 = a.registerStable(SECRET, "openai-key");
  assert.ok(e1);
  assert.match(e1.entry.placeholder, PLACEHOLDER);
  assert.equal(e1.entry.source, "vault");
  assert.equal(e1.entry.stable, true);
  const b = new Registry();
  b.salt = "another-session";
  const e2 = b.registerStable(SECRET, "openai-key");
  assert.equal(e1.entry.placeholder, e2.entry.placeholder, "same alias → same token across sessions");
});

test("auto→manual upgrade keeps the token when the salt is shared", () => {
  const r = new Registry();
  r.salt = "shared";
  const auto = r.registerAuto(SECRET, "generic-secret", "SECRET", "shared");
  const manual = r.registerManual(SECRET, "prod-key");
  assert.equal(manual.entry.placeholder, auto.entry.placeholder);
});

test("old placeholders redirect to the re-registered entry", () => {
  const r = new Registry();
  const first = r.registerManual(SECRET, "one", { placeholder: "rsec_11111111" });
  assert.equal(first.entry.placeholder, "rsec_11111111");
  const second = r.registerManual(SECRET, "two", { placeholder: "rsec_22222222" });
  assert.equal(second.entry.placeholder, "rsec_22222222");
  // the model may still reference the previous token in later turns
  assert.equal(r.restore("rsec_11111111").text, SECRET);
  assert.equal(r.restore("rsec_22222222").text, SECRET);
});

test("legacy placeholders stay restorable", () => {
  const r = new Registry();
  r.registerManual(SECRET, "legacy", { placeholder: "[REDACTED:legacy]" });
  assert.equal(r.restore("a [REDACTED:legacy] b").text, `a ${SECRET} b`);
  // legacy auto shape from a previous version
  r.registerManual("9pQrStUvWx3y4z5A6b7C8d9E0f1", "old-auto", { placeholder: "[REDACTED:GITHUB_TOKEN#a1b2c3d4]" });
  assert.equal(r.restore("[REDACTED:GITHUB_TOKEN#a1b2c3d4]").text, "9pQrStUvWx3y4z5A6b7C8d9E0f1");
});

test("autoRegister scans text and dedupes", () => {
  const r = new Registry();
  const added = r.autoRegister(`my token: "${SECRET}" ok`, "salt");
  assert.equal(added.length, 1);
  const again = r.autoRegister(`my token: "${SECRET}" ok`, "salt");
  assert.equal(again.length, 0);
});

test("redact is idempotent (placeholders untouched by second pass)", () => {
  const r = new Registry();
  r.registerManual(SECRET, "k");
  const once = r.redact(`a=${SECRET};`);
  const twice = r.redact(once.text);
  assert.equal(twice.text, once.text);
  assert.equal(twice.count, 0);
});

test("longest form wins on substring overlap", () => {
  const r = new Registry();
  const long = r.registerManual("AAAA1111BBBB2222CCCC", "long");
  const short = r.registerManual("1111BBBB", "short");
  const res = r.redact("x AAAA1111BBBB2222CCCC y 1111BBBB z");
  assert.ok(res.text.includes(long.entry.placeholder));
  assert.ok(res.text.includes(short.entry.placeholder));
  assert.ok(!res.text.includes("1111BBBB2222CCCC"));
});

test("redactForms: PEM-style multi-part value yields base64 runs", () => {
  const pem = `-----BEGIN RSA PRIVATE KEY-----\n${"AbCd".repeat(16)}\n${"EfGh".repeat(16)}\n-----END RSA PRIVATE KEY-----`;
  const forms = redactForms(pem);
  assert.ok(forms.includes(pem.trim()));
  assert.ok(forms.some((f) => f.length >= 20 && !f.includes("-----")), "inner runs present");
  const r = new Registry();
  r.registerManual(pem, "pem");
  const damaged = pem.replace(/\n/g, " # line3\n"); // reshaped by line numbers
  const res = r.redact(damaged);
  assert.ok(!res.text.includes("AbCd".repeat(16)), "run redacted even when reshaped");
});

test("restore only known placeholders; unknown pass through", () => {
  const r = new Registry();
  const known = r.registerManual(SECRET, "k").entry.placeholder;
  const res = r.restore(`a ${known} b rsec_00000000 c`);
  assert.equal(res.text, `a ${SECRET} b rsec_00000000 c`);
  assert.equal(res.count, 1);
});

test("deep restore/redact on nested tool input", () => {
  const r = new Registry();
  const ph = r.registerManual(SECRET, "k").entry.placeholder;
  const input = { cmd: `echo ${SECRET}`, env: { T: ph }, list: ["x", ph], n: 5, b: true };
  const restored = restoreDeep(input, r);
  assert.equal(restored.count, 2); // cmd already holds the raw value; only placeholders restore
  assert.equal(restored.value.cmd, `echo ${SECRET}`);
  assert.equal(restored.value.env.T, SECRET);
  assert.deepEqual(restored.value.list, ["x", SECRET]);
  const back = redactDeep(restored.value, r);
  assert.equal(back.count, 3);
  assert.equal(back.value.cmd, `echo ${ph}`);
});

test("redactDeepInPlace walks compaction-style preparations", () => {
  const r = new Registry();
  const ph = r.registerManual(SECRET, "k").entry.placeholder;
  const prep = {
    messagesToSummarize: [{ role: "user", content: [{ type: "text", text: `key ${SECRET}` }] }],
    turnPrefixMessages: [{ role: "bashExecution", command: `export K=${SECRET}`, output: "ok" }],
    previousSummary: `earlier we used ${SECRET}`,
  };
  const n = redactDeepInPlace(prep, r);
  assert.equal(n, 3);
  assert.equal(prep.messagesToSummarize[0].content[0].text, `key ${ph}`);
  assert.equal(prep.turnPrefixMessages[0].command, `export K=${ph}`);
  assert.equal(prep.previousSummary, `earlier we used ${ph}`);
});

test("remove keeps a redirect; clear drops everything", () => {
  const r = new Registry();
  const ph1 = r.registerManual(SECRET, "k1").entry.placeholder;
  r.registerManual("9pQrStUvWx3y4z5A6b7C8d9E0f1", "k2");
  assert.equal(r.removeByLabel("k1"), true);
  assert.equal(r.size, 1);
  assert.equal(r.restore(ph1).text, SECRET, "removed placeholder still redirects for the session");
  r.clear();
  assert.equal(r.size, 0);
  assert.equal(r.restore(ph1).count, 0);
});
