/**
 * Host-side protocol version parsing/state unit tests (same matrix as the extension-side `_shared/ext-protocol.test.mjs`).
 * Run: npm test (full host suite) or node --experimental-strip-types --test lib/ext/protocol.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EXT_PROTOCOL_VERSION,
  EXT_PROTOCOL_MIN_MAJOR,
  EXT_PROTOCOL_STRICT_BLOCKED,
  parseExtProtocol,
  extProtocolInfo,
  extProtocolUpgradeRefs,
} from "./protocol.ts";

test("constants: current version and minimum supported major", () => {
  assert.equal(EXT_PROTOCOL_VERSION, "1.0");
  assert.equal(EXT_PROTOCOL_MIN_MAJOR, 1);
});

test("parseExtProtocol: valid / invalid (including number types)", () => {
  assert.deepEqual(parseExtProtocol("1.0"), { major: 1, minor: 0, raw: "1.0" });
  assert.deepEqual(parseExtProtocol(" 2.13 "), { major: 2, minor: 13, raw: "2.13" });
  assert.equal(parseExtProtocol(1.0), null);
  assert.equal(parseExtProtocol(1), null);
  assert.equal(parseExtProtocol("1"), null);
  assert.equal(parseExtProtocol("1.0.0"), null);
  assert.equal(parseExtProtocol("v1.0"), null);
  assert.equal(parseExtProtocol(null), null);
  assert.equal(parseExtProtocol(undefined), null);
});

test("extProtocolInfo: ok / minorAhead", () => {
  const ok = extProtocolInfo("1.0");
  assert.equal(ok.state, "ok");
  assert.equal(ok.needsUpgrade, false);
  assert.deepEqual(ok.upgradeRefs, []);
  const ahead = extProtocolInfo("1.2", { current: "1.0" });
  assert.equal(ahead.state, "ok");
  assert.equal(ahead.minorAhead, true);
});

test("extProtocolInfo: stale / incompatible / too_new", () => {
  const stale = extProtocolInfo("1.0", { current: "2.1", minMajor: 1 });
  assert.equal(stale.state, "stale");
  assert.equal(stale.needsUpgrade, true);
  assert.deepEqual(stale.upgradeRefs, ["v1-to-v2"]);

  const incompat = extProtocolInfo("1.0", { current: "3.0", minMajor: 2 });
  assert.equal(incompat.state, "incompatible");
  assert.deepEqual(incompat.upgradeRefs, ["v1-to-v2", "v2-to-v3"]);

  const tooNew = extProtocolInfo("2.0", { current: "1.0" });
  assert.equal(tooNew.state, "too_new");
  assert.equal(tooNew.needsUpgrade, false);
});

test("extProtocolInfo: missing / invalid", () => {
  const missing = extProtocolInfo(undefined);
  assert.equal(missing.state, "missing");
  assert.equal(missing.needsUpgrade, true);
  assert.deepEqual(missing.upgradeRefs, ["legacy-to-v1"]);
  const invalid = extProtocolInfo(1.0);
  assert.equal(invalid.state, "invalid");
  assert.equal(invalid.needsUpgrade, true);
});

test("extProtocolUpgradeRefs: hop-by-hop routing", () => {
  assert.deepEqual(extProtocolUpgradeRefs("1.0", { current: "1.0" }), []);
  assert.deepEqual(extProtocolUpgradeRefs("1.0", { current: "2.0" }), ["v1-to-v2"]);
  assert.deepEqual(extProtocolUpgradeRefs("1.0", { current: "3.2" }), ["v1-to-v2", "v2-to-v3"]);
  assert.deepEqual(extProtocolUpgradeRefs(undefined, { current: "1.0" }), ["legacy-to-v1"]);
  // 0.x (pre-versioning lineage) routes like missing: legacy manual first
  assert.deepEqual(extProtocolUpgradeRefs("0.9", { current: "1.0" }), ["legacy-to-v1"]);
  assert.deepEqual(extProtocolUpgradeRefs("0.9", { current: "2.0" }), ["legacy-to-v1", "v1-to-v2"]);
  assert.equal(extProtocolInfo("0.9").state, "incompatible");
});

test("strict blocked set: does not include stale", () => {
  assert.deepEqual(EXT_PROTOCOL_STRICT_BLOCKED, ["incompatible", "missing", "invalid", "too_new"]);
  assert.ok(!EXT_PROTOCOL_STRICT_BLOCKED.includes("stale"));
});
