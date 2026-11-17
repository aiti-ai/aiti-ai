// Registry + redaction engine behaviour.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Registry, redactForms, restoreDeep, redactDeep, MIN_REDACT_LENGTH } from "../src/mask.ts";

const SECRET = "7fJk2mN9pQrStUvWx3y4z5A6b7C8d9E0";

test("manual registration: placeholder format and redact/restore round-trip", () => {
  const r = new Registry();
  const res = r.registerManual(SECRET, "github-token");
  assert.ok(res);
  assert.equal(res.entry.placeholder, "[REDACTED:github-token]");
  const text = `use key ${SECRET} in the header`;
  const red = r.redact(text);
  assert.equal(red.count, 1);
  assert.equal(red.text, "use key [REDACTED:github-token] in the header");
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

test("same value is idempotent; alias re-add replaces", () => {
  const r = new Registry();
  const a = r.registerManual(SECRET, "one");
  const b = r.registerManual(SECRET, "one");
  assert.equal(a.entry.placeholder, b.entry.placeholder);
  assert.equal(r.size, 1);
  const c = r.registerManual(SECRET, "two");
  assert.equal(c.replaced, true);
  assert.equal(r.size, 1);
  assert.equal(c.entry.placeholder, "[REDACTED:two]");
  // old placeholder no longer restorable
  assert.equal(r.restore("[REDACTED:one]").count, 0);
});

test("auto registration: stable placeholder per session salt", () => {
  const r = new Registry();
  const e1 = r.registerAuto(SECRET, "generic-secret", "SECRET", "s1");
  assert.ok(e1);
  assert.match(e1.entry.placeholder, /^\[REDACTED:SECRET#[0-9a-f]{8}\]$/);
  const e2 = r.registerAuto(SECRET, "generic-secret", "SECRET", "s1");
  assert.equal(e1.entry.placeholder, e2.entry.placeholder);
  assert.equal(r.size, 1);
  const r2 = new Registry();
  const other = r2.registerAuto(SECRET, "generic-secret", "SECRET", "s2");
  assert.notEqual(e1.entry.placeholder, other.entry.placeholder, "different salt → different hash");
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
  r.registerManual("AAAA1111BBBB2222CCCC", "long");
  r.registerManual("1111BBBB", "short");
  const res = r.redact("x AAAA1111BBBB2222CCCC y 1111BBBB z");
  assert.ok(res.text.includes("[REDACTED:long]"));
  assert.ok(res.text.includes("[REDACTED:short]"));
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
  r.registerManual(SECRET, "k");
  const res = r.restore("a [REDACTED:k] b [REDACTED:unknown] c");
  assert.equal(res.text, `a ${SECRET} b [REDACTED:unknown] c`);
  assert.equal(res.count, 1);
});

test("deep restore/redact on nested tool input", () => {
  const r = new Registry();
  r.registerManual(SECRET, "k");
  const input = { cmd: `echo ${SECRET}`, env: { T: "[REDACTED:k]" }, list: ["x", "[REDACTED:k]"], n: 5, b: true };
  const restored = restoreDeep(input, r);
  assert.equal(restored.count, 2); // cmd already holds the raw value; only placeholders restore
  assert.equal(restored.value.cmd, `echo ${SECRET}`);
  assert.equal(restored.value.env.T, SECRET);
  assert.deepEqual(restored.value.list, ["x", SECRET]);
  const back = redactDeep(restored.value, r);
  assert.equal(back.count, 3);
  assert.equal(back.value.cmd, "echo [REDACTED:k]");
});

test("remove and clear", () => {
  const r = new Registry();
  r.registerManual(SECRET, "k1");
  r.registerManual("9pQrStUvWx3y4z5A6b7C8d9E0f1", "k2");
  assert.equal(r.removeByLabel("k1"), true);
  assert.equal(r.size, 1);
  assert.equal(r.restore("[REDACTED:k1]").count, 0);
  r.clear();
  assert.equal(r.size, 0);
});

