// typo-search unit tests: node --test _shared/typo-search.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { osaDistance, typoThreshold, typoMatch } from "./typo-search.mjs";

const HAY = "service-tunnels 服务隧道 Service Tunnels 本机服务一键公网可达 @aiti-ai/aiti-service-tunnels";

test("osaDistance: transposition counts as 1 step (Damerau semantics; pure Levenshtein would say 2)", () => {
  assert.equal(osaDistance("servcie", "service"), 1);
  assert.equal(osaDistance("sevice", "service"), 1); // deleted r
  assert.equal(osaDistance("service", "service"), 0);
  assert.equal(osaDistance("abc", "yxa"), 3);
  assert.equal(osaDistance("", "ab"), 2);
});

test("typoThreshold: adaptive by length", () => {
  assert.equal(typoThreshold("abc"), 0); // <=3 disabled
  assert.equal(typoThreshold("sevice"), 1); // 4-7
  assert.equal(typoThreshold("service-tunnels"), 2); // 8+
});

test("typoMatch: user cases — servcie / sevice hit service-tunnels", () => {
  assert.equal(typoMatch("servcie", HAY), true);
  assert.equal(typoMatch("sevice", HAY), true);
  assert.equal(typoMatch("servie", HAY), true);
  assert.equal(typoMatch("servicetunnels", HAY), true); // distance 1 against the whole id (missing hyphen)
  // A fully mistyped compound query (with hyphen) hits against the whole-string token
  assert.equal(typoMatch("servcie-tunnels", HAY), true);
});

test("typoMatch: two-error missing chars — first-char anchored relaxation (sevic->service deletes r + trailing e)", () => {
  assert.equal(typoMatch("sevic", HAY), true);
  assert.equal(typoMatch("tunel", HAY), true); // tunnels missing n + missing s
  assert.equal(typoMatch("zzvic", HAY), false); // different first char: no relaxation (anti-false-positive)
  assert.equal(typoMatch("evics", HAY), false);
});

test("typoMatch: CJK typos", () => {
  // CJK fixtures stay Chinese on purpose: the tokenizer's CJK segment support is the behavior under test
  assert.equal(typoMatch("服务随道", HAY), true); // 1 error
  assert.equal(typoMatch("服物隧道", HAY), true); // 1 error
});

test("typoMatch: must-not-hit (anti-noise)", () => {
  assert.equal(typoMatch("zzzzzzz", HAY), false);
  assert.equal(typoMatch("npm", HAY), false); // <=3 chars: fuzzing disabled
  assert.equal(typoMatch("service tunnels", HAY), false); // multi-word query: disabled (includes is the caller's job)
  // Exact substring hits belong to the caller's includes layer; typoMatch itself carries no includes semantics
  assert.equal(typoMatch("aiti-service-tunnels", HAY), false);
  assert.equal(typoMatch("draft-keeper", HAY), false); // another extension's name must not hit
  // Query longer than the candidate token is not the dropped-character direction: no relaxation.
  // CJK fixtures stay Chinese on purpose (exercises the tokenizer's CJK segment handling).
  assert.equal(typoMatch("服务端口", "系统状态（服务器 CPU/内存）"), false);
  assert.equal(typoMatch("servcee", "service"), false); // same length + 2 edits: relaxation needs a longer token
});

test("typoMatch: edges (empty/non-string)", () => {
  assert.equal(typoMatch("", HAY), false);
  assert.equal(typoMatch("  sevice  ", HAY), true); // trim applies first
  assert.equal(typoMatch("sevice", ""), false);
  assert.equal(typoMatch(null, HAY), false);
});
