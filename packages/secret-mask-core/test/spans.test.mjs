// Generic span loop (hosts map their message shapes to these spans).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Registry } from "../src/mask.ts";
import { redactTextSpans, spanOf } from "../src/spans.ts";

const SECRET = "7fJk2mN9pQrStUvWx3y4z5A6b7C8d9E0";

test("redactTextSpans: autoRegister only on flagged spans; redact on all", () => {
  const r = new Registry();
  let ut = `please use api_key = "${SECRET}"`;
  let mt = `sure, using ${SECRET}`;
  const user = spanOf(() => ut, (t) => (ut = t));
  const model = spanOf(() => mt, (t) => (mt = t));
  const res = redactTextSpans([user, model], r, "s", { autoDetect: false });
  assert.equal(res.newEntries, 0, "no auto-detect when unflagged");
  let ut2 = `please use api_key = "${SECRET}"`;
  let mt2 = `sure, using ${SECRET}`;
  const r2 = new Registry();
  const user2 = spanOf(() => ut2, (t) => (ut2 = t));
  const model2 = spanOf(() => mt2, (t) => (mt2 = t));
  const res2 = redactTextSpans([user2, model2], r2, "s", { autoDetect: true });
  assert.ok(res2.newEntries >= 1, "user span mined");
  assert.ok(res2.changed);
  assert.ok(!ut2.includes(SECRET));
  assert.ok(!mt2.includes(SECRET), "registered value redacted everywhere");
});

test("redactTextSpans: empty spans skipped; second pass no-op", () => {
  const r = new Registry();
  let v = `token: "${SECRET}"`;
  const span = spanOf(() => v, (t) => (v = t));
  redactTextSpans([span], r, "s", { autoDetect: true });
  const snapshot = span.get();
  const res = redactTextSpans([span], r, "s", { autoDetect: true });
  assert.equal(res.changed, false);
  assert.equal(res.newEntries, 0);
  assert.equal(span.get(), snapshot);
});

test("spanOf set writes through", () => {
  let v = "a";
  const s = spanOf(() => v, (t) => (v = t));
  s.set("b");
  assert.equal(v, "b");
});
