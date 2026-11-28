// Unresolved-placeholder guard (G7).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Registry } from "../src/mask.ts";
import { unmountedPlaceholders, unmountedInValue, guardReason } from "../src/guard.ts";

const SECRET = "7fJk2mN9pQrStUvWx3y4z5A6b7C8d9E0";

test("mounted placeholders pass, unknown tokens are reported once", () => {
  const r = new Registry();
  const ph = r.registerManual(SECRET, "k").entry.placeholder;
  assert.deepEqual(unmountedPlaceholders(`ok ${ph}`, r), []);
  assert.deepEqual(unmountedPlaceholders("run rsec_deadbeef rsec_deadbeef now", r), ["rsec_deadbeef"]);
  // tokens embedded in words are not placeholders
  assert.deepEqual(unmountedPlaceholders("xrsec_deadbeef", r), []);
});

test("redirected (previous) placeholders count as mounted", () => {
  const r = new Registry();
  r.registerManual(SECRET, "one", { placeholder: "rsec_11111111" });
  r.registerManual(SECRET, "two", { placeholder: "rsec_22222222" });
  assert.deepEqual(unmountedPlaceholders("use rsec_11111111", r), []);
});

test("nested tool input walk", () => {
  const r = new Registry();
  const ph = r.registerManual(SECRET, "k").entry.placeholder;
  const input = { cmd: `curl -H "Authorization: Bearer ${ph}"`, env: { A: "rsec_00000000" }, list: ["fine", 7, true] };
  assert.deepEqual(unmountedInValue(input, r), ["rsec_00000000"]);
});

test("guard reason gives an actionable recovery path", () => {
  const reason = guardReason(["rsec_deadbeef"], { landing: "ephemeral" });
  assert.match(reason, /rsec_deadbeef/);
  assert.match(reason, /\/secret add/);
  const vaultReason = guardReason(["rsec_deadbeef"]);
  assert.match(vaultReason, /vault_get/);
  assert.match(vaultReason, /Do not retype/);
});
